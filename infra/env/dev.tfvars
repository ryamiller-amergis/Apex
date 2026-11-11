# Dev (MSS-DevTest, rg-scrum-dev) inputs. Non-secret only; commit changes here.
# Secrets come from live Azure at run time:
#   source scripts/dev-tf-secrets.sh
#   terraform plan -var-file=env/dev.tfvars
# Container images are deployed by CI and ignored by Terraform after creation;
# the image values below only matter when an app is first created.

resource_group_name                          = "rg-scrum-dev"
location                                     = "East US"
app_service_name                             = "app-scrum-dev"
app_service_plan_name                        = "plan-scrum-dev"
app_service_plan_sku                         = "B3"
enable_staging_slot                          = false
environment                                  = "dev"
postgresql_location                          = "East US 2"
postgresql_resource_group_name               = "rg-scrum-dev"
postgresql_server_name                       = "psql-scrum-eus2"
postgresql_admin_username                    = "pgadmin"
postgresql_database_name                     = "hub"
postgresql_sku_name                          = "B_Standard_B1ms"
postgresql_availability_zone                 = "2"
postgresql_storage_mb                        = 32768
postgresql_backup_retention_days             = 7
postgresql_azure_services_firewall_rule_name = "allow-azure-services"

azure_redirect_url = "https://app-scrum-dev.azurewebsites.net/auth/callback"
github_org         = "ryamiller-amergis"

lt_apex_callback_base_url = "https://app-scrum-dev.azurewebsites.net"

ai_runs_servicebus_namespace_name = "sbns-apex-ai-dev"
ai_runs_background_queue_name     = "ai-runs-background"
ai_runs_container_app_env_name    = "cae-apex-ai-dev"
ai_runs_container_app_job_name    = "caj-apex-ai-runs-dev"
ai_runs_runner_identity_name      = "mi-apex-ai-runs-runner-dev"
ai_runs_file_share_name           = "ai-pilot-data"
ai_runs_file_share_quota_gb       = 100
ai_runs_key_vault_name            = "kv-apex-ai-dev"
ai_runs_runner_image              = "acrapexltdev.azurecr.io/apex-ai-runs:src-d8660e13c966ad88"
ai_runs_apex_callback_base_url    = "https://app-scrum-dev.azurewebsites.net"

enable_cursor_pool_workers = true

enable_ai_runs_interactive             = true
ai_runs_interactive_container_app_name = "ca-apex-ai-interactive-dev"
ai_runs_interactive_redis_name         = "redis-apex-ai-dev"
ai_runs_interactive_redis_backend      = "cache"
ai_runs_interactive_image              = "acrapexltdev.azurecr.io/apex-ai-runs-interactive:src-c991fa4b671b293d"
# Scale dev's old chat app to zero, like prod (Aneesh, Nov 2026).
ai_runs_interactive_reserved  = 0
ai_runs_interactive_burst_max = 12

enable_repo_read_service             = true
repo_read_service_container_app_name = "ca-apex-repo-read-dev"
repo_read_service_image              = "acrapexltdev.azurecr.io/apex-repo-read:src-efe150e2cda0d2fc"

enable_ai_platform_v2                    = true
ai_platform_v2_location                  = "eastus"
ai_platform_v2_resource_group_name       = "rg-scrum-dev"
ai_platform_v2_data_resource_group_name  = "rg-scrum-dev"
ai_platform_v2_servicebus_namespace_name = "sbns-apex-ai-dev"
ai_platform_v2_storage_account_name      = "stapexdevasync"
ai_platform_v2_container_app_env_name    = "cae-apex-ai-dev"
ai_platform_v2_acr_name                  = "acrapexltdev"
ai_platform_v2_acr_resource_group_name   = "rg-scrum-dev"

enable_ai_platform_v2_runtime           = true
enable_ai_platform_v2_split_interactive = true
enable_ai_platform_v2_container_logs    = true

ai_platform_v2_interactive_repo_read_service_url = "https://ca-apex-repo-read-dev.happypebble-0247ee34.eastus.azurecontainerapps.io"
ai_platform_v2_interactive_redis_host            = "redis-apex-ai-dev.redis.cache.windows.net"
ai_platform_v2_interactive_callback_base_url     = "https://app-scrum-dev.azurewebsites.net"
# Share removed from dev's agentic and fast chat apps by hand on Nov 5 (Aneesh).
ai_platform_v2_interactive_mount_workspace_share = false

ai_platform_v2_interactive_image  = "acrapexltdev.azurecr.io/apex-ai-runs-interactive:src-c991fa4b671b293d"
ai_platform_v2_orchestrator_image = "acrapexltdev.azurecr.io/apex-ai-orchestrator:src-3b733baa0c4b15c6"
ai_platform_v2_documents_v2_image = "acrapexltdev.azurecr.io/apex-ai-runs-documents-v2:src-fe7c84016c2a2bb3"
ai_platform_v2_visual_image       = "acrapexltdev.azurecr.io/apex-ai-runs-visual:src-7aae1151ab516696"

# People and pipeline identities that run apply (Key Vault Secrets Officer on kv-apex-ai-dev).
ai_runs_key_vault_secrets_officer_ids = [
  "110b196f-3f0d-4890-969f-5571085039de", # Ryan Miller
  "1ceaafde-4871-4411-9ef7-5432c7b4e080", # Aneesh Nedunuri
  "bf8bc145-7a46-41f8-88c9-6863641e5eae", # apex-dev-sp (dev AZURE_DEPLOY_CREDENTIALS)
]
