variable "resource_group_name" {
  description = "Name of the Azure Resource Group"
  type        = string
  default     = "rg-scrum-mv"
}

variable "location" {
  description = "Azure region for resources"
  type        = string
  default     = "East US"
}

variable "app_service_name" {
  description = "Name of the App Service"
  type        = string
  default     = "app-scrum"
}

variable "app_service_plan_name" {
  description = "Name of the App Service Plan"
  type        = string
  default     = "plan-scrum"
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

variable "postgresql_server_name" {
  description = "Name of the PostgreSQL Flexible Server (must be globally unique)"
  type        = string
  default     = "psql-scrum-eus2"
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
  default     = "aipilot"
}

variable "postgresql_sku_name" {
  description = "SKU name for the PostgreSQL Flexible Server"
  type        = string
  default     = "B_Standard_B1ms"
}
