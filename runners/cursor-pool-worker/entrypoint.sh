#!/usr/bin/env bash
# Clone REPO_URL with ADO_PAT, then start a Cursor Team Pool worker.
# Extra remotes: space- or comma-separate them in REPO_URL (first dir is identity).
set -euo pipefail

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "CURSOR_API_KEY must be set to a Cursor team service-account API key." >&2
  exit 1
fi

if [[ -z "${ADO_PAT:-}" ]]; then
  echo "ADO_PAT is required to clone Azure DevOps remotes." >&2
  exit 1
fi

if [[ -z "${REPO_URL:-}" ]]; then
  echo "REPO_URL must be the Azure DevOps git URL this worker should serve." >&2
  exit 1
fi

mkdir -p /workspace
git config --global --add safe.directory '*'
git config --global credential.helper /usr/local/bin/cursor-git-credential
git config --global credential.useHttpPath true

repo_name() {
  local url="${1%%#*}"
  url="${url%/}"
  url="${url%.git}"
  printf '%s' "${url##*/}"
}

WORKER_DIRS=()
urls="${REPO_URL//,/ }"
# shellcheck disable=SC2086
for url in ${urls}; do
  dest="/workspace/$(repo_name "${url}")"
  if [[ -d "${dest}/.git" ]]; then
    git -C "${dest}" fetch --prune origin
  else
    rm -rf "${dest}"
    git clone --progress "${url}" "${dest}"
  fi
  WORKER_DIRS+=("${dest}")
done

cd "${WORKER_DIRS[0]}"

args=(worker --pool)
for dir in "${WORKER_DIRS[@]}"; do
  args+=(--worker-dir "${dir}")
done
args+=(--management-addr :8080 start)

exec agent "${args[@]}"
