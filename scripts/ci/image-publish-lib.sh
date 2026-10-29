#!/usr/bin/env bash
# Build/push helper sourced by scripts/ci/publish-*.sh. The caller must have
# already run `az acr login` for the target registry.
#
# Optional env:
#   REUSE_EXISTING_IMAGE  "true" skips the build when ACR already holds the tag.
#                         Only set this when IMAGE_TAG is the source fingerprint
#                         from detect-image-publish-changes.sh (<name>_tag); a
#                         commit SHA tag is never reused.
#   IMAGE_BUILD_CACHE     "true" builds with buildx and keeps a layer cache at
#                         <repo>:buildcache in the same registry.

# already_running <app|job> <name> <resource group> <image>
# Succeeds when the Container App or Job already runs <image>, so the caller
# can skip an update that would only re-run health checks.
already_running() {
  local kind="$1" name="$2" resource_group="$3" image="$4" current
  case "$kind" in
    app)
      current="$(az containerapp show --name "$name" --resource-group "$resource_group" \
        --query 'properties.template.containers[0].image' -o tsv 2>/dev/null || true)"
      ;;
    job)
      current="$(az containerapp job show --name "$name" --resource-group "$resource_group" \
        --query 'properties.template.containers[0].image' -o tsv 2>/dev/null || true)"
      ;;
    *)
      echo "already_running: unknown kind '${kind}' (expected app or job)" >&2
      return 2
      ;;
  esac
  [[ "${current//$'\r'/}" == "$image" ]]
}

# publish_image <acr name> <login server> <repo> <tag> <dockerfile>
publish_image() {
  local acr="$1" login_server="$2" repo="$3" tag="$4" dockerfile="$5"
  local image="${login_server}/${repo}:${tag}"
  local latest="${login_server}/${repo}:latest"

  if [[ "${REUSE_EXISTING_IMAGE:-false}" == "true" ]] \
    && az acr repository show --name "$acr" --image "${repo}:${tag}" &>/dev/null; then
    echo "${image} already exists in ACR; skipping build."
    return 0
  fi

  if [[ "${IMAGE_BUILD_CACHE:-false}" != "true" ]]; then
    echo "Building ${image}..."
    docker build -f "$dockerfile" -t "$image" -t "$latest" .
    echo "Pushing ${image} and ${latest}..."
    docker push "$image"
    docker push "$latest"
    return 0
  fi

  # The default docker driver cannot export a registry cache.
  if ! docker buildx inspect apex-ci &>/dev/null; then
    docker buildx create --name apex-ci --driver docker-container >/dev/null
  fi
  local cache_ref="${login_server}/${repo}:buildcache"
  echo "Building and pushing ${image} (layer cache ${cache_ref})..."
  docker buildx build --builder apex-ci -f "$dockerfile" \
    -t "$image" -t "$latest" \
    --cache-from "type=registry,ref=${cache_ref}" \
    --cache-to "type=registry,ref=${cache_ref},mode=max,image-manifest=true,oci-mediatypes=true" \
    --push .
}
