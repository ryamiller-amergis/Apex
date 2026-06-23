# Resource Group
resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = merge(var.tags, { Environment = var.environment })
}

# App Service Plan
resource "azurerm_service_plan" "main" {
  name                = var.app_service_plan_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = "B1" # Basic tier - can be upgraded to S1, P1v2, etc.
  tags                = merge(var.tags, { Environment = var.environment })
}

# App Service
resource "azurerm_linux_web_app" "main" {
  name                = var.app_service_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  service_plan_id     = azurerm_service_plan.main.id
  https_only          = true
  tags                = merge(var.tags, { Environment = var.environment })

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on = true
    
    application_stack {
      node_version = "20-lts"
    }

    # Enable local logging
    app_command_line = "npm start"
  }

  app_settings = {
    # Node / build
    "WEBSITE_NODE_DEFAULT_VERSION"           = "20-lts"
    "NODE_ENV"                               = "production"
    "PORT"                                   = var.port
    "SCM_DO_BUILD_DURING_DEPLOYMENT"         = "false"
    "ENABLE_ORYX_BUILD"                      = "false"
    "WEBSITE_RUN_FROM_PACKAGE"               = "1"
    "WEBSITES_ENABLE_APP_SERVICE_STORAGE"    = "true"

    # Observability
    "APPLICATIONINSIGHTS_CONNECTION_STRING"  = azurerm_application_insights.main.connection_string

    # Database
    "DATABASE_URL"                           = "postgresql://${var.postgresql_admin_username}:${var.postgresql_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgresql_database_name}?sslmode=require"

    # Azure DevOps
    "ADO_ORG"                                = var.ado_org
    "ADO_PAT"                                = var.ado_pat
    "ADO_PROJECT"                            = var.ado_project
    "ADO_AREA_PATH"                          = var.ado_area_path
    "ADO_ALLOWED_PROJECTS"                   = var.ado_allowed_projects

    # Vite / client-side
    "VITE_ADO_ORG"                           = var.ado_org
    "VITE_ADO_PROJECT"                       = var.ado_project
    "VITE_TEAMS"                             = var.vite_teams

    # Azure AD auth
    "AZURE_TENANT_ID"                        = var.azure_tenant_id
    "AZURE_CLIENT_ID"                        = var.azure_client_id
    "AZURE_CLIENT_SECRET"                    = var.azure_client_secret
    "AZURE_REDIRECT_URL"                     = var.azure_redirect_url
    "SESSION_SECRET"                         = var.session_secret

    # Azure Cost Management
    "AZURE_COST_TENANT_ID"                   = var.azure_cost_tenant_id
    "AZURE_COST_CLIENT_ID"                   = var.azure_cost_client_id
    "AZURE_COST_CLIENT_SECRET"               = var.azure_cost_client_secret

    # AWS Bedrock
    "AWS_ACCESS_KEY_ID"                      = var.aws_access_key_id
    "AWS_SECRET_ACCESS_KEY"                  = var.aws_secret_access_key
    "AWS_REGION"                             = var.aws_region
    "BEDROCK_MODEL_ID"                       = var.bedrock_model_id

    # Cursor
    "CURSOR_API_KEY"                         = var.cursor_api_key
    "CURSOR_TEAM_API_KEY"                    = var.cursor_team_api_key

    # SendGrid
    "SENDGRID_API_KEY"                       = var.sendgrid_api_key

    # Polling
    "POLL_INTERVAL"                          = var.poll_interval
  }

  logs {
    detailed_error_messages = true
    failed_request_tracing  = true

    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
  }
}

# PostgreSQL Flexible Server
resource "azurerm_postgresql_flexible_server" "main" {
  name                   = var.postgresql_server_name
  location               = var.postgresql_location
  resource_group_name    = azurerm_resource_group.main.name
  version                = "16"
  administrator_login    = var.postgresql_admin_username
  administrator_password = var.postgresql_admin_password
  sku_name               = var.postgresql_sku_name
  storage_mb             = 32768
  backup_retention_days  = 7
  tags                   = merge(var.tags, { Environment = var.environment })

  lifecycle {
    ignore_changes = [zone, tags]
  }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = var.postgresql_database_name
  server_id = azurerm_postgresql_flexible_server.main.id
  collation = "en_US.utf8"
  charset   = "utf8"
}

# Allow Azure services to connect to the PostgreSQL server
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

# Application Insights
resource "azurerm_application_insights" "main" {
  name                = "appi-${var.app_service_name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  application_type    = "Node.JS"
  tags                = merge(var.tags, { Environment = var.environment })

  lifecycle {
    ignore_changes = [workspace_id, tags]
  }
}
