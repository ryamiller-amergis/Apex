#!/usr/bin/env bash
# Live DEV signals while testing ai-runs-v2-transport + V2 orchestrator.
# Run from repo root:
#   ./scripts/dev/watch-v2-dev-routing.sh [orchestrator|app|fast|agentic|legacy|insights|all]
#
# V2 expected: interactive.route.decision route=durable, dapr-actor-v2, orchestrator outbox/dispatch
# Legacy warning: route=legacy, http-files-v1, in-process fail-closed chat send, background job dispatch

set -euo pipefail
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SUB="${AZURE_SUBSCRIPTION_ID:-9d08693d-0c89-4f11-aa43-6cbdb89cf1cb}"
RG="${AI_RUNS_RESOURCE_GROUP:-rg-scrum-dev}"
MODE="${1:-all}"

az account set --subscription "$SUB" >/dev/null

watch_orchestrator() {
  echo "=== [orchestrator] ca-apex-ai-orchestrator-dev (V2 outbox / dispatch) ==="
  az containerapp logs show -g "$RG" -n ca-apex-ai-orchestrator-dev --follow --tail 30 2>&1 \
    | grep --line-buffered -E 'aiOrchestrator|orchestrator\.|outbox|interactive|dispatch|checkpoint|result|fatal|ERROR' \
    || true
}

watch_app() {
  echo "=== [app] app-scrum-dev (route durable vs legacy) ==="
  az webapp log tail -g "$RG" -n app-scrum-dev 2>&1 \
    | grep --line-buffered -iE 'interactive\.route|route\.decision|durable|legacy|v2-transport|dapr-actor-v2|http-files-v1|sendChat|admitDurable|fail-closed|AI_RUNS_INTERACTIVE' \
    || true
}

watch_actor_host() {
  local app_name="$1"
  local label="$2"
  echo "=== [${label}] ${app_name} (/dispatch actor) ==="
  az containerapp logs show -g "$RG" -n "$app_name" --follow --tail 20 2>&1 \
    | grep --line-buffered -iE 'dispatch|actor|interactive|error|fatal|thread' \
    || true
}

watch_insights_loop() {
  echo "=== [insights] App Insights every 45s (interactive.route.decision) ==="
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  while true; do
    echo "--- $(date -u +%H:%M:%S)Z ---"
    python "$ROOT/.cursor/skills/interactive-chat-troubleshoot/scripts/query_insights.py" \
      --env dev --hours 0.25 2>/dev/null \
      | grep -E 'interactive\.route|route|durable|legacy|===|none' || true
    sleep 45
  done
}

case "$MODE" in
  orchestrator) watch_orchestrator ;;
  app) watch_app ;;
  fast) watch_actor_host ca-apex-ai-fast-interactive-dev fast ;;
  agentic) watch_actor_host ca-apex-ai-agentic-dev agentic ;;
  legacy) watch_actor_host ca-apex-ai-interactive-dev legacy ;;
  insights) watch_insights_loop ;;
  all)
    trap 'jobs -pr | xargs -r kill' EXIT INT TERM
    watch_orchestrator &
    watch_app &
    watch_actor_host ca-apex-ai-fast-interactive-dev fast &
    watch_actor_host ca-apex-ai-agentic-dev agentic &
    wait
    ;;
  *)
    echo "Usage: $0 [orchestrator|app|fast|agentic|legacy|insights|all]"
    exit 1
    ;;
esac
