#!/usr/bin/env bash
# Wire DEV (MSS-DevTest) for V2 smoke tests: App Service settings, RBAC, images, Container Apps.
#
# Prerequisites:
#   - az login, Contributor + role assignment rights on rg-scrum-dev (or have Ryan run RBAC steps)
#   - npm run build:server (dist/ for Docker/ACR)
#   - Either Docker Desktop OR use ACR cloud build (this script uses az acr build)
#
# Usage (from repo root):
#   export AZURE_SUBSCRIPTION_ID=9d08693d-0c89-4f11-aa43-6cbdb89cf1cb
#   ./scripts/dev/complete-v2-dev-setup.sh
#
# After success: Platform Admin → Feature Flags → enable ai-runs-v2-transport for your user/project.

set -euo pipefail

# Git Bash on Windows mangles ARM resource IDs that start with /subscriptions.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

terraform_output_or_default() {
  local output_name="$1"
  local fallback="$2"
  local value
  value="$(terraform -chdir="$ROOT/infra" output -raw "$output_name" 2>/dev/null || true)"
  if [[ -n "$value" && "$value" != "null" ]]; then
    echo "$value"
  else
    echo "$fallback"
  fi
}

SUB="${AZURE_SUBSCRIPTION_ID:-9d08693d-0c89-4f11-aa43-6cbdb89cf1cb}"
RG="${AI_RUNS_RESOURCE_GROUP:-rg-scrum-dev}"
APP="${APEX_APP_SERVICE_NAME:-app-scrum-dev}"
ACR="${AI_RUNS_ACR_NAME:-acrapexltdev}"
ACR_RG="${AI_RUNS_ACR_RESOURCE_GROUP:-rg-scrum-dev}"
CAE="${AI_RUNS_CONTAINER_APP_ENV:-cae-apex-ai-dev}"
SB_NS="${AI_RUNS_SERVICEBUS_NAMESPACE:-sbns-apex-ai-dev}"
STORAGE="${AI_PLATFORM_V2_STORAGE_ACCOUNT:-stapexdevasync}"
ARTIFACT_CONTAINER="${AI_PLATFORM_V2_ARTIFACT_CONTAINER:-ai-run-artifacts}"
FAST_APP="${AI_PLATFORM_V2_FAST_INTERACTIVE_CONTAINER_APP_NAME:-$(terraform_output_or_default ai_platform_v2_fast_interactive_container_app_name ca-apex-ai-fast-interactive-dev)}"
AGENTIC_APP="${AI_PLATFORM_V2_AGENTIC_CONTAINER_APP_NAME:-$(terraform_output_or_default ai_platform_v2_agentic_container_app_name ca-apex-ai-agentic-dev)}"
ORCH_APP="${AI_ORCHESTRATOR_CONTAINER_APP_NAME:-$(terraform_output_or_default ai_platform_v2_orchestrator_container_app_name ca-apex-ai-orchestrator-dev)}"
DOC_APP="${AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME:-$(terraform_output_or_default ai_platform_v2_documents_container_app_name ca-apex-ai-runs-documents-v2-dev)}"
ORCH_MI="${AI_ORCHESTRATOR_IDENTITY_NAME:-mi-apex-ai-v2-orchestrator-dev}"
DOC_MI="${AI_DOCUMENTS_V2_IDENTITY_NAME:-mi-apex-ai-v2-document-dev}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "Using subscription ${SUB}, RG ${RG}, app ${APP}"

az account set --subscription "$SUB"

if [[ ! -f dist/server/services/aiOrchestrator/entrypoint.js ]]; then
  echo "Building server (npm run build:server)..."
  npm run build:server
fi

resolve_dispatch_url() {
  local app_name="$1"
  if ! az containerapp show -g "$RG" -n "$app_name" &>/dev/null; then
    echo ""
    return
  fi
  local fqdn
  fqdn="$(az containerapp show -g "$RG" -n "$app_name" --query properties.configuration.ingress.fqdn -o tsv 2>/dev/null || true)"
  if [[ -z "$fqdn" ]]; then
    echo ""
    return
  fi
  echo "https://${fqdn}"
}

FAST_DISPATCH="$(resolve_dispatch_url "$FAST_APP")"
AGENTIC_DISPATCH="$(resolve_dispatch_url "$AGENTIC_APP")"
if [[ -z "$FAST_DISPATCH" || -z "$AGENTIC_DISPATCH" ]]; then
  echo "FAIL: split interactive Container Apps ${FAST_APP} and ${AGENTIC_APP} must exist."
  echo "Apply Terraform (enable_ai_platform_v2 + enable_ai_platform_v2_runtime + enable_ai_runs_interactive) first."
  exit 1
fi

