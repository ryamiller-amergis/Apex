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
  description = "App Service plan worker count / floor. Use 3 when app_service_zone_redundant is true. When autoscale is enabled this is the starting count; live capacity is managed by autoscale."
  type        = number
  default     = null
}

variable "enable_autoscale" {
  description = "Create a CPU-based autoscale setting for the App Service plan. Requires a Standard/Premium plan. Keep the minimum >= 3 when zone redundancy is enabled."
  type        = bool
  default     = false
}

variable "autoscale_min_capacity" {
  description = "Minimum App Service instances under autoscale. Must be >= 3 when app_service_zone_redundant is true."
  type        = number
  default     = 3
}

variable "autoscale_max_capacity" {
  description = "Maximum App Service instances autoscale may scale out to."
  type        = number
  default     = 6

  validation {
    condition     = var.autoscale_max_capacity >= var.autoscale_min_capacity
    error_message = "autoscale_max_capacity must be >= autoscale_min_capacity."
  }
}

variable "autoscale_default_capacity" {
  description = "Instance count autoscale falls back to when metrics are unavailable."
  type        = number
  default     = 3
}

variable "autoscale_cpu_scale_out_threshold" {
  description = "Average CPU percentage over the evaluation window that triggers a scale-out."
  type        = number
  default     = 70
}

variable "autoscale_cpu_scale_in_threshold" {
  description = "Average CPU percentage below which autoscale scales in."
  type        = number
  default     = 30
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
  description = "Globally unique shared Storage Account for private async artifacts. A deterministic name is generated when null."
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
