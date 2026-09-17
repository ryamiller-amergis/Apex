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

  # AI-run materialization and Container Apps actors must see one checkout
  # tree. Mount only the workspace subdirectory, not the complete Apex data root.
  storage_account {
    name         = "ai-runs-workspaces"
    type         = "AzureFiles"
    account_name = azurerm_storage_account.shared.name
    share_name   = azurerm_storage_share.ai_runs_workspace.name
    access_key   = azurerm_storage_account.shared.primary_access_key
    mount_path   = var.ai_runs_workspace_mount_path
  }

  site_config {
    always_on = true

    # The plan runs multiple instances, so without this a wedged instance keeps
    # serving traffic instead of being pulled from rotation. Set live but never
    # declared here, which meant a full apply would quietly remove it.
    health_check_path = "/api/health"

    # Required for the FEAT-007 interactive WebSocket gateway (client ↔ gateway
    # upgrade). Declared explicitly so a full apply never reverts the runtime
    # enablement to the azurerm default (false), which would silently break
    # real-time chat streaming.
    websockets_enabled = true

    # Node 24 is configured by deploy.yml. AzureRM 3.x cannot represent 24-lts
    # in application_stack, so Terraform intentionally does not declare it.
    app_command_line = "npm start"
  }

  app_settings = {
    # Node / build
    "WEBSITE_NODE_DEFAULT_VERSION"        = "24-lts"
    "NODE_ENV"                            = "production"
    "PORT"                                = var.port
    "SCM_DO_BUILD_DURING_DEPLOYMENT"      = "false"
    "ENABLE_ORYX_BUILD"                   = "false"
    "WEBSITE_RUN_FROM_PACKAGE"            = "1"
    "WEBSITES_ENABLE_APP_SERVICE_STORAGE" = "true"

    # Observability
    "APPLICATIONINSIGHTS_CONNECTION_STRING" = azurerm_application_insights.main.connection_string

    # PDF artifacts (managed identity; no storage keys)
    "PDF_BLOB_ACCOUNT_NAME"   = azurerm_storage_account.shared.name
    "PDF_BLOB_CONTAINER_NAME" = azurerm_storage_container.shared[var.pdf_blob_container_name].name

    # Repository grounding bundles (managed identity; no storage keys)
    "GROUNDING_BLOB_ACCOUNT_NAME"   = azurerm_storage_account.shared.name
    "GROUNDING_BLOB_CONTAINER_NAME" = azurerm_storage_container.shared["repo-grounding"].name

    # Repo read service (null/empty while enable_repo_read_service is false)
    "REPO_READ_SERVICE_URL"   = try("https://${azurerm_container_app.repo_read_service[0].ingress[0].fqdn}", "")
    "REPO_READ_SERVICE_TOKEN" = var.enable_repo_read_service ? coalesce(var.ai_runs_runner_callback_token, "") : ""

    # Database
    "DATABASE_URL" = "postgresql://${var.postgresql_admin_username}:${var.postgresql_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgresql_database_name}?sslmode=require"

    # Azure DevOps
    "ADO_ORG"              = var.ado_org
    "ADO_PAT"              = var.ado_pat
    "ADO_PROJECT"          = var.ado_project
    "ADO_AREA_PATH"        = var.ado_area_path
    "ADO_ALLOWED_PROJECTS" = var.ado_allowed_projects

    # GitHub (skill catalog + repo checkout). Copy the live App Service
    # GITHUB_ORG / GITHUB_TOKEN values. ignore_changes on app_settings means
    # deploy.yml remains the runtime writer after first apply.
    "GITHUB_ORG"   = var.github_org
    "GITHUB_TOKEN" = coalesce(var.github_token, "")

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

  # Keep environment-specific values with their deployment slot during swaps.
  # Anything not listed here travels with the code when the slots swap, so a
  # value tuned for production lands on staging and staging's lands on
  # production. Order mirrors the order Azure returns these so the plan stays
  # free of list-ordering churn.
  sticky_settings {
    app_setting_names = compact([
      "APEX_URL",
      "APPLICATIONINSIGHTS_CONNECTION_STRING",
      "AZURE_REDIRECT_URL",
      # Each slot carries its own connection string and its own pool ceiling.
      # A swap that traded these would point production at staging's database
      # and shrink its pool to staging's size.
      "DATABASE_URL",
      var.enable_staging_slot ? "LT_APEX_CALLBACK_BASE_URL" : null,
      "DB_POOL_MAX",
      # How long a background run may wait for a worker before it is failed as
      # queue_ttl. Approving a PRD submits one run per feature against a lane
      # that runs ten at a time, so the legitimate wait scales with the feature
      # count and the default 30m expires runs no worker had reached yet.
      "AI_RUNS_BACKGROUND_QUEUE_TTL_MS",
      # Temporary v1 safety bound: production observed a healthy worker finish
      # shortly after the former 90s reaper threshold. Keep this with each slot
      # until V2 confirms worker loss through checkpoints plus platform status.
      "AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS",
    ])
  }

  logs {
    detailed_error_messages = true
    failed_request_tracing  = true

    dynamic "application_logs" {
      for_each = var.environment == "dev" ? [1] : []

      content {
        file_system_level = "Information"
      }
    }

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

  # Slot identities are not swapped with application code. Keep a dedicated
  # system identity on staging so pre-swap PDF smoke tests retain managed-
  # identity access to the production shared Blob account.
  identity {
    type = "SystemAssigned"
  }

  # Staging uses the same durable checkout tree during pre-swap validation.
  storage_account {
    name         = "ai-runs-workspaces"
    type         = "AzureFiles"
    account_name = azurerm_storage_account.shared.name
    share_name   = azurerm_storage_share.ai_runs_workspace.name
    access_key   = azurerm_storage_account.shared.primary_access_key
    mount_path   = var.ai_runs_workspace_mount_path
  }

  site_config {
    always_on = true

    # Azure takes an unhealthy instance out of rotation only when it has a path
    # to probe. Without this a full apply strips the probe from the slot that
    # pre-swap validation runs against.
    health_check_path = "/api/health"

    # Same as production: keep the WebSocket upgrade enabled so a post-swap
    # staging slot serves the interactive gateway identically (and a full apply
    # never flips it off).
    websockets_enabled = true

    # Node 24 is configured by deploy.yml; see the main app comment above.
    app_command_line = "npm start"
  }

  # Mirror the production web app's logging so the slot is fully declared (no
  # undeclared drift) and converges any leftover manual debug logging to the
  # standard config on the next apply. Diagnostic only — not a runtime pointer.
  logs {
    detailed_error_messages = true
    failed_request_tracing  = true

    dynamic "application_logs" {
      for_each = var.environment == "dev" ? [1] : []

      content {
        file_system_level = "Information"
      }
    }

    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
  }

  lifecycle {
    ignore_changes = [
      app_settings,
      site_config[0].app_command_line,
      site_config[0].application_stack,
      client_affinity_enabled,
      tags,
      # Filesystem application logging is a short-lived debugging toggle that
      # gets switched on by hand and that Azure disables again on its own.
      # Pinning a value here would just trade one direction of drift for the
      # other, so leave whatever is set alone.
      logs[0].application_logs,
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
    # Availability-zone placement is fixed when the server is created. Preserve
    # the existing zone when an environment does not explicitly pass the value.
    ignore_changes = [tags, zone]
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
