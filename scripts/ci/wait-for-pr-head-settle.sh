#!/usr/bin/env bash
# Hold expensive PR jobs until the Cursor bot's own check finishes on this SHA.
#
# Cursor agents push several commits in a row, and each push retriggers the
# pull_request workflows. This script is the cheap front door: when the push
# came from a Cursor identity, poll the check runs owned by the Cursor GitHub
# App (the "Cursor Bugbot" check) on this run's SHA and wait for it to reach
# completed. If the PR head moves while we wait, this run is stale and the
# later jobs skip, because the newer run owns CI.
#
# Writes proceed=true|false to GITHUB_OUTPUT.
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${ACTOR:=}"
: "${EVENT_NAME:=}"
: "${EVENT_ACTION:=}"
: "${PR_NUMBER:=}"
: "${TRIGGER_SHA:=}"
: "${REPO:=}"
# App that owns the gating check. Filtering on the app rather than the check
# name survives Cursor renaming "Cursor Bugbot".
: "${CURSOR_APP_SLUG:=cursor}"
: "${POLL_SECONDS:=15}"
# How long to wait for the Cursor check to be created before assuming it will
# not run on this PR at all.
: "${CHECK_GRACE_SECONDS:=180}"
: "${MAX_WAIT_SECONDS:=1800}"

proceed() {
  echo "proceed=$1" >> "${GITHUB_OUTPUT}"
  echo "proceed=$1"
}

is_cursor_identity() {
  case "$1" in
    'cursor[bot]'|'cursoragent[bot]'|'cursoragent') return 0 ;;
  esac
  return 1
}

# The workflow actor is cursor[bot] for bot pushes, but a rerun can attribute
# the run to a human while the head commit is still the bot's. Check both.
pushed_by_cursor() {
  if is_cursor_identity "${ACTOR}"; then
    echo "Actor ${ACTOR} is a Cursor identity."
    return 0
  fi
  local author committer
  author="$(gh api "repos/${REPO}/commits/${TRIGGER_SHA}" --jq '.author.login // ""' 2>/dev/null || true)"
  committer="$(gh api "repos/${REPO}/commits/${TRIGGER_SHA}" --jq '.committer.login // ""' 2>/dev/null || true)"
  if is_cursor_identity "${author}" || is_cursor_identity "${committer}"; then
    echo "Head commit authored by ${author:-unknown}/${committer:-unknown} (Cursor)."
    return 0
  fi
  return 1
}

if [[ "${EVENT_NAME}" == 'workflow_dispatch' ]]; then
  echo "Manual dispatch — no Cursor check to wait for."
  proceed true
  exit 0
fi

case "${EVENT_ACTION}" in
  synchronize|opened|reopened) ;;
  *)
    echo "Event ${EVENT_NAME}/${EVENT_ACTION} is not a push — no wait."
    proceed true
    exit 0
    ;;
esac

if [[ -z "${PR_NUMBER}" || -z "${TRIGGER_SHA}" || -z "${REPO}" ]]; then
  echo "Missing PR_NUMBER, TRIGGER_SHA, or REPO; proceeding without wait."
  proceed true
  exit 0
fi

if ! pushed_by_cursor; then
  echo "Human push (actor=${ACTOR}) — starting CI immediately."
  proceed true
  exit 0
fi

echo "Waiting for the Cursor app (${CURSOR_APP_SLUG}) check to complete on ${TRIGGER_SHA}."

elapsed=0
while (( elapsed < MAX_WAIT_SECONDS )); do
  head_sha="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq .head.sha)"
  if [[ "${head_sha}" != "${TRIGGER_SHA}" ]]; then
    echo "PR head moved to ${head_sha}; this run is stale and yields to the newer run."
    proceed false
    exit 0
  fi

  checks="$(gh api "repos/${REPO}/commits/${TRIGGER_SHA}/check-runs?per_page=100" \
    --jq ".check_runs[] | select(.app.slug == \"${CURSOR_APP_SLUG}\") | \"\(.name)=\(.status)/\(.conclusion // \"-\")\"" || true)"

  if [[ -n "${checks}" ]]; then
    echo "Cursor checks: ${checks//$'\n'/, }"
    if ! grep -qv 'completed/' <<< "${checks}"; then
      echo "Cursor check complete. Starting CI."
      proceed true
      exit 0
    fi
  elif (( elapsed >= CHECK_GRACE_SECONDS )); then
    echo "No Cursor check appeared within ${CHECK_GRACE_SECONDS}s; not gating on it."
    proceed true
    exit 0
  else
    echo "Cursor check not created yet (${elapsed}s / ${CHECK_GRACE_SECONDS}s grace)."
  fi

  sleep "${POLL_SECONDS}"
  elapsed=$((elapsed + POLL_SECONDS))
done

echo "Reached ${MAX_WAIT_SECONDS}s without a completed Cursor check; starting CI anyway."
proceed true