echo "Setting V2 App Service settings on ${APP}..."
az webapp config appsettings set -g "$RG" -n "$APP" --settings \
  "AI_PLATFORM_V2_SERVICEBUS_NAMESPACE=${SB_NS}" \
  "AI_PLATFORM_V2_BLOB_ACCOUNT_NAME=${STORAGE}" \
  "AI_PLATFORM_V2_ARTIFACT_CONTAINER=${ARTIFACT_CONTAINER}" \
  >/dev/null

APP_PID="$(az webapp identity show -g "$RG" -n "$APP" --query principalId -o tsv)"
STORAGE_ID="$(az storage account show -g "$RG" -n "$STORAGE" --query id -o tsv)"
CONTAINER_SCOPE="${STORAGE_ID}/blobServices/default/containers/${ARTIFACT_CONTAINER}"

echo "Ensuring App Service blob access on ${ARTIFACT_CONTAINER}..."
if ! az role assignment list --scope "$CONTAINER_SCOPE" --assignee "$APP_PID" --query "[?roleDefinitionName=='Storage Blob Data Contributor']" -o tsv 2>/dev/null | grep -q .; then
  az role assignment create \
    --role "Storage Blob Data Contributor" \
    --assignee-object-id "$APP_PID" \
    --assignee-principal-type ServicePrincipal \
    --scope "$CONTAINER_SCOPE" \
    >/dev/null
fi

ORCH_PID="$(az identity show -g "$RG" -n "$ORCH_MI" --query principalId -o tsv)"
DOC_PID="$(az identity show -g "$RG" -n "$DOC_MI" --query principalId -o tsv)"
ACR_ID="$(az acr show -n "$ACR" --query id -o tsv)"

ensure_acr_pull() {
  local pid="$1"
  local label="$2"
  if az role assignment list --scope "$ACR_ID" --assignee "$pid" --query "[?roleDefinitionName=='AcrPull']" -o tsv 2>/dev/null | grep -q .; then
    echo "AcrPull already granted for ${label}"
    return
  fi
  echo "Granting AcrPull for ${label}..."
  az role assignment create \
    --role AcrPull \
    --assignee-object-id "$pid" \
    --assignee-principal-type ServicePrincipal \
    --scope "$ACR_ID" \
    >/dev/null
}

ensure_acr_pull "$ORCH_PID" "$ORCH_MI"
ensure_acr_pull "$DOC_PID" "$DOC_MI"

LOGIN_SERVER="$(az acr show -n "$ACR" --query loginServer -o tsv)"
ORCH_IMAGE="${LOGIN_SERVER}/apex-ai-orchestrator:${IMAGE_TAG}"
DOC_IMAGE="${LOGIN_SERVER}/apex-ai-runs-documents-v2:${IMAGE_TAG}"
INTERACTIVE_IMAGE="${LOGIN_SERVER}/apex-ai-runs-interactive:${IMAGE_TAG}"

echo "Building and pushing images via ACR (no local Docker required)..."
az acr build -r "$ACR" -t "apex-ai-orchestrator:${IMAGE_TAG}" -f runners/ai-orchestrator/Dockerfile . >/dev/null
az acr build -r "$ACR" -t "apex-ai-runs-documents-v2:${IMAGE_TAG}" -f runners/ai-runs-documents-v2/Dockerfile . >/dev/null
az acr build -r "$ACR" -t "apex-ai-runs-interactive:${IMAGE_TAG}" -f runners/ai-runs-interactive/Dockerfile . >/dev/null

DATABASE_URL="$(az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='DATABASE_URL'].value" -o tsv)"
if [[ -z "$DATABASE_URL" ]]; then
  echo "FAIL: DATABASE_URL not found on ${APP}"
  exit 1
fi

ORCH_MI_ID="$(az identity show -g "$RG" -n "$ORCH_MI" --query id -o tsv)"
ORCH_CLIENT="$(az identity show -g "$RG" -n "$ORCH_MI" --query clientId -o tsv)"
DOC_MI_ID="$(az identity show -g "$RG" -n "$DOC_MI" --query id -o tsv)"
DOC_CLIENT="$(az identity show -g "$RG" -n "$DOC_MI" --query clientId -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"

