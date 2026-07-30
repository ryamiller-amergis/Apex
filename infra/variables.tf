variable "resource_group_name" {
  description = "Name of the Azure Resource Group"
  type        = string
  default     = "rg-apex-mv"
}

variable "location" {
  description = "Azure region for resources"
  type        = string
  default     = "East US"
}

variable "app_service_location" {
  description = "Azure region for App Service plan and web app (defaults to location). Override when the primary region lacks capacity."
  type        = string
  default     = null
}

variable "app_service_name" {
  description = "Name of the App Service"
  type        = string
  default     = "app-apex"
}

variable "app_service_plan_name" {
  description = "Name of the App Service Plan"
  type        = string
  default     = "plan-apex"
}

variable "app_service_plan_sku" {
  description = "App Service Plan SKU. S1+ for deployment slots; P1v3+ with zone_balancing for zone redundancy."
  type        = string
  default     = "B1"
}

variable "app_service_zone_redundant" {
  description = "Enable zone balancing on the App Service plan (requires P1v3+ and worker_count >= 3)."
  type        = bool
  default     = false
}

variable "app_service_worker_count" {
  description = "Fixed App Service plan worker count. Use 3 when app_service_zone_redundant is true."
  type        = number
  default     = null
}

variable "enable_staging_slot" {
  description = "Create a staging deployment slot for blue-green swap deployments."
  type        = bool
  default     = false
}

variable "staging_slot_name" {
  description = "Name of the staging deployment slot."
  type        = string
  default     = "staging"
}

variable "app_service_resource_group_name" {
  description = "Optional dedicated resource group for App Service (required for zone-redundant P1v3 when main RG region differs). Created in app_service_location."
  type        = string
  default     = null
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "ado_org" {
  description = "Azure DevOps organization URL"
  type        = string
  sensitive   = true
}

variable "ado_pat" {
  description = "Azure DevOps Personal Access Token"
  type        = string
  sensitive   = true
}

variable "ado_project" {
  description = "Azure DevOps project name"
  type        = string
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    ManagedBy   = "Terraform"
    Application = "Scrum"
  }
}

# Azure AD / Auth
variable "azure_tenant_id" {
  description = "Azure AD Tenant ID"
  type        = string
  sensitive   = true
}

variable "azure_client_id" {
  description = "Azure AD App Registration Client ID"
  type        = string
  sensitive   = true
}

variable "azure_client_secret" {
  description = "Azure AD App Registration Client Secret"
  type        = string
  sensitive   = true
}

variable "azure_redirect_url" {
  description = "OAuth redirect URL for the app"
  type        = string
}

variable "session_secret" {
  description = "Express session secret"
  type        = string
  sensitive   = true
}

# Azure Cost Management
variable "azure_cost_tenant_id" {
  description = "Tenant ID for Azure Cost Management service principal"
  type        = string
  sensitive   = true
}

variable "azure_cost_client_id" {
  description = "Client ID for Azure Cost Management service principal"
  type        = string
  sensitive   = true
}

variable "azure_cost_client_secret" {
  description = "Client secret for Azure Cost Management service principal"
  type        = string
  sensitive   = true
}

# AWS Bedrock
variable "aws_access_key_id" {
  description = "AWS Access Key ID for Bedrock"
  type        = string
  sensitive   = true
}

variable "aws_secret_access_key" {
  description = "AWS Secret Access Key for Bedrock"
  type        = string
  sensitive   = true
}

variable "aws_region" {
  description = "AWS region for Bedrock"
  type        = string
  default     = "us-east-2"
}

