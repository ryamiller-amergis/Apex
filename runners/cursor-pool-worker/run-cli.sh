#!/usr/bin/env bash
# One cloud-agent run inside the container. Clones with ADO_PAT, runs the
# Cursor CLI, pushes the branch, then opens the pull request as the developer
# who started the run (ADO_USER_TOKEN). Does not call the Cloud Agents API.
set -euo pipefail

: "${CURSOR_API_KEY:?CURSOR_API_KEY is required}"
: "${ADO_PAT:?ADO_PAT is required}"
: "${REPO_URL:?REPO_URL is required}"
: "${AGENT_BASE_BRANCH:?AGENT_BASE_BRANCH is required}"
: "${AGENT_BRANCH:?AGENT_BRANCH is required}"
: "${AGENT_MODEL:?AGENT_MODEL is required}"

# Apex writes the prompt to a private blob and passes only the URL. The
# container environment cannot hold the full prompt.
if [ -n "${AGENT_PROMPT_BLOB_URL:-}" ]; then
  case "${AGENT_PROMPT_BLOB_URL}" in
    https://*.blob.core.windows.net/*) ;;
    *) echo "AGENT_PROMPT_BLOB_URL must be an Azure Blob URL" >&2; exit 1 ;;
  esac
  : "${IDENTITY_ENDPOINT:?IDENTITY_ENDPOINT is required to read the prompt blob}"
  : "${IDENTITY_HEADER:?IDENTITY_HEADER is required to read the prompt blob}"
  : "${AZURE_CLIENT_ID:?AZURE_CLIENT_ID is required to read the prompt blob}"
  token_json="$(curl -fsS \
    "${IDENTITY_ENDPOINT}?resource=https://storage.azure.com/&api-version=2019-08-01&client_id=${AZURE_CLIENT_ID}" \
    -H "X-IDENTITY-HEADER: ${IDENTITY_HEADER}")"
  token="$(printf '%s' "${token_json}" | jq -r '.access_token // empty')"
  if [ -z "${token}" ]; then
    echo "Could not get a blob token for the cloud-agent prompt" >&2
    exit 1
  fi
  AGENT_PROMPT="$(curl -fsS \
    -H "Authorization: Bearer ${token}" \
    -H "x-ms-version: 2023-11-03" \
    "${AGENT_PROMPT_BLOB_URL}")"
  unset token token_json
fi
: "${AGENT_PROMPT:?AGENT_PROMPT is required}"

git config --global --add safe.directory '*'
git config --global credential.helper /usr/local/bin/cursor-git-credential
git config --global credential.useHttpPath true
# Commit author is the developer who started the run. The service account
# only authenticates the push.
git config --global user.email "${AGENT_AUTHOR_EMAIL:-apex-cloud-agent@local}"
git config --global user.name "${AGENT_AUTHOR_NAME:-Apex Cloud Agent}"

emit_activity() {
  printf 'APEX_ACTIVITY %s\n' "$(jq -nc \
    --arg id "$1" \
    --arg kind "$2" \
    --arg title "$3" \
    --arg detail "${4:-}" \
    --arg status "${5:-}" \
    '{id:$id,kind:$kind,title:$title}
      + (if $detail != "" then {detail:$detail} else {} end)
      + (if $status != "" then {status:$status} else {} end)')"
}

dest="/workspace/repo"
rm -rf "${dest}"
emit_activity "clone:start" "status" "Cloning repository" "${REPO_URL}" "running"
# Quiet: progress lines would push activity out of the 300-line log tail Apex reads.
git clone --quiet "${REPO_URL}" "${dest}"
emit_activity "clone:done" "status" "Repository cloned" "" "completed"
cd "${dest}"
git checkout -B "${AGENT_BRANCH}" "origin/${AGENT_BASE_BRANCH}"
emit_activity "branch" "status" "On branch ${AGENT_BRANCH}" "Based on ${AGENT_BASE_BRANCH}" "completed"

example_src="/usr/local/share/apex/pr-description.md"
example_copy="${dest}/.apex-pr-description.example.md"
written_copy="${dest}/.apex-pr-description.md"
pr_hint=""
if [ -f "${example_src}" ]; then
  cp "${example_src}" "${example_copy}"
  pr_hint="
Read .apex-pr-description.example.md in the repo root. It is a filled example. Notes under each heading say what that section is for. Write this change's description to .apex-pr-description.md using the same headings. Do not copy the sample text or the notes. Do not commit either file. The container deletes them and sends .apex-pr-description.md as the pull request description."
fi

summary_file="$(mktemp)"
skill_prefix=""
if [[ "${AGENT_SKILL:-}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  emit_activity "skill" "status" "Using /${AGENT_SKILL}" "" "completed"
  case "${AGENT_PROMPT}" in
    "/${AGENT_SKILL}"*) ;;
    *) skill_prefix="/${AGENT_SKILL}"$'\n\n' ;;
  esac
fi
emit_activity "agent" "status" "Agent running" "" "running"
# A non-zero CLI exit must not skip publishing: files the agent already wrote
# exist only in this checkout. The exit marker is printed after publish, and
# the process exits 0 so the job's retry does not run the agent again.
agent_exit=0
agent -p \
  --workspace "${dest}" \
  --trust \
  --approve-mcps \
  --output-format stream-json \
  --model "${AGENT_MODEL}" \
  "${skill_prefix}${AGENT_PROMPT}
${pr_hint}
Do not commit, push, or open a pull request. The container pushes the branch and opens the pull request after you finish." \
  | node /usr/local/bin/cursor-activity-log "${summary_file}" || agent_exit=$?
if [ "${agent_exit}" -ne 0 ]; then
  emit_activity "agent:exit" "status" "Agent exited with code ${agent_exit}" "Publishing any changes it made" "failed"