create_or_update_orchestrator() {
  if az containerapp show -g "$RG" -n "$ORCH_APP" &>/dev/null; then
    echo "Updating orchestrator Container App ${ORCH_APP}..."
    az containerapp update -g "$RG" -n "$ORCH_APP" \
      --image "$ORCH_IMAGE" \
      --set-env-vars \
        "AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL=${FAST_DISPATCH}" \
        "AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL=${AGENTIC_DISPATCH}" \
        "AI_ORCHESTRATOR_INTERACTIVE_CAP=4" \
        "AI_ORCHESTRATOR_LANE_FLOOR_FAST=1" \
        "AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC=1" \
      >/dev/null
    return
  fi

  echo "Creating orchestrator Container App ${ORCH_APP}..."
  az containerapp create \
    -g "$RG" \
    -n "$ORCH_APP" \
    --environment "$CAE" \
    --system-assigned \
    --user-assigned "$ORCH_MI_ID" \
    --registry-server "$LOGIN_SERVER" \
    --registry-identity system \
    --image "$ORCH_IMAGE" \
    --min-replicas 1 \
    --max-replicas 2 \
    --cpu 0.5 \
    --memory 1Gi \
    --secrets "database-url=${DATABASE_URL}" \
    --env-vars \
      "NODE_ENV=production" \
      "AI_ORCHESTRATOR_ENABLED=true" \
      "AZURE_CLIENT_ID=${ORCH_CLIENT}" \
      "AZURE_TENANT_ID=${TENANT}" \
      "DATABASE_URL=secretref:database-url" \
      "AI_PLATFORM_V2_SERVICEBUS_NAMESPACE=${SB_NS}" \
      "AI_PLATFORM_V2_CHECKPOINT_QUEUE=ai-runs-v2-checkpoint" \
      "AI_PLATFORM_V2_RESULT_QUEUE=ai-runs-v2-result" \
      "AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL=${FAST_DISPATCH}" \
      "AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL=${AGENTIC_DISPATCH}" \
      "AI_ORCHESTRATOR_INTERACTIVE_CAP=4" \
      "AI_ORCHESTRATOR_LANE_FLOOR_FAST=1" \
      "AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC=1" \
    >/dev/null
  ORCH_APP_PID="$(az containerapp show -g "$RG" -n "$ORCH_APP" --query identity.principalId -o tsv)"
  az role assignment create \
    --role AcrPull \
    --assignee-object-id "$ORCH_APP_PID" \
    --assignee-principal-type ServicePrincipal \
    --scope "$ACR_ID" \
    >/dev/null 2>&1 || true
}

create_or_update_documents() {
  if az containerapp show -g "$RG" -n "$DOC_APP" &>/dev/null; then
    echo "Updating document worker Container App ${DOC_APP}..."
    az containerapp update -g "$RG" -n "$DOC_APP" --image "$DOC_IMAGE" >/dev/null
    return
  fi

  echo "Creating document worker Container App ${DOC_APP}..."
  az containerapp create \
    -g "$RG" \
    -n "$DOC_APP" \
    --environment "$CAE" \
    --system-assigned \
    --user-assigned "$DOC_MI_ID" \
    --registry-server "$LOGIN_SERVER" \
    --registry-identity system \
    --image "$DOC_IMAGE" \
    --min-replicas 1 \
    --max-replicas 2 \
    --cpu 0.5 \
    --memory 1Gi \
    --env-vars \
      "NODE_ENV=production" \
      "AZURE_CLIENT_ID=${DOC_CLIENT}" \
      "AZURE_TENANT_ID=${TENANT}" \
      "AI_PLATFORM_V2_SERVICEBUS_NAMESPACE=${SB_NS}" \
      "AI_PLATFORM_V2_BLOB_ACCOUNT_NAME=${STORAGE}" \
      "AI_PLATFORM_V2_ARTIFACT_CONTAINER=${ARTIFACT_CONTAINER}" \
    >/dev/null
  DOC_APP_PID="$(az containerapp show -g "$RG" -n "$DOC_APP" --query identity.principalId -o tsv)"
  az role assignment create \
    --role AcrPull \
    --assignee-object-id "$DOC_APP_PID" \
    --assignee-principal-type ServicePrincipal \
    --scope "$ACR_ID" \
    >/dev/null 2>&1 || true
}

roll_interactive_class() {
  local app_name="$1"
  if ! az containerapp show -g "$RG" -n "$app_name" &>/dev/null; then
    echo "Skipping ${app_name}: not provisioned yet."
    return
  fi
  echo "Updating interactive class host ${app_name}..."
  az containerapp update -g "$RG" -n "$app_name" --image "$INTERACTIVE_IMAGE" >/dev/null
}

create_or_update_orchestrator
create_or_update_documents
roll_interactive_class "$FAST_APP"
roll_interactive_class "$AGENTIC_APP"

echo ""
echo "DEV V2 runtime wiring complete."
echo "  App: ${APP} — V2 blob/SB settings applied"
echo "  Orchestrator: ${ORCH_APP} — fast → ${FAST_DISPATCH}"
echo "  Orchestrator: ${ORCH_APP} — agentic → ${AGENTIC_DISPATCH}"
echo "  Document worker: ${DOC_APP} — image ${DOC_IMAGE}"
echo "  Fast interactive: ${FAST_APP}"
echo "  Agentic interactive: ${AGENTIC_APP}"
echo ""
echo "Next: Platform Admin → Feature Flags → enable ai-runs-v2-transport for your user (and project if scoped)."
echo "Then open Agent Home on https://${APP}.azurewebsites.net (or your DEV URL) and send a chat message."
