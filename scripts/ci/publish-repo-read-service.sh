#!/usr/bin/env bash
# Build, push, and roll the Apex repo-read service image onto its Container App
# (Stage 3 of design-docs/repo-grounding-consolidation.md). The service answers
# git cat-file / ls-tree / grep over HTTP from a bare mirror on local disk, so
# Container App lanes never need a working tree on Azure Files.
#
# Required env:
#   AI_RUNS_ACR_NAME                     ACR name (for example, acrapexltdev)
#   REPO_READ_SERVICE_CONTAINER_APP_NAME Container App name (for example, ca-apex-repo-read-dev)
#   AI_RUNS_RESOURCE_GROUP               Resource group containing the Container App
#
# Optional env:
#   REPO_READ_SERVICE_IMAGE_REPO   Repository name (default: apex-repo-read)
#   IMAGE_TAG                      Tag to push (default: GITHUB_SHA or "local")
#   SKIP_APP_UPDATE                Push only when "true"

set -euo pipefail

if [[ -z "${AI_RUNS_ACR_NAME:-}" ]]; then
  echo "Skipping repo-read service publish: AI_RUNS_ACR_NAME is not set."
  exit 0
fi

# The repo-read service is provisioned independently (enable_repo_read_service).
# No Container App name means the service is not enabled in this environment.
if [[ -z "${REPO_READ_SERVICE_CONTAINER_APP_NAME:-}" ]]; then
  echo "Skipping repo-read service publish: REPO_READ_SERVICE_CONTAINER_APP_NAME is not set (service not enabled)."
  exit 0
fi

: "${AI_RUNS_RESOURCE_GROUP:?AI_RUNS_RESOURCE_GROUP is required when AI_RUNS_ACR_NAME is set}"

DOCKERFILE="runners/repo-read-service/Dockerfile"
ENTRYPOINT="dist/server/services/repoRead/entrypoint.js"
REPO="${REPO_READ_SERVICE_IMAGE_REPO:-apex-repo-read}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_APP_UPDATE="${SKIP_APP_UPDATE:-false}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Skipping repo-read service publish: ${DOCKERFILE} is not present."
  exit 0
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "FAIL: ${ENTRYPOINT} missing."
  echo "Run npm run build (or build:server) before publishing the repo-read service image."
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

# Terraform ignores image drift on this app, so CI owns the rolling image tag.
# Until enable_repo_read_service has been applied the app will not exist; the
# image is already in ACR, so skip the roll cleanly and keep CI green.
if ! az containerapp show \
  --name "$REPO_READ_SERVICE_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" &>/dev/null; then
  echo "Image pushed. Skipping Container App update: '${REPO_READ_SERVICE_CONTAINER_APP_NAME}' not found in '${AI_RUNS_RESOURCE_GROUP}' (apply Terraform enable_repo_read_service first)."
  exit 0
fi

echo "Updating Container App ${REPO_READ_SERVICE_CONTAINER_APP_NAME} → ${IMAGE}..."
az containerapp update \
  --name "$REPO_READ_SERVICE_CONTAINER_APP_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" \
  --image "$IMAGE"

echo "OK: repo-read service image published and Container App updated."
