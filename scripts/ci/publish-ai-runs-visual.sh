#!/usr/bin/env bash
# Build and push the Apex V2 visual lane worker image.
# deploy.yml pushes before the slot swap (SKIP_APP_UPDATE) and updates the
# Container App after it (SKIP_IMAGE_PUBLISH).
#
# Required env:
#   AI_RUNS_ACR_NAME
# Optional:
#   AI_RUNS_VISUAL_IMAGE_REPO (default: apex-ai-runs-visual)
#   AI_RUNS_VISUAL_CONTAINER_APP_NAME — when set, updates the Container App
#   AI_RUNS_RESOURCE_GROUP — required when updating the Container App
#   IMAGE_TAG / SKIP_APP_UPDATE / SKIP_IMAGE_PUBLISH

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/image-publish-lib.sh"

if [[ -z "${AI_RUNS_ACR_NAME:-}" ]]; then
  echo "Skipping V2 visual lane worker publish: AI_RUNS_ACR_NAME is not set."
  exit 0
fi

DOCKERFILE="runners/ai-runs-visual/Dockerfile"
ENTRYPOINT="dist/server/services/aiRunsV2Worker/visualEntrypoint.js"
REPO="${AI_RUNS_VISUAL_IMAGE_REPO:-apex-ai-runs-visual}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_APP_UPDATE="${SKIP_APP_UPDATE:-false}"
SKIP_IMAGE_PUBLISH="${SKIP_IMAGE_PUBLISH:-false}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Skipping V2 visual lane worker publish: ${DOCKERFILE} is not present."
  exit 0
fi

if [[ "$SKIP_IMAGE_PUBLISH" != "true" && ! -f "$ENTRYPOINT" ]]; then
  echo "FAIL: ${ENTRYPOINT} missing. Run npm run build:server first."
  exit 1
fi

if ! az acr show --name "$AI_RUNS_ACR_NAME" &>/dev/null; then
  echo "FAIL: ACR '${AI_RUNS_ACR_NAME}' not found."
  exit 1
fi

LOGIN_SERVER="$(az acr show --name "$AI_RUNS_ACR_NAME" --query loginServer -o tsv)"
IMAGE="${LOGIN_SERVER}/${REPO}:${TAG}"

if [[ "$SKIP_IMAGE_PUBLISH" == "true" ]]; then
  echo "SKIP_IMAGE_PUBLISH=true — reusing ${IMAGE}."
else
  echo "Logging in to ACR ${AI_RUNS_ACR_NAME}..."
  az acr login --name "$AI_RUNS_ACR_NAME"

  publish_image "$AI_RUNS_ACR_NAME" "$LOGIN_SERVER" "$REPO" "$TAG" "$DOCKERFILE"
fi

if [[ "$SKIP_APP_UPDATE" == "true" ]]; then
  echo "SKIP_APP_UPDATE=true — image pushed; Container App not updated."
  exit 0
fi

if [[ -z "${AI_RUNS_VISUAL_CONTAINER_APP_NAME:-}" ]]; then
  echo "Image pushed. Skipping Container App update: AI_RUNS_VISUAL_CONTAINER_APP_NAME not set."
  exit 0
fi

: "${AI_RUNS_RESOURCE_GROUP:?AI_RUNS_RESOURCE_GROUP is required to update the V2 visual lane worker Container App}"

if ! az containerapp show \
  --name "$AI_RUNS_VISUAL_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" &>/dev/null; then
  echo "Image pushed. Skipping Container App update: '${AI_RUNS_VISUAL_CONTAINER_APP_NAME}' not found (apply V2 foundation / worker host first)."
  exit 0
fi

if already_running app "$AI_RUNS_VISUAL_CONTAINER_APP_NAME" "$AI_RUNS_RESOURCE_GROUP" "$IMAGE"; then
  echo "${AI_RUNS_VISUAL_CONTAINER_APP_NAME} already runs ${IMAGE}; skipping update."
  exit 0
fi

echo "Updating Container App ${AI_RUNS_VISUAL_CONTAINER_APP_NAME}..."
az containerapp update \
  --name "$AI_RUNS_VISUAL_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" \
  --image "$IMAGE"

echo "V2 visual lane worker image published: ${IMAGE}"
