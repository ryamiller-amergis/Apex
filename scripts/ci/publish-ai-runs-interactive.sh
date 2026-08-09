#!/usr/bin/env bash
# Build, push, and roll the Apex interactive AI-runs host image onto its
# long-running Azure Container App (Dapr virtual-actor host, FEAT-007).
# The workflow calls this only after runners/ai-runs-interactive/Dockerfile exists.
#
# Required env:
#   AI_RUNS_ACR_NAME                       ACR name (for example, acrapexltdev)
#   AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME Container App name (for example, ca-apex-ai-runs-interactive-dev)
#   AI_RUNS_RESOURCE_GROUP                 Resource group containing the Container App
#
# Optional env:
#   AI_RUNS_INTERACTIVE_IMAGE_REPO   Repository name (default: apex-ai-runs-interactive)
#   IMAGE_TAG                        Tag to push (default: GITHUB_SHA or "local")
#   SKIP_APP_UPDATE                  Push only when "true"

set -euo pipefail

if [[ -z "${AI_RUNS_ACR_NAME:-}" ]]; then
  echo "Skipping interactive host publish: AI_RUNS_ACR_NAME is not set."
  exit 0
fi

# The interactive lane is provisioned independently of the worker ACR. If its
# Container App name is not set, the lane is not enabled in this environment —
# skip cleanly so worker-only environments are unaffected.
if [[ -z "${AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME:-}" ]]; then
  echo "Skipping interactive host publish: AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME is not set (lane not enabled)."
  exit 0
fi

: "${AI_RUNS_RESOURCE_GROUP:?AI_RUNS_RESOURCE_GROUP is required when AI_RUNS_ACR_NAME is set}"

DOCKERFILE="runners/ai-runs-interactive/Dockerfile"
ENTRYPOINT="dist/server/services/interactiveActorHost/entrypoint.js"
REPO="${AI_RUNS_INTERACTIVE_IMAGE_REPO:-apex-ai-runs-interactive}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_APP_UPDATE="${SKIP_APP_UPDATE:-false}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Skipping interactive host publish: ${DOCKERFILE} is not present."
  exit 0
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
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

echo "Building ${IMAGE}..."
docker build -f "$DOCKERFILE" -t "$IMAGE" -t "$IMAGE_LATEST" .

echo "Pushing ${IMAGE} and ${IMAGE_LATEST}..."
docker push "$IMAGE"
docker push "$IMAGE_LATEST"

if [[ "$SKIP_APP_UPDATE" == "true" ]]; then
  echo "SKIP_APP_UPDATE=true — image pushed; Container App not updated."
  exit 0
fi

# The interactive Container App is provisioned by Terraform (enable_ai_runs_interactive).
# If it does not exist yet, the image is still pushed to ACR above; skip the roll
# cleanly so CI stays green until Terraform has applied the interactive lane.
if ! az containerapp show \
  --name "$AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" &>/dev/null; then
  echo "Image pushed. Skipping Container App update: '${AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME}' not found in '${AI_RUNS_RESOURCE_GROUP}' (apply Terraform interactive lane first)."
  exit 0
fi

echo "Updating Container App ${AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME} → ${IMAGE}..."
az containerapp update \
  --name "$AI_RUNS_INTERACTIVE_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" \
  --image "$IMAGE"

echo "OK: interactive host image published and Container App updated."
