#!/usr/bin/env bash
# Build, push, and roll the Apex load-test k6 runner image onto the Container Apps Job.
# Intended for GitHub Actions (pr-tests deploy-dev / deploy.yml deploy-staging).
#
# Required env:
#   LT_ACR_NAME                ACR name (e.g. acrapexltdev)
#   LT_CONTAINER_APP_JOB_NAME  Job name (e.g. caj-apex-lt-dev)
#   LT_RESOURCE_GROUP          Resource group containing the job + ACR
#
# Optional env:
#   IMAGE_TAG                  Tag to push (default: GITHUB_SHA or "local")
#   LT_RUNNER_IMAGE_REPO       Repository name (default: apex-lt-k6)
#   SKIP_JOB_UPDATE           If "true", push only (do not update the job)

set -euo pipefail

if [[ -z "${LT_ACR_NAME:-}" ]]; then
  echo "Skipping load-test runner publish: LT_ACR_NAME is not set."
  exit 0
fi

: "${LT_CONTAINER_APP_JOB_NAME:?LT_CONTAINER_APP_JOB_NAME is required when LT_ACR_NAME is set}"
: "${LT_RESOURCE_GROUP:?LT_RESOURCE_GROUP is required when LT_ACR_NAME is set}"

REPO="${LT_RUNNER_IMAGE_REPO:-apex-lt-k6}"
TAG="${IMAGE_TAG:-${GITHUB_SHA:-local}}"
SKIP_JOB_UPDATE="${SKIP_JOB_UPDATE:-false}"

if [[ ! -f dist/server/services/loadTestRunner/entrypoint.js ]]; then
  echo "FAIL: dist/server/services/loadTestRunner/entrypoint.js missing."
  echo "Run npm run build (or build:server) before publishing the runner image."
  exit 1
fi

if ! az acr show --name "$LT_ACR_NAME" &>/dev/null; then
  echo "Skipping load-test runner publish: ACR '${LT_ACR_NAME}' not found (provision via Terraform first)."
  exit 0
fi

LOGIN_SERVER="$(az acr show --name "$LT_ACR_NAME" --query loginServer -o tsv)"
IMAGE="${LOGIN_SERVER}/${REPO}:${TAG}"
IMAGE_LATEST="${LOGIN_SERVER}/${REPO}:latest"

echo "Logging in to ACR ${LT_ACR_NAME}..."
az acr login --name "$LT_ACR_NAME"

echo "Building ${IMAGE}..."
docker build -f runners/load-test-k6/Dockerfile -t "$IMAGE" -t "$IMAGE_LATEST" .

echo "Pushing ${IMAGE} and ${IMAGE_LATEST}..."
docker push "$IMAGE"
docker push "$IMAGE_LATEST"

if [[ "$SKIP_JOB_UPDATE" == "true" ]]; then
  echo "SKIP_JOB_UPDATE=true — image pushed; job not updated."
  exit 0
fi

echo "Updating Container Apps Job ${LT_CONTAINER_APP_JOB_NAME} → ${IMAGE}..."
az containerapp job update \
  --name "$LT_CONTAINER_APP_JOB_NAME" \
  --resource-group "$LT_RESOURCE_GROUP" \
  --image "$IMAGE"

echo "OK: load-test runner image published and job updated."
