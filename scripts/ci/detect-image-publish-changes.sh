#!/usr/bin/env bash
# Detect whether runner/image sources changed between BASE_SHA and HEAD_SHA.
# Writes GitHub Actions outputs:
#   load_test_runner, ai_runs_worker, ai_runs_interactive  (true|false)
#
# Required env:
#   BASE_SHA
#   HEAD_SHA
#   GITHUB_OUTPUT

set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

detect() {
  local name="$1"
  shift
  if git diff --quiet "$BASE_SHA" "$HEAD_SHA" -- "$@"; then
    echo "${name}=false" >> "$GITHUB_OUTPUT"
    echo "${name}: unchanged"
  else
    echo "${name}=true" >> "$GITHUB_OUTPUT"
    echo "${name}: changed"
    git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "$@" || true
  fi
}

detect load_test_runner \
  runners/load-test-k6/ \
  scripts/ci/publish-lt-k6-runner.sh \
  src/server/services/loadTestRunner/ \
  src/shared/types/loadTest.ts

detect ai_runs_worker \
  runners/ai-runs/ \
  scripts/ci/publish-ai-runs-runner.sh \
  src/server/services/aiRunsWorker/

detect ai_runs_interactive \
  runners/ai-runs-interactive/ \
  scripts/ci/publish-ai-runs-interactive.sh \
  src/server/services/interactiveActorHost/
