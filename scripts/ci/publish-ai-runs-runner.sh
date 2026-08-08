#!/usr/bin/env bash
# Build, push, and roll the Apex AI-runs worker image onto its Container Apps Job.
# The workflow calls this only after FEAT-004 adds runners/ai-runs/Dockerfile.
#
# Required env:
#   AI_RUNS_ACR_NAME                 ACR name (for example, acrapexltdev)
#   AI_RUNS_CONTAINER_APP_JOB_NAME   Job name (for example, caj-apex-ai-runs-dev)
#   AI_RUNS_RESOURCE_GROUP           Resource group containing the Job
#
# Optional env:
#   AI_RUNS_RUNNER_IMAGE_REPO        Repository name (default: apex-ai-runs)
#   IMAGE_TAG                        Tag to push (default: GITHUB_SHA or "local")
#   SKIP_JOB_UPDATE                  Push only when "true"

set -euo pipefail

if [[ -z "${AI_RUNS_ACR_NAME:-}" ]]; then
  echo "Skipping AI-runs runner publish: AI_RUNS_ACR_NAME is not set."
  exit 0
fi

: "${AI_RUNS_CONTAINER_APP_JOB_NAME:?AI_RUNS_CONTAINER_APP_JOB_NAME is required when AI_RUNS_ACR_NAME is set}"
: "${AI_RUNS_RESOURCE_GROUP:?AI_RUNS_RESOURCE_GROUP is required when AI_RUNS_ACR_NAME is set}"

DOCKERFILE="runners/ai-runs/Dockerfile"
ENTRYPOINT="dist/server/services/aiRunsWorker/entrypoint.js"
REPO="${AI_RUNS_RUNNER_IMAGE_REPO:-apex-ai-runs}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_JOB_UPDATE="${SKIP_JOB_UPDATE:-false}"

if [[ ! -f "$DOCKERFILE" ]]; then
  echo "Skipping AI-runs runner publish: ${DOCKERFILE} is not present (FEAT-004 pending)."
  exit 0
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "FAIL: ${ENTRYPOINT} missing."
  echo "Run npm run build (or build:server) before publishing the worker image."
  exit 1
fi

if ! az acr show --name "$AI_RUNS_ACR_NAME" &>/dev/null; then
  echo "FAIL: ACR '${AI_RUNS_ACR_NAME}' not found; provision FEAT-003 first."
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

if [[ "$SKIP_JOB_UPDATE" == "true" ]]; then
  echo "SKIP_JOB_UPDATE=true — image pushed; Job not updated."
  exit 0
fi

echo "Updating Container Apps Job ${AI_RUNS_CONTAINER_APP_JOB_NAME} → ${IMAGE}..."
az containerapp job update \
  --name "$AI_RUNS_CONTAINER_APP_JOB_NAME" \
  --resource-group "$AI_RUNS_RESOURCE_GROUP" \
  --image "$IMAGE"

echo "OK: AI-runs worker image published and Job updated."
