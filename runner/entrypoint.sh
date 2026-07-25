#!/usr/bin/env bash
# Apex Load Test Runner — entrypoint stub (FEAT-002)
#
# This is a STUB for the Container Apps Job entrypoint.
# Full implementation is FEAT-008 (containerAppsJobRunner).
#
# Contract (will be fulfilled by FEAT-008):
#   Environment variables (set by Container Apps Job template):
#     AZURE_CLIENT_ID          — Runner user-assigned MI client ID
#     APEX_CALLBACK_URL        — Base URL for progress/completion callbacks
#     LT_SERVICEBUS_NAMESPACE  — Service Bus namespace name
#     LT_QUEUE_NAME            — Dispatch queue name
#     LT_BLOB_ACCOUNT_NAME     — Shared storage account name
#     LT_BLOB_CONTAINER_NAME   — Load-test artifacts container
#
#   Trigger via KEDA: one execution per queued dispatch message.
#   The dispatch message payload (set by FEAT-007) carries:
#     { runId, script, loadProfile, secretRefs, callbackToken }
#
# Stub behavior:
#   - Logs startup environment for smoke-test verification.
#   - Confirms identity is available via Azure IMDS token request.
#   - Exits 0 (success) so the KEDA scaler treats this as a clean run.
#   - Does NOT execute real k6 load; full wiring is FEAT-008.

set -euo pipefail

log() {
  echo "[apex-lt-runner] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

log "Starting Apex load-test runner stub (FEAT-002)"
log "Env: APEX_CALLBACK_URL=${APEX_CALLBACK_URL:-<unset>}"
log "Env: LT_SERVICEBUS_NAMESPACE=${LT_SERVICEBUS_NAMESPACE:-<unset>}"
log "Env: LT_QUEUE_NAME=${LT_QUEUE_NAME:-<unset>}"
log "Env: LT_BLOB_ACCOUNT_NAME=${LT_BLOB_ACCOUNT_NAME:-<unset>}"
log "Env: LT_BLOB_CONTAINER_NAME=${LT_BLOB_CONTAINER_NAME:-<unset>}"
log "Env: AZURE_CLIENT_ID=${AZURE_CLIENT_ID:-<unset>}"

# Verify managed identity is reachable (IMDS token request).
# Fails closed if the runner MI RBAC is not correctly assigned (PBI-002 error AC).
log "Requesting managed-identity token from IMDS..."
TOKEN_RESPONSE=$(curl -s -f \
  --connect-timeout 10 \
  -H "Metadata: true" \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fservicebus.azure.com%2F&client_id=${AZURE_CLIENT_ID:-}" \
  2>&1) || {
  log "ERROR: IMDS token request failed — runner MI may not be assigned or RBAC is missing"
  log "Response: ${TOKEN_RESPONSE}"
  exit 1
}

# Confirm token was returned (non-empty access_token field).
ACCESS_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.access_token // empty')
if [[ -z "${ACCESS_TOKEN}" ]]; then
  log "ERROR: IMDS returned no access_token — check runner MI client ID and RBAC assignments"
  exit 1
fi

log "Managed identity token obtained successfully (Service Bus scope)"
log "Runner identity verified — infrastructure checks PASSED"

# ---------------------------------------------------------------------------
# FEAT-008 wires the full k6 execution here:
#   1. Receive dispatch message from lt-dispatch queue (Service Bus REST + MI token)
#   2. Resolve Key Vault secret refs into k6 env vars
#   3. Write script payload to /apex/scripts/test.js
#   4. Execute: k6 run /apex/scripts/test.js
#   5. Upload summary/timeseries to lt-artifacts Blob (MI token, Storage scope)
#   6. POST completion callback to APEX_CALLBACK_URL with threshold results + blob refs
# ---------------------------------------------------------------------------

log "Stub complete — full k6 execution wiring is FEAT-008"
exit 0
