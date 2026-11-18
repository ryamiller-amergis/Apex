#!/usr/bin/env bash
# Loads prod's secret Terraform inputs from live Azure (MSS-Production,
# rg-apex-prd-app / rg-apex-prd-data) into TF_VAR_* for this shell. Nothing is
# written to disk. Source it from infra/:
#
#   source scripts/prd-tf-secrets.sh
#   terraform plan -var-file=env/prd.tfvars
#
# Values come from the running apps, so a plan does not rotate them. An empty
# value would make Terraform clear that setting, so the script refuses to finish
# if any input comes back empty.
export MSYS_NO_PATHCONV=1

_prd_secrets() {
  local subscription=MSS-Production
  local rg=rg-apex-prd-app
  local data_rg=rg-apex-prd-data
  local s="--subscription $subscription"

  # Terraform plans against the CLI's current subscription unless ARM_SUBSCRIPTION_ID is set.
  local current
  current=$(az account show --query name -o tsv 2>/dev/null | tr -d '\r')
  if [ "$current" != "$subscription" ] && [ "${ARM_SUBSCRIPTION_ID:-}" != "2a8a9b11-bc1f-478d-84b4-a16375f3fae2" ]; then
    echo "Azure CLI is on '$current'; run: az account set --subscription $subscription" >&2
    return 1
  fi

  local pick='const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=a.find(x=>x.name===process.argv[1]);process.stdout.write(s&&s.value!=null?s.value:"")'
  app_secret() { az containerapp secret list -g $rg -n "$1" $s --show-values -o json | node -e "$pick" "$2"; }
  job_secret() { az containerapp job secret list -g $rg -n "$1" $s --show-values -o json | node -e "$pick" "$2"; }

  # The web app's settings are ignored by Terraform after creation, but these
  # variables are required, so they are read from the live production slot.
  local web
  web=$(az webapp config appsettings list -g $rg -n app-apex-prd $s -o json) || return 1
  local pair
  for pair in ado_org:ADO_ORG ado_pat:ADO_PAT ado_project:ADO_PROJECT ado_area_path:ADO_AREA_PATH \
    ado_allowed_projects:ADO_ALLOWED_PROJECTS vite_teams:VITE_TEAMS \
    azure_tenant_id:AZURE_TENANT_ID azure_client_id:AZURE_CLIENT_ID azure_client_secret:AZURE_CLIENT_SECRET \
    session_secret:SESSION_SECRET azure_cost_tenant_id:AZURE_COST_TENANT_ID \
    azure_cost_client_id:AZURE_COST_CLIENT_ID azure_cost_client_secret:AZURE_COST_CLIENT_SECRET \
    aws_access_key_id:AWS_ACCESS_KEY_ID aws_secret_access_key:AWS_SECRET_ACCESS_KEY \
    cursor_api_key:CURSOR_API_KEY cursor_team_api_key:CURSOR_TEAM_API_KEY; do
    export "TF_VAR_${pair%%:*}=$(printf '%s' "$web" | node -e "$pick" "${pair#*:}")"
  done

  local database_url
  database_url=$(app_secret ca-apex-repo-read-d4-prd database-url)
  export TF_VAR_github_token=$(app_secret ca-apex-repo-read-d4-prd github-token)
  export TF_VAR_postgresql_admin_username=$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.argv[1]).username))' "$database_url")
  export TF_VAR_postgresql_admin_password=$(node -e 'process.stdout.write(new URL(process.argv[1]).password)' "$database_url")

  export TF_VAR_ai_runs_runner_callback_token=$(job_secret caj-apex-ai-runs-prd ai-runs-runner-callback-token)
  export TF_VAR_lt_runner_callback_token=$(job_secret caj-apex-lt-prd lt-runner-callback-token)

  export TF_VAR_ai_platform_v2_interactive_repo_read_service_token=$(app_secret ca-apex-ai-fast-interactive-prd repo-read-service-token)
  export TF_VAR_ai_platform_v2_interactive_redis_key=$(app_secret ca-apex-ai-fast-interactive-prd redis-key)
  export TF_VAR_ai_platform_v2_visual_aws_access_key_id=$(app_secret ca-apex-ai-runs-visual-v2-prd aws-access-key-id)
  export TF_VAR_ai_platform_v2_visual_aws_secret_access_key=$(app_secret ca-apex-ai-runs-visual-v2-prd aws-secret-access-key)
  # The document worker grades llm-rubric checks with the same Bedrock key.
  export TF_VAR_ai_platform_v2_documents_aws_access_key_id=$TF_VAR_ai_platform_v2_visual_aws_access_key_id
  export TF_VAR_ai_platform_v2_documents_aws_secret_access_key=$TF_VAR_ai_platform_v2_visual_aws_secret_access_key
  export TF_VAR_ai_platform_v2_database_url=$(app_secret ca-apex-ai-orchestrator-prd database-url)
  export TF_VAR_ai_platform_v2_application_insights_connection_string=$(az monitor app-insights component show -g $data_rg -a appi-app-apex-prd $s --query connectionString -o tsv | tr -d '\r')

  local name missing=0
  for name in $(env | grep -o '^TF_VAR_[a-z0-9_]*'); do
    if [ -z "${!name}" ]; then
      echo "Empty value for $name" >&2
      missing=1
    fi
  done
  [ "$missing" = 0 ] || return 1
  echo "Loaded $(env | grep -c '^TF_VAR_') prd inputs from $subscription"
}

_prd_secrets
unset -f _prd_secrets app_secret job_secret
