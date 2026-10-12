#!/usr/bin/env bash
# Build and push the Apex V2 document lane worker image.
# Does not wire deploy.yml — park apply/rollout with deferred Azure ops.
#
# Required env:
#   AI_RUNS_ACR_NAME
# Optional:
#   AI_RUNS_DOCUMENTS_V2_IMAGE_REPO (default: apex-ai-runs-documents-v2)
#   AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME — when set, updates the Container App
#   AI_RUNS_RESOURCE_GROUP — required when updating the Container App
#   IMAGE_TAG / SKIP_APP_UPDATE

set -euo pipefail

if [[ -z "${AI_RUNS_ACR_NAME:-}" ]]; then
  echo "Skipping V2 document lane worker publish: AI_RUNS_ACR_NAME is not set."
  exit 0
fi

DOCKERFILE="runners/ai-runs-documents-v2/Dockerfile"
ENTRYPOINT="dist/server/services/aiRunsV2Worker/documentEntrypoint.js"
REPO="${AI_RUNS_DOCUMENTS_V2_IMAGE_REPO:-apex-ai-runs-documents-v2}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_APP_UPDATE="${SKIP_APP_UPDATE:-false}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Skipping V2 document lane worker publish: ${DOCKERFILE} is not present."
  exit 0
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "FAIL: ${ENTRYPOINT} missing. Run npm run build:server first."
  exit 1
fi

if ! az acr show --name "$AI_RUNS_ACR_NAME" &>/dev/null; then
  echo "FAIL: ACR '${AI_RUNS_ACR_NAME}' not found."
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

if [[ -z "${AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME:-}" ]]; then
  echo "Image pushed. Skipping Container App update: AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME not set."
  exit 0
fi

: "${AI_RUNS_RESOURCE_GROUP:?AI_RUNS_RESOURCE_GROUP is required to update the V2 document lane worker Container App}"

if ! az containerapp show \
  --name "$AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" &>/dev/null; then
  echo "Image pushed. Skipping Container App update: '${AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME}' not found (apply V2 foundation / worker host first)."
  exit 0
fi

echo "Updating Container App ${AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME}..."
az containerapp update \
  --name "$AI_RUNS_DOCUMENTS_V2_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" \
  --image "$IMAGE"

echo "V2 document lane worker image published: ${IMAGE}"