fi

# Set only after git push succeeds. finish_run prints the branch with the CLI
# exit and the settled line, so a poll cannot treat the push as success first.
branch_pushed=0
summary_line=""

finish_run() {
  if [ "${agent_exit}" -ne 0 ]; then
    echo "APEX_AGENT_EXIT=${agent_exit}"
  fi
  if [ "${branch_pushed}" -eq 1 ]; then
    echo "APEX_BRANCH_PUSHED=${AGENT_BRANCH}"
    echo "APEX_BASE_BRANCH=${AGENT_BASE_BRANCH}"
    echo "APEX_SUMMARY=${summary_line}"
  fi
  # Printed last. Apex waits for this before it treats the run as finished,
  # so a poll cannot record success in the gap before APEX_AGENT_EXIT.
  echo "APEX_RUN_SETTLED"
  # Job logs disappear with the replica. Stay up long enough for Apex to read them.
  sleep 120
  exit 0
}

pr_description=""
if [ -s "${written_copy}" ]; then
  pr_description="$(head -c 4000 "${written_copy}")"
fi
rm -f "${example_copy}" "${written_copy}"

if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "APEX_RESULT no file changes"
  rm -f "${summary_file}"
  finish_run
fi

commit_title="${AGENT_WORK_ITEM_TITLE:-${AGENT_BRANCH}}"
if [ -n "${AGENT_WORK_ITEM_ID:-}" ]; then
  commit_title="AB#${AGENT_WORK_ITEM_ID}: ${commit_title}"
fi
emit_activity "publish:start" "status" "Committing and pushing" "${AGENT_BRANCH}" "running"
git add -A
commit_file="$(mktemp)"
printf '%s\n' "${commit_title}" > "${commit_file}"
git commit -F "${commit_file}"
rm -f "${commit_file}"
git push -u origin "${AGENT_BRANCH}"
emit_activity "publish:done" "status" "Pushed ${AGENT_BRANCH}" "" "completed"

summary_line="$(tr '\n' ' ' < "${summary_file}" | tr -d '"\\' | cut -c1-1500)"
rm -f "${summary_file}"
branch_pushed=1
# Any failure after the push settles the run and exits 0. A non-zero exit
# would make Azure retry the replica and run the agent again. The branch
# markers are printed inside finish_run, after the CLI exit.
trap finish_run ERR

pr_title="${AGENT_BRANCH}"
if [ -n "${AGENT_WORK_ITEM_ID:-}" ]; then
  pr_title="AB#${AGENT_WORK_ITEM_ID}: ${AGENT_WORK_ITEM_TITLE:-${AGENT_BRANCH}}"
fi
started_by=""
if [ -n "${AGENT_AUTHOR_NAME:-}" ]; then
  started_by="Started by: ${AGENT_AUTHOR_NAME}"
  if [ -n "${AGENT_AUTHOR_EMAIL:-}" ]; then
    started_by="${started_by} (${AGENT_AUTHOR_EMAIL})"
  fi
fi
if [ -n "${pr_description}" ]; then
  description="${pr_description}"
else
  description="Automated implementation via Apex cloud development.

Work item: AB#${AGENT_WORK_ITEM_ID:-unknown}${AGENT_WORK_ITEM_TITLE:+ — ${AGENT_WORK_ITEM_TITLE}}
Branch: ${AGENT_BRANCH}
${started_by}

## Implementation summary

${summary_line}"
fi

url="${REPO_URL%.git}"
url="${url#https://dev.azure.com/}"
org="${url%%/*}"
rest="${url#*/}"
project="${rest%%/*}"
repo="${url##*/}"
body="$(jq -n \
  --arg source "refs/heads/${AGENT_BRANCH}" \
  --arg target "refs/heads/${AGENT_BASE_BRANCH}" \
  --arg title "${pr_title}" \
  --arg description "${description}" \
  --arg workItemId "${AGENT_WORK_ITEM_ID:-}" \
  '{sourceRefName:$source,targetRefName:$target,title:$title,description:$description}
    + (if $workItemId != "" then {workItemRefs:[{id:$workItemId}]} else {} end)')"

emit_activity "pr:start" "status" "Opening pull request" "${pr_title}" "running"
if [ -n "${ADO_USER_TOKEN:-}" ]; then
  auth_header="Authorization: Bearer ${ADO_USER_TOKEN}"
else
  echo "APEX_ACTIVITY {\"id\":\"pr:auth\",\"kind\":\"status\",\"title\":\"No developer token\",\"detail\":\"Opening the pull request as the service account\",\"status\":\"running\"}"
  auth_header="Authorization: Basic $(printf ':%s' "${ADO_PAT}" | base64 -w 0)"
fi
# The branch is already on the remote. A failed pull-request call must not
# exit non-zero: Azure would retry the replica and run the agent again.
# finish_run prints the CLI exit and APEX_RUN_SETTLED, then exits 0.
pr_exit=0
pr="$(curl -fsS \
  -H "${auth_header}" \
  -H "Content-Type: application/json" \
  -d "${body}" \
  "https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=7.1")" || pr_exit=$?
pr_id=""
if [ "${pr_exit}" -eq 0 ]; then
  pr_id="$(printf '%s' "${pr}" | jq -r '.pullRequestId // empty' || true)"
fi
if [ "${pr_exit}" -ne 0 ] || [ -z "${pr_id}" ]; then
  emit_activity "pr:failed" "status" "Could not open the pull request" "Branch ${AGENT_BRANCH} was pushed" "failed"
  finish_run
fi
pr_url="https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequest/${pr_id}"
emit_activity "pr:done" "status" "Pull request opened" "${pr_url}" "completed"
echo "APEX_PR_URL=${pr_url}"
finish_run
