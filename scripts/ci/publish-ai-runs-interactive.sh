#!/usr/bin/env bash
# Build, push, and roll the Apex interactive AI-runs host image onto every
# configured Container App target (legacy + V2 fast + agentic) from one SHA.
#
# Required env:
#   AI_RUNS_ACR_NAME                       ACR name (for example, acrapexltdev)
#   AI_RUNS_RESOURCE_GROUP                 Resource group containing the Container Apps
#
# Optional env (each unset name is skipped):
#   AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME       Legacy shared interactive host
#   AI_PLATFORM_V2_FAST_INTERACTIVE_CONTAINER_APP_NAME
#   AI_PLATFORM_V2_AGENTIC_CONTAINER_APP_NAME
#   AI_RUNS_INTERACTIVE_IMAGE_REPO   Repository name (default: apex-ai-runs-interactive)
#   IMAGE_TAG                        Tag to push (default: GITHUB_SHA or "local")
#   SKIP_IMAGE_PUBLISH               Reuse an existing immutable image when "true"
#   SKIP_APP_UPDATE                  Push only when "true"

set -euo pipefail

if [[ -z "${AI_RUNS_ACR_NAME:-}" ]]; then
  echo "Skipping interactive host publish: AI_RUNS_ACR_NAME is not set."
  exit 0
fi

if [[ -z "${AI_RUNS_RESOURCE_GROUP:-}" ]]; then
  echo "Skipping interactive host publish: AI_RUNS_RESOURCE_GROUP is not set."
  exit 0
fi

DOCKERFILE="runners/ai-runs-interactive/Dockerfile"
ENTRYPOINT="dist/server/services/interactiveActorHost/entrypoint.js"
REPO="${AI_RUNS_INTERACTIVE_IMAGE_REPO:-apex-ai-runs-interactive}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_IMAGE_PUBLISH="${SKIP_IMAGE_PUBLISH:-false}"
SKIP_APP_UPDATE="${SKIP_APP_UPDATE:-false}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Skipping interactive host publish: ${DOCKERFILE} is not present."
  exit 0
fi

if [[ "$SKIP_IMAGE_PUBLISH" != "true" && ! -f "$ENTRYPOINT" ]]; then
  echo "FAIL: ${ENTRYPOINT} missing."
  echo "Run npm run build (or build:server) before publishing the interactive host image."
  exit 1
fi

if ! az acr show --name "$AI_RUNS_ACR_NAME" &>/dev/null; then
  echo "FAIL: ACR '${AI_RUNS_ACR_NAME}' not found; provision the shared ACR first."
  exit 1
fi

LOGIN_SERVER="$(az acr show --name "$AI_RUNS_ACR_NAME" --query loginServer -o tsv)"
IMAGE="${LOGIN_SERVER}/${REPO}:${TAG}"
IMAGE_LATEST="${LOGIN_SERVER}/${REPO}:latest"

echo "Logging in to ACR ${AI_RUNS_ACR_NAME}..."
az acr login --name "$AI_RUNS_ACR_NAME"

if [[ "$SKIP_IMAGE_PUBLISH" == "true" ]]; then
  echo "SKIP_IMAGE_PUBLISH=true — reusing ${IMAGE}."
else
  echo "Building ${IMAGE}..."
  docker build -f "$DOCKERFILE" -t "$IMAGE" -t "$IMAGE_LATEST" .

  echo "Pushing ${IMAGE} and ${IMAGE_LATEST}..."
  docker push "$IMAGE"
  docker push "$IMAGE_LATEST"
fi

if [[ "$SKIP_APP_UPDATE" == "true" ]]; then
  echo "SKIP_APP_UPDATE=true — image pushed; Container Apps not updated."
  exit 0
fi

TARGETS=()
if [[ -n "${AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME:-}" ]]; then
  TARGETS+=("$AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME")
fi
if [[ -n "${AI_PLATFORM_V2_FAST_INTERACTIVE_CONTAINER_APP_NAME:-}" ]]; then
  TARGETS+=("$AI_PLATFORM_V2_FAST_INTERACTIVE_CONTAINER_APP_NAME")
fi
if [[ -n "${AI_PLATFORM_V2_AGENTIC_CONTAINER_APP_NAME:-}" ]]; then
  TARGETS+=("$AI_PLATFORM_V2_AGENTIC_CONTAINER_APP_NAME")
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "Image pushed. No interactive Container App names configured — skipping roll."
  exit 0
fi

verify_health() {
  local app="$1"
  local revision="$2"
  local require_probe_health="$3"
  for attempt in $(seq 1 30); do
    local state
    state="$(az containerapp revision show \
      --name "$app" \
      --resource-group "$AI_RUNS_RESOURCE_GROUP" \
      --revision "$revision" \
      --query "join('|', [properties.healthState, properties.provisioningState, properties.runningState])" \
      -o tsv 2>/dev/null || true)"
    state="${state//$'\r'/}"
    local health provisioning running
    IFS='|' read -r health provisioning running <<< "$state"
    if [[ "$health" == "Healthy" ]]; then
      echo "Revision ${revision} is Healthy for ${app}."
      return 0
    fi
    if [[ "$require_probe_health" != "true" && "$provisioning" == "Provisioned" && "$running" == "Running" ]]; then
      echo "Legacy revision ${revision} is Provisioned and Running for ${app}."
      return 0
    fi
    echo "Waiting for ${app} revision ${revision} (health=${health:-unknown}, provisioning=${provisioning:-unknown}, running=${running:-unknown}, attempt ${attempt}/30)..."
    sleep 10
  done
  echo "FAIL: ${app} revision ${revision} did not reach its required health state."
  return 1
}

UPDATED=0
for APP in "${TARGETS[@]}"; do
  if ! az containerapp show --name "$APP" --resource-group "$AI_RUNS_RESOURCE_GROUP" &>/dev/null; then
    echo "Skipping '${APP}': not found in '${AI_RUNS_RESOURCE_GROUP}' (apply Terraform first)."
    continue
  fi
  PREVIOUS_IMAGE="$(az containerapp show \
    --name "$APP" \
    --resource-group "$AI_RUNS_RESOURCE_GROUP" \
    --query properties.template.containers[0].image \
    -o tsv)"
  echo "Updating Container App ${APP} → ${IMAGE}..."
  az containerapp update \
    --name "$APP" \
    --resource-group "$AI_RUNS_RESOURCE_GROUP" \
    --image "$IMAGE" \
    >/dev/null
  REVISION="$(az containerapp show \
    --name "$APP" \
    --resource-group "$AI_RUNS_RESOURCE_GROUP" \
    --query properties.latestRevisionName \
    -o tsv)"
  REQUIRE_PROBE_HEALTH=false
  if [[ "$APP" == "${AI_PLATFORM_V2_FAST_INTERACTIVE_CONTAINER_APP_NAME:-}" || "$APP" == "${AI_PLATFORM_V2_AGENTIC_CONTAINER_APP_NAME:-}" ]]; then
    REQUIRE_PROBE_HEALTH=true
  fi
  verify_health "$APP" "$REVISION" "$REQUIRE_PROBE_HEALTH"
  echo "Rollback ${APP}: az containerapp update -g '${AI_RUNS_RESOURCE_GROUP}' -n '${APP}' --image '${PREVIOUS_IMAGE}'"
  UPDATED=$((UPDATED + 1))
done

if [[ "$UPDATED" -eq 0 ]]; then
  echo "Image pushed. No existing Container Apps were updated."
  exit 0
fi

echo "OK: interactive host image published and ${UPDATED} Container App(s) updated."
