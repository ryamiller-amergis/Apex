# Prod (MSS-Production, rg-apex-prd-app / rg-apex-prd-data) inputs. Non-secret
# only; commit changes here. Secrets come from live Azure at run time:
#   source scripts/prd-tf-secrets.sh
#   terraform plan -var-file=env/prd.tfvars
# Container images are deployed by CI and ignored by Terraform after creation;
# the image values below only matter when an app is first created.

resource_group_name             = "rg-apex-prd-data"
location                        = "East US"
app_service_resource_group_name = "rg-apex-prd-app" # Central US RG — zone-redundant P1v3 requires RG in app region
app_service_location            = "Central US"
app_service_name                = "app-apex-prd"
app_service_plan_name           = "plan-apex-prd-v2"
app_service_plan_sku            = "P1v3" # Premium v3 — deployment slots + zone redundancy
app_service_zone_redundant      = true
app_service_worker_count        = 3
enable_staging_slot             = true
staging_slot_name               = "staging"
environment                     = "prd"

postgresql_location            = "Central US"
postgresql_resource_group_name = "rg-apex-prd-data"
postgresql_server_name         = "psql-apex-cus"
postgresql_database_name       = "hub"
# General Purpose AMD baseline: 2 vCPU / 8 GiB. Prefer AMD for production
# price/performance; use GP_Standard_D2ds_v5 only if benchmarks justify Intel.
postgresql_sku_name                          = "GP_Standard_D2ds_v5"
postgresql_availability_zone                 = "1"
postgresql_storage_mb                        = 131072
postgresql_backup_retention_days             = 30
postgresql_azure_services_firewall_rule_name = "AllowAllAzureServicesAndResourcesWithinAzureIps_2026-8-25_19-7-14"

# Same app registration as GitHub AZURE_CREDENTIALS / apex-prd-sp (dce87859-...)
azure_redirect_url = "https://app-apex-prd.azurewebsites.net/auth/callback"

aws_region       = "us-east-2"
bedrock_model_id = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

poll_interval = "30"
port          = "8080"

lt_apex_callback_base_url = "https://app-apex-prd.azurewebsites.net"

ai_runs_servicebus_namespace_name = "sbns-apex-ai-prd"
ai_runs_background_queue_name     = "ai-runs-background"
ai_runs_container_app_env_name    = "cae-apex-ai-prd"
ai_runs_container_app_job_name    = "caj-apex-ai-runs-prd"
ai_runs_runner_identity_name      = "mi-apex-ai-runs-runner-prd"
ai_runs_max_in_flight             = 10

ai_runs_file_share_name      = "ai-pilot-data"
ai_runs_file_share_quota_gb  = 100
ai_runs_workspace_mount_path = "/home/data/ai-pilot/workspaces"

# Dedicated vault and cursor-api-key secret are provisioned from cursor_api_key.
ai_runs_key_vault_name = "kv-apex-ai-prd"

ai_runs_runner_image  = "acrapexltprd.azurecr.io/apex-ai-runs:latest"
ai_runs_runner_cpu    = 2.0
ai_runs_runner_memory = "4Gi"

ai_runs_apex_callback_base_url  = "https://app-apex-prd.azurewebsites.net"
ai_runs_callback_token_audience = "api://dce87859-2226-42ea-97ee-a50e043e0645"
# The Terraform principals lack Graph application-write permission. Use the
# per-environment callback token until the long-term Entra role can be enabled.
enable_ai_runs_entra_app = false

# Production staging role assignments remain disabled for the current principal.
ai_runs_enable_staging_slot_rbac = false

# AI-runs interactive lane (FEAT-007). reserved/burst/SLO mirror the App Service
# AI_RUNS_INTERACTIVE_* settings so admission and ACA scaling agree.
enable_ai_runs_interactive             = true
ai_runs_interactive_container_app_name = "ca-apex-ai-interactive-prd"
# EnterpriseCluster (-v2): the old OSSCluster redis-apex-ai-prd broke
# standalone-client pub/sub fan-out. Backplane holds no durable data.
ai_runs_interactive_redis_name                      = "redis-apex-ai-prd-v2"
ai_runs_interactive_redis_location                  = "northcentralus"
ai_runs_interactive_redis_backend                   = "managed"
ai_runs_interactive_managed_redis_sku               = "Balanced_B1"
ai_runs_interactive_managed_redis_clustering_policy = "EnterpriseCluster"
ai_runs_interactive_managed_redis_high_availability = true
ai_runs_interactive_image                           = "acrapexltprd.azurecr.io/apex-ai-runs-interactive:latest"
ai_runs_interactive_reserved                        = 0
ai_runs_interactive_burst_max                       = 12
ai_runs_interactive_first_token_slo_ms              = 1500

lt_acr_push_principal_ids = ["994a7098-aa68-4c16-825c-fe7ca05584fc"]

# The production Terraform principal cannot manage staging-slot role assignments,
# and staging load-test dispatch is not currently required.
lt_enable_staging_slot_rbac = false

enable_repo_read_service = true
repo_read_service_image  = "acrapexltprd.azurecr.io/apex-repo-read:8793fbb88453aa82dc448c02768f9f4934ff3ddc"

# Prod outgrew the Consumption-sized service (ca-apex-repo-read-prd) and runs a
# D4 profile in its own environment instead. Terraform must describe the app the
# workers actually call, or an apply repoints REPO_READ_SERVICE_URL at a rebuilt
# Consumption copy.
repo_read_service_container_app_name    = "ca-apex-repo-read-d4-prd"
repo_read_service_environment_id        = "/subscriptions/2a8a9b11-bc1f-478d-84b4-a16375f3fae2/resourceGroups/rg-apex-prd-app/providers/Microsoft.App/managedEnvironments/cae-apex-repo-read-prd"
repo_read_service_workload_profile_name = "repo-read"
repo_read_service_cpu                   = 4.0
repo_read_service_memory                = "16Gi"