variable "bedrock_model_id" {
  description = "AWS Bedrock model ID"
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

# Cursor
variable "cursor_api_key" {
  description = "Cursor API key"
  type        = string
  sensitive   = true
}

variable "cursor_team_api_key" {
  description = "Cursor Team API key"
  type        = string
  sensitive   = true
}

# SendGrid
variable "sendgrid_api_key" {
  description = "SendGrid API key for the MCP email analytics pill"
  type        = string
  sensitive   = true
  default     = ""
}

# Application
variable "ado_area_path" {
  description = "Azure DevOps area path"
  type        = string
  default     = ""
}

variable "ado_allowed_projects" {
  description = "Comma-separated list of allowed ADO projects"
  type        = string
  default     = ""
}

variable "vite_teams" {
  description = "Tilde-separated team configuration string"
  type        = string
  default     = ""
}

variable "poll_interval" {
  description = "Polling interval in seconds"
  type        = string
  default     = "30"
}

variable "port" {
  description = "Port the app listens on"
  type        = string
  default     = "8080"
}

variable "postgresql_location" {
  description = "Azure region for the PostgreSQL Flexible Server (may differ from main location if subscription quota requires it)"
  type        = string
  default     = "East US 2"
}

variable "postgresql_resource_group_name" {
  description = "Resource group for PostgreSQL (defaults to resource_group_name). Set explicitly when the server lives in a different RG than App Insights."
  type        = string
  default     = null
}

variable "postgresql_server_name" {
  description = "Name of the PostgreSQL Flexible Server (must be globally unique)"
  type        = string
  default     = "psql-apex-eus2"
}

variable "postgresql_admin_username" {
  description = "Administrator login for the PostgreSQL server"
  type        = string
  sensitive   = true
  default     = "pgadmin"
}

variable "postgresql_admin_password" {
  description = "Administrator password for the PostgreSQL server (min 8 chars, must include uppercase, lowercase, number)"
  type        = string
  sensitive   = true
}

variable "postgresql_database_name" {
  description = "Name of the database to create on the PostgreSQL server"
  type        = string
  default     = "apex"
}

variable "postgresql_sku_name" {
  description = "SKU name for the PostgreSQL Flexible Server"
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgresql_high_availability_mode" {
  description = "PostgreSQL HA mode: ZoneRedundant or SameZone. Requires General Purpose or Memory Optimized SKU."
  type        = string
  default     = null
}

variable "postgresql_availability_zone" {
  description = "Primary availability zone for PostgreSQL (required when enabling HA on an existing server)."
  type        = string
  default     = null
}

variable "postgresql_standby_availability_zone" {
  description = "Standby zone for zone-redundant PostgreSQL HA (must differ from primary zone)."
  type        = string
  default     = null
}

# Shared async Blob platform — one private storage account per env.
# Add containers for new modules; do not provision a second account unless
# isolation requirements demand it. PDF job delivery uses Postgres (not Service Bus).
variable "shared_storage_account_name" {
  description = "Globally unique shared Storage Account for private async artifacts. Defaults to stapex<environment>async when null."
  type        = string
  default     = null

  validation {
    condition     = var.shared_storage_account_name == null || can(regex("^[a-z0-9]{3,24}$", var.shared_storage_account_name))
    error_message = "shared_storage_account_name must contain 3-24 lowercase letters or numbers."
  }
}

variable "shared_storage_replication_type" {
  description = "Replication type for the shared async storage account."
  type        = string
  default     = "LRS"

  validation {
    condition     = contains(["LRS", "GRS", "RAGRS", "ZRS", "GZRS", "RAGZRS"], var.shared_storage_replication_type)
    error_message = "shared_storage_replication_type must be a supported Azure Storage replication type."
  }
}

variable "blob_containers" {
  description = "Private blob containers on the shared storage account. Key = container name. Add one container per workload."
  type        = map(object({}))
  default = {
    pdf-artifacts = {}
  }
}

# PDF workload selector — must match a key in blob_containers.
variable "pdf_blob_container_name" {
  description = "Shared-account container used by PDF session and job artifacts. Must exist as a key in blob_containers."
  type        = string
  default     = "pdf-artifacts"
}

# ---------------------------------------------------------------------------
# Load Test module — FEAT-002
# Resource names follow the Apex convention {type}-apex-lt-{environment}.
# Null values derive the standard Apex name; override only for global-name
# collisions or multi-region deployments.
# ---------------------------------------------------------------------------

variable "lt_servicebus_namespace_name" {
  description = "Service Bus namespace for load-test dispatch. Null derives 'sbns-apex-lt-{environment}' (e.g. sbns-apex-lt-dev, sbns-apex-lt-prd)."
  type        = string
  default     = null

  validation {
    condition     = var.lt_servicebus_namespace_name == null || can(regex("^[a-zA-Z][a-zA-Z0-9-]{4,48}[a-zA-Z0-9]$", var.lt_servicebus_namespace_name))
    error_message = "Service Bus namespace must be 6–50 chars, start with a letter, contain only letters/numbers/hyphens."
  }
}

variable "lt_servicebus_queue_name" {
  description = "Queue name inside the load-test Service Bus namespace. Null uses 'lt-dispatch'."
  type        = string
  default     = null
}

variable "lt_container_app_env_name" {
  description = "Container Apps Environment for the load-test runner. Null derives 'cae-apex-lt-{environment}'."
  type        = string
  default     = null
}

variable "lt_container_app_job_name" {
  description = "Container Apps Job name for the k6 runner. Null derives 'caj-apex-lt-{environment}'."
  type        = string
  default     = null
}

variable "lt_runner_identity_name" {
  description = "User-assigned managed identity for the load-test runner. Null derives 'mi-apex-lt-runner-{environment}'."
  type        = string
  default     = null
}

variable "lt_blob_container_name" {
  description = "Blob container on the shared storage account for load-test artifacts. Null uses 'lt-artifacts'."
  type        = string
  default     = null
}

variable "lt_max_executions" {
  description = "Maximum parallel Container Apps Job executions (global concurrency cap). PRD guardrail: 1–2; default 2."
  type        = number
  default     = 2

  validation {
    condition     = var.lt_max_executions >= 1 && var.lt_max_executions <= 2
    error_message = "lt_max_executions must be 1 or 2 (PRD platform concurrency guardrail)."
  }
}

variable "lt_acr_name" {
  description = "Azure Container Registry name for apex-lt-k6 images (alphanumeric only). Null derives acrapexlt{environment}."
  type        = string
  default     = null
}

variable "lt_acr_push_principal_ids" {
  description = "Entra object IDs granted AcrPush on the load-test ACR (typically the GitHub Actions deploy service principal)."
  type        = list(string)
  default     = []
}

variable "lt_enable_staging_slot_rbac" {
  description = "Grant the staging slot identity permission to send load-test jobs and read load-test artifacts. Disable where the Terraform principal cannot manage role assignments or staging load tests are not required."
  type        = bool
  default     = true
}

variable "lt_runner_image" {
  description = "Fully-qualified runner image reference including digest for supply-chain pinning (e.g. <acr>.azurecr.io/apex-lt-k6:<tag>@sha256:<digest>). Placeholder until CI publishes the first image; job image updates from CI are ignored by Terraform lifecycle."
  type        = string
  default     = "grafana/k6:latest"
}

variable "lt_runner_cpu" {
  description = "CPU cores allocated per runner execution (supports up to 5000 VUs; default 2.0)."
  type        = number
  default     = 2.0
}

variable "lt_runner_memory" {
  description = "Memory (GiB string) allocated per runner execution (default '4Gi')."
  type        = string
  default     = "4Gi"
}

variable "lt_vnet_subnet_id" {
  description = "Subnet resource ID for VNet-integrated Container Apps Environment. Required for non-prod target reachability (A-007). Null disables VNet integration for initial stand-up."
  type        = string
  default     = null
}

variable "lt_key_vault_id" {
  description = "Key Vault resource ID for runner secret injection. When set, grants the runner MI 'Key Vault Secrets User' on this vault. Null skips the role assignment."
  type        = string
  default     = null
}

variable "lt_apex_callback_base_url" {
  description = "Fallback Apex API base URL for runner callbacks (dispatch message callbackBaseUrl takes precedence). E.g. https://app-apex-prd.azurewebsites.net."
  type        = string
  default     = ""
}

variable "lt_callback_token_audience" {
  description = "AAD App ID URI for load-test ingest MI JWTs (long-term). Null derives api://apex-lt-ingest-{environment} when lt_enable_entra_ingest_app is true."
  type        = string
  default     = null
}

variable "lt_enable_entra_ingest_app" {
  description = "When true, Terraform creates the dedicated apex-lt-ingest Entra app + LoadTest.Runner role assignment (requires Graph Application.ReadWrite.*). Default false — use LT_RUNNER_CALLBACK_TOKEN short-term."
  type        = bool
  default     = false
}

variable "lt_runner_callback_token" {
  description = "Shared bearer token for runner→Apex ingest (short-term). When set, wired into the Container Apps Job secret. Prefer GitHub secret LT_RUNNER_CALLBACK_TOKEN for App Service via deploy pipeline."
  type        = string
  sensitive   = true
  default     = null
}
