# Resource Group
resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = merge(var.tags, { Environment = var.environment })
}

locals {
  app_service_location           = coalesce(var.app_service_location, var.location)
  app_service_workers            = coalesce(var.app_service_worker_count, var.app_service_zone_redundant ? 3 : 1)
  use_dedicated_app_rg           = var.app_service_resource_group_name != null
  app_resource_group_name        = local.use_dedicated_app_rg ? var.app_service_resource_group_name : azurerm_resource_group.main.name
  postgresql_resource_group_name = coalesce(var.postgresql_resource_group_name, var.resource_group_name)
}

# Dedicated App Service RG in the app region (required for zone-redundant P1v3 when main RG is elsewhere).
resource "azurerm_resource_group" "app" {
  count    = local.use_dedicated_app_rg ? 1 : 0
  name     = var.app_service_resource_group_name
  location = local.app_service_location
  tags     = merge(var.tags, { Environment = var.environment })
}

# App Service Plan
resource "azurerm_service_plan" "main" {
  name                   = var.app_service_plan_name
  location               = local.app_service_location
  resource_group_name    = local.app_resource_group_name
  os_type                = "Linux"
  sku_name               = var.app_service_plan_sku
  zone_balancing_enabled = var.app_service_zone_redundant
  worker_count           = local.app_service_workers
  tags                   = merge(var.tags, { Environment = var.environment })

  lifecycle {
    create_before_destroy = true
    # When autoscale manages the plan it owns the live instance count; ignore it
    # here so Terraform does not fight autoscale back to the static worker_count.
    ignore_changes = [worker_count]
  }
}

# CPU-based autoscale for the API plan. Optional; when disabled the plan runs at
# the static worker_count. Minimum stays >= worker_count so zone redundancy holds.
resource "azurerm_monitor_autoscale_setting" "main" {
  count               = var.enable_autoscale ? 1 : 0
  name                = "${var.app_service_plan_name}-autoscale"
  resource_group_name = local.app_resource_group_name
  location            = local.app_service_location
  target_resource_id  = azurerm_service_plan.main.id
  tags                = merge(var.tags, { Environment = var.environment })

  profile {
    name = "cpu-autoscale"

    capacity {
      minimum = var.autoscale_min_capacity
      maximum = var.autoscale_max_capacity
      default = var.autoscale_default_capacity
    }

    rule {
      metric_trigger {
        metric_name        = "CpuPercentage"
        metric_resource_id = azurerm_service_plan.main.id
        time_grain         = "PT1M"
        statistic          = "Average"
        time_window        = "PT10M"
        time_aggregation   = "Average"
        operator           = "GreaterThan"
        threshold          = var.autoscale_cpu_scale_out_threshold
      }

      scale_action {
        direction = "Increase"
        type      = "ChangeCount"
        value     = "1"
        cooldown  = "PT5M"
      }
    }

    rule {
      metric_trigger {
        metric_name        = "CpuPercentage"
        metric_resource_id = azurerm_service_plan.main.id
        time_grain         = "PT1M"
        statistic          = "Average"
        time_window        = "PT10M"
        time_aggregation   = "Average"
        operator           = "LessThan"
        threshold          = var.autoscale_cpu_scale_in_threshold
      }

      scale_action {
        direction = "Decrease"
        type      = "ChangeCount"
        value     = "1"
        cooldown  = "PT10M"
      }
    }
  }
}

