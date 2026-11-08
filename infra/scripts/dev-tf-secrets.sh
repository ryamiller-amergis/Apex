#!/usr/bin/env bash
# Loads dev's secret Terraform inputs from live Azure (MSS-DevTest, rg-scrum-dev)
# into TF_VAR_* for this shell. Nothing is written to disk. Source it from infra/:
#
#   source scripts/dev-tf-secrets.sh
#   terraform plan -var-file=env/dev.tfvars
#
# Values come from the running apps, so a plan does not rotate them. An empty
# value would make Terraform clear that setting, so the script refuses to finish
# if any input comes back empty.
export MSYS_NO_PATHCONV=1

_dev_secrets() {
  local subscription=MSS-DevTest
  local rg=rg-scrum-dev
  local s="--subscription $subscription"

  if [ "$(az account show $s --query name -o tsv 2>/dev/null | tr -d '\r')" != "$subscription" ]; then
    echo "Azure CLI cannot read subscription $subscription; run az login" >&2
    return 1
  fi

  local pick='const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=a.find(x=>x.name===process.argv[1]);process.stdout.write(s&&s.value!=null?s.value:"")'
  app_secret() { az containerapp secret list -g $rg -n "$1" $s --show-values -o json | node -e "$pick" "$2"; }
  job_secret() { az containerapp job secret list -g $rg -n "$1" $s --show-values -o json | node -e "$pick" "$2"; }

  # The web app's settings are ignored by Terraform after creation, but these
  # variables are required, so they are read from the live app.
  local web
  web=$(az webapp config appsettings list -g $rg -n app-scrum-dev $s -o json) || return 1
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
  database_url=$(app_secret ca-apex-repo-read-dev database-url)
  export TF_VAR_github_token=$(app_secret ca-apex-repo-read-dev github-token)
  export TF_VAR_postgresql_admin_password=$(node -e 'process.stdout.write(new URL(process.argv[1]).password)' "$database_url")

  export TF_VAR_ai_runs_runner_callback_token=$(job_secret caj-apex-ai-runs-dev ai-runs-runner-callback-token)
  export TF_VAR_lt_runner_callback_token=$(job_secret caj-apex-lt-dev lt-runner-callback-token)

  export TF_VAR_ai_platform_v2_interactive_callback_token=$(app_secret ca-apex-ai-fast-interactive-dev ai-runs-runner-callback-token)
  export TF_VAR_ai_platform_v2_interactive_repo_read_service_token=$(app_secret ca-apex-ai-fast-interactive-dev repo-read-service-token)
  export TF_VAR_ai_platform_v2_interactive_redis_key=$(az redis list-keys -g $rg -n redis-apex-ai-dev $s --query primaryKey -o tsv | tr -d '\r')
  export TF_VAR_ai_platform_v2_visual_aws_access_key_id=$(app_secret ca-apex-ai-runs-visual-v2-dev aws-access-key-id)
  export TF_VAR_ai_platform_v2_visual_aws_secret_access_key=$(app_secret ca-apex-ai-runs-visual-v2-dev aws-secret-access-key)
  export TF_VAR_ai_platform_v2_database_url=$(app_secret ca-apex-ai-orchestrator-dev database-url)
  export TF_VAR_ai_platform_v2_application_insights_connection_string=$(az monitor app-insights component show -g $rg -a appi-app-scrum-dev $s --query connectionString -o tsv | tr -d '\r')

  local vault_id vault_uri
  vault_id=$(az keyvault show -n kv-apex-ai-dev $s --query id -o tsv | tr -d '\r')
  vault_uri=$(az keyvault show -n kv-apex-ai-dev $s --query properties.vaultUri -o tsv | tr -d '\r')
  export TF_VAR_ai_platform_v2_interactive_key_vault_id=$vault_id
  export TF_VAR_ai_platform_v2_interactive_cursor_api_key_secret_id="${vault_uri}secrets/cursor-api-key"

  local name missing=0
  for name in $(env | grep -o '^TF_VAR_[a-z0-9_]*'); do
    if [ -z "${!name}" ]; then
      echo "Empty value for $name" >&2
      missing=1
    fi
  done
  [ "$missing" = 0 ] || return 1
  echo "Loaded $(env | grep -c '^TF_VAR_') dev inputs from $subscription"
}

_dev_secrets
unset -f _dev_secrets app_secret job_secret