alert_email_receivers = ["anedunur@amergis.com"]
alert_container_app_names = [
  "ca-apex-ai-agentic-prd",
  "ca-apex-ai-fast-interactive-prd",
  "ca-apex-ai-interactive-prd",
  "ca-apex-ai-orchestrator-prd",
  "ca-apex-ai-runs-documents-v2-prd",
  "ca-apex-ai-runs-visual-v2-prd",
  "ca-apex-repo-read-d4-prd",
]
alert_container_app_resource_group_name = "rg-apex-prd-app"
alert_email_hours = {
  start     = "08:00:00"
  end       = "18:00:00"
  time_zone = "Eastern Standard Time"
}

staging_slot_shares_app_identity                              = false
ai_platform_v2_agentic_cpu                                    = 2
ai_platform_v2_agentic_memory                                 = "4Gi"
ai_platform_v2_agentic_checkout_disk_budget_bytes             = 6442450944
enable_ai_platform_v2                                         = true
enable_ai_platform_v2_container_logs                          = false
ai_platform_v2_location                                       = "centralus"
ai_platform_v2_resource_group_name                            = "rg-apex-prd-app"
ai_platform_v2_data_resource_group_name                       = "rg-apex-prd-data"
ai_platform_v2_servicebus_namespace_name                      = "sbns-apex-ai-prd"
ai_platform_v2_storage_account_name                           = "stapexprdasync"
ai_platform_v2_container_app_env_name                         = "cae-apex-ai-prd"
ai_platform_v2_grant_app_service_sender                       = false
ai_platform_v2_acr_name                                       = "acrapexltprd"
ai_platform_v2_acr_resource_group_name                        = "rg-apex-prd-app"
ai_platform_v2_interactive_key_vault_id                       = "/subscriptions/2a8a9b11-bc1f-478d-84b4-a16375f3fae2/resourceGroups/rg-apex-prd-data/providers/Microsoft.KeyVault/vaults/kv-apex-ai-prd"
ai_platform_v2_interactive_cursor_api_key_secret_id           = "https://kv-apex-ai-prd.vault.azure.net/secrets/cursor-api-key"
ai_platform_v2_interactive_repo_read_service_url              = "https://ca-apex-repo-read-d4-prd.happygrass-eadb7d6e.centralus.azurecontainerapps.io"
ai_platform_v2_interactive_redis_host                         = "redis-apex-ai-prd-v2.northcentralus.redis.azure.net"
ai_platform_v2_interactive_redis_port                         = 10000
ai_platform_v2_interactive_mount_workspace_share              = false
ai_platform_v2_interactive_callback_base_url                  = "https://app-apex-prd.azurewebsites.net"
ai_platform_v2_interactive_callback_token_audience            = "api://dce87859-2226-42ea-97ee-a50e043e0645"
ai_platform_v2_interactive_runner_app_role_id                 = "54d432ce-5d4c-4a85-a994-22315ffe5e5a"
ai_platform_v2_interactive_runner_service_principal_object_id = "eeec9951-5180-4bcf-b434-a7911f8cbf27"
ai_platform_v2_orchestrator_cpu                               = 1
ai_platform_v2_orchestrator_memory                            = "2Gi"
ai_platform_v2_orchestrator_max_replicas                      = 3
ai_platform_v2_documents_cpu                                  = 1
ai_platform_v2_documents_memory                               = "2Gi"
ai_platform_v2_documents_max_replicas                         = 5
ai_platform_v2_documents_min_replicas                         = 5
ai_platform_v2_visual_cpu                                     = 1
ai_platform_v2_visual_memory                                  = "2Gi"
ai_platform_v2_visual_max_replicas                            = 5

enable_ai_platform_v2_runtime           = true
enable_ai_platform_v2_split_interactive = true
ai_platform_v2_interactive_image        = "acrapexltprd.azurecr.io/apex-ai-runs-interactive:c974e5dc09f4a6ccd8bdff782c00e55f42345cf4"
ai_platform_v2_documents_v2_image       = "acrapexltprd.azurecr.io/apex-ai-runs-documents-v2:dacf65534619ee8871779221f65be130a1465f21"
ai_platform_v2_visual_image             = "acrapexltprd.azurecr.io/apex-ai-runs-visual:dacf65534619ee8871779221f65be130a1465f21"
ai_platform_v2_orchestrator_image       = "acrapexltprd.azurecr.io/apex-ai-orchestrator:c974e5dc09f4a6ccd8bdff782c00e55f42345cf4"
github_org                              = "ryamiller-amergis"

# People and pipeline identities that run apply (Key Vault Secrets Officer on kv-apex-ai-prd).
ai_runs_key_vault_secrets_officer_ids = [
  "1ceaafde-4871-4411-9ef7-5432c7b4e080", # Aneesh Nedunuri
  "eeec9951-5180-4bcf-b434-a7911f8cbf27", # apex-prd-sp (deploy.yml AZURE_CREDENTIALS)
]

# mi-apex-insights-reader-dev, owned by dev state. apex-prd-sp cannot read MSS-DevTest.
ai_runs_insights_reader_identity = {
  id        = "/subscriptions/9d08693d-0c89-4f11-aa43-6cbdb89cf1cb/resourceGroups/rg-scrum-dev/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi-apex-insights-reader-dev"
  client_id = "e4392547-a5c9-4cf7-8425-c0d133c2452c"
}
