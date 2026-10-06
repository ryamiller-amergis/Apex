#!/usr/bin/env bash
# Runs Terraform against the DEV V2 runtime (workspace dev-aiv2, rg-scrum-dev)
# with the inputs DEV was built from. Secrets are read from Azure at run time
# and passed as TF_VAR_* environment variables; none are written to disk.
#
#   infra/scripts/dev-aiv2-tf.sh plan  -target=azurerm_container_app.ai_platform_v2_interactive_class
#   infra/scripts/dev-aiv2-tf.sh apply dev-aiv2.tfplan
#
# Omitting a secret input makes Terraform delete that setting from the app.
set -euo pipefail
export MSYS_NO_PATHCONV=1

RG=rg-scrum-dev
SUBSCRIPTION=MSS-DevTest
KEY_VAULT=kv-apex-ai-dev
REDIS=redis-apex-ai-dev
FAST_APP=ca-apex-ai-fast-interactive-dev
VISUAL_APP=ca-apex-ai-runs-visual-v2-dev
ORCHESTRATOR_APP=ca-apex-ai-orchestrator-dev
DOCUMENTS_APP=ca-apex-ai-runs-documents-v2-dev

cd "$(dirname "$0")/.."

if [ "$(az account show --query name -o tsv)" != "$SUBSCRIPTION" ]; then
  echo "Azure CLI must be on subscription $SUBSCRIPTION" >&2
  exit 1
fi
terraform workspace select dev-aiv2 >/dev/null

live_image() {
  az containerapp show -g "$RG" -n "$1" \
    --query 'properties.template.containers[0].image' -o tsv
}

app_secret() {
  local value
  value=$(az containerapp secret show -g "$RG" -n "$1" \
    --secret-name "$2" --query value -o tsv)
  require_value "$1/$2" "$value"
  printf '%s' "$value"
}

# An empty TF_VAR_* would make Terraform clear that secret on the live app.
require_value() {
  if [ -z "$2" ]; then
    echo "Empty value for $1; refusing to run Terraform" >&2
    exit 1
  fi
}

KEY_VAULT_ID=$(az keyvault show -n "$KEY_VAULT" --query id -o tsv)
KEY_VAULT_URI=$(az keyvault show -n "$KEY_VAULT" --query properties.vaultUri -o tsv)

TF_VAR_ai_platform_v2_interactive_redis_key=$(
  az redis list-keys -g "$RG" -n "$REDIS" --query primaryKey -o tsv
)
TF_VAR_ai_platform_v2_interactive_callback_token=$(app_secret "$FAST_APP" ai-runs-runner-callback-token)
TF_VAR_ai_platform_v2_interactive_repo_read_service_token=$(app_secret "$FAST_APP" repo-read-service-token)
TF_VAR_ai_platform_v2_visual_aws_access_key_id=$(app_secret "$VISUAL_APP" aws-access-key-id)
TF_VAR_ai_platform_v2_visual_aws_secret_access_key=$(app_secret "$VISUAL_APP" aws-secret-access-key)
TF_VAR_ai_platform_v2_database_url=$(app_secret "$ORCHESTRATOR_APP" database-url)
TF_VAR_ai_platform_v2_application_insights_connection_string=$(
  az monitor app-insights component show -g "$RG" -a appi-app-scrum-dev \
    --query connectionString -o tsv
)
require_value "$REDIS primary key" "$TF_VAR_ai_platform_v2_interactive_redis_key"
require_value "Application Insights connection string" \
  "$TF_VAR_ai_platform_v2_application_insights_connection_string"
export TF_VAR_ai_platform_v2_database_url \
  TF_VAR_ai_platform_v2_application_insights_connection_string \
  TF_VAR_ai_platform_v2_interactive_redis_key \
  TF_VAR_ai_platform_v2_interactive_callback_token \
  TF_VAR_ai_platform_v2_interactive_repo_read_service_token \
  TF_VAR_ai_platform_v2_visual_aws_access_key_id \
  TF_VAR_ai_platform_v2_visual_aws_secret_access_key

VARS=(
  -var=github_token=placeholder
  -var=enable_ai_platform_v2_runtime=true
  -var=enable_ai_platform_v2_split_interactive=true
  -var=enable_ai_platform_v2_container_logs=true
  -var=ai_platform_v2_acr_name=acrapexltdev
  -var=ai_platform_v2_acr_resource_group_name="$RG"
  -var=ai_platform_v2_interactive_key_vault_id="$KEY_VAULT_ID"
  -var=ai_platform_v2_interactive_cursor_api_key_secret_id="${KEY_VAULT_URI}secrets/cursor-api-key"
  -var=ai_platform_v2_interactive_repo_read_service_url=https://ca-apex-repo-read-dev.happypebble-0247ee34.eastus.azurecontainerapps.io
  -var=ai_platform_v2_interactive_redis_host="$REDIS.redis.cache.windows.net"
  -var=ai_platform_v2_interactive_callback_base_url=https://app-scrum-dev.azurewebsites.net
  # Images are deployed by CI and ignored by Terraform after creation.
  -var=ai_platform_v2_interactive_image="$(live_image "$FAST_APP")"
  -var=ai_platform_v2_visual_image="$(live_image "$VISUAL_APP")"
  -var=ai_platform_v2_orchestrator_image="$(live_image "$ORCHESTRATOR_APP")"
  -var=ai_platform_v2_documents_v2_image="$(live_image "$DOCUMENTS_APP")"
)

command=${1:?usage: dev-aiv2-tf.sh plan|apply|import [terraform args...]}
shift
case "$command" in
  plan) terraform plan -input=false "${VARS[@]}" "$@" ;;
  apply) terraform apply -input=false "$@" ;;
  import) terraform import -input=false "${VARS[@]}" "$@" ;;
  *) echo "unknown command: $command" >&2; exit 1 ;;
esac