# App Service
resource "azurerm_linux_web_app" "main" {
  name                = var.app_service_name
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
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
    "WEBSITE_NODE_DEFAULT_VERSION"        = "20-lts"
    "NODE_ENV"                            = "production"
    "PORT"                                = var.port
    "SCM_DO_BUILD_DURING_DEPLOYMENT"      = "false"
    "ENABLE_ORYX_BUILD"                   = "false"
    "WEBSITE_RUN_FROM_PACKAGE"            = "1"
    "WEBSITES_ENABLE_APP_SERVICE_STORAGE" = "true"

    # Observability
    "APPLICATIONINSIGHTS_CONNECTION_STRING" = azurerm_application_insights.main.connection_string

    # Database
    "DATABASE_URL" = "postgresql://${var.postgresql_admin_username}:${var.postgresql_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgresql_database_name}?sslmode=require"

    # Azure DevOps
    "ADO_ORG"              = var.ado_org
    "ADO_PAT"              = var.ado_pat
    "ADO_PROJECT"          = var.ado_project
    "ADO_AREA_PATH"        = var.ado_area_path
    "ADO_ALLOWED_PROJECTS" = var.ado_allowed_projects

    # Vite / client-side
    "VITE_ADO_ORG"     = var.ado_org
    "VITE_ADO_PROJECT" = var.ado_project
    "VITE_TEAMS"       = var.vite_teams

    # Azure AD auth
    "AZURE_TENANT_ID"     = var.azure_tenant_id
    "AZURE_CLIENT_ID"     = var.azure_client_id
    "AZURE_CLIENT_SECRET" = var.azure_client_secret
    "AZURE_REDIRECT_URL"  = var.azure_redirect_url
    "SESSION_SECRET"      = var.session_secret

    # Azure Cost Management
    "AZURE_COST_TENANT_ID"     = var.azure_cost_tenant_id
    "AZURE_COST_CLIENT_ID"     = var.azure_cost_client_id
    "AZURE_COST_CLIENT_SECRET" = var.azure_cost_client_secret

    # AWS Bedrock
    "AWS_ACCESS_KEY_ID"     = var.aws_access_key_id
    "AWS_SECRET_ACCESS_KEY" = var.aws_secret_access_key
    "AWS_REGION"            = var.aws_region
    "BEDROCK_MODEL_ID"      = var.bedrock_model_id

    # Cursor
    "CURSOR_API_KEY"      = var.cursor_api_key
    "CURSOR_TEAM_API_KEY" = var.cursor_team_api_key

    # SendGrid
    "SENDGRID_API_KEY" = var.sendgrid_api_key

    # Polling
    "POLL_INTERVAL" = var.poll_interval
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

  # Runtime config (app settings, startup command, node runtime, affinity) is managed by
  # .github/workflows/deploy.yml after provision — keep Terraform from drifting.
  lifecycle {
    create_before_destroy = true
    ignore_changes = [
      app_settings,
      site_config[0].app_command_line,
      site_config[0].application_stack,
      client_affinity_enabled,
      tags,
      identity,
    ]
  }
}

# Staging slot for blue-green deployments (deploy here, then swap into production).
resource "azurerm_linux_web_app_slot" "staging" {
  count          = var.enable_staging_slot ? 1 : 0
  name           = var.staging_slot_name
  app_service_id = azurerm_linux_web_app.main.id
  https_only     = true
  tags           = merge(var.tags, { Environment = var.environment, Slot = var.staging_slot_name })

  site_config {
    always_on = true

    application_stack {
      node_version = "20-lts"
    }

    app_command_line = "npm start"
  }

  lifecycle {
    ignore_changes = [
      app_settings,
      site_config[0].app_command_line,
      site_config[0].application_stack,
      client_affinity_enabled,
      tags,
    ]
  }
}

# PostgreSQL Flexible Server
resource "azurerm_postgresql_flexible_server" "main" {
  name                   = var.postgresql_server_name
  location               = var.postgresql_location
  resource_group_name    = local.postgresql_resource_group_name
  version                = "16"
  administrator_login    = var.postgresql_admin_username
  administrator_password = var.postgresql_admin_password
  sku_name               = var.postgresql_sku_name
  storage_mb             = 32768
  backup_retention_days  = 7
  zone                   = var.postgresql_availability_zone
  tags                   = merge(var.tags, { Environment = var.environment })

  dynamic "high_availability" {
    for_each = var.postgresql_high_availability_mode != null ? [1] : []
    content {
      mode                      = var.postgresql_high_availability_mode
      standby_availability_zone = var.postgresql_standby_availability_zone
    }
  }

  lifecycle {
    ignore_changes = [tags]
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
