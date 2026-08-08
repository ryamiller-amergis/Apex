# AI Runs background worker infrastructure — FEAT-003 / TBI-003 / PBI-003
#
# Provisions the shared Service Bus namespace for AI run lanes, the
# ai-runs-background queue, a KEDA-scaled ephemeral Container Apps Job,
# runner managed identity, queue-scoped RBAC, Azure Files workspace mount,
# and Key Vault / ACR access. Reuses the load-test ACR (apex-ai-runs repo).
#
# Isolation driver: accepted ADR scale-up path for background AI execution
# (azure-async-infra: Service Bus only when ADR requires a managed broker).
# Dedicated load-test namespace (sbns-apex-lt-*) remains separate.
#
# Identity model:
#   ai_runs_runner MI — Job executor: queue receive, Key Vault Secrets User,
#                       AcrPull (apex-ai-runs images), AiRun.Runner (entra.tf)
#   Apex API MI       — App Service system identity: queue send only
#
# Naming: {type}-apex-ai-{environment} / caj-apex-ai-runs-{environment}

locals {
  ai_runs_namespace_name   = coalesce(var.ai_runs_servicebus_namespace_name, "sbns-apex-ai-${var.environment}")
  ai_runs_queue_name       = coalesce(var.ai_runs_background_queue_name, "ai-runs-background")
  ai_runs_cae_name         = coalesce(var.ai_runs_container_app_env_name, "cae-apex-ai-${var.environment}")
  ai_runs_job_name         = coalesce(var.ai_runs_container_app_job_name, "caj-apex-ai-runs-${var.environment}")
  ai_runs_runner_mi_name   = coalesce(var.ai_runs_runner_identity_name, "mi-apex-ai-runs-runner-${var.environment}")
  ai_runs_file_share       = coalesce(var.ai_runs_file_share_name, "ai-pilot-data")
  ai_runs_image_repository = "apex-ai-runs"
  ai_runs_key_vault_name   = coalesce(var.ai_runs_key_vault_name, "kv-apex-ai-${var.environment}")

  # dirname() follows the Terraform host OS — on Windows it turns
  # "/home/data/ai-pilot/workspaces" into "\\home\\data\\ai-pilot". Keep the
  # Unix parent path intact for Container Apps / App Service mounts.
  ai_runs_data_dir = regex("^(.*)/[^/]+/?$", var.ai_runs_workspace_mount_path)[0]

  ai_runs_runner_principal_id = azurerm_user_assigned_identity.ai_runs_runner.principal_id
  ai_runs_key_vault_id = var.ai_runs_key_vault_id != null ? (
    var.ai_runs_key_vault_id
    ) : (
    azurerm_key_vault.ai_runs[0].id
  )
  ai_runs_cursor_api_key_secret_id = var.ai_runs_cursor_api_key_secret_id != null ? (
    var.ai_runs_cursor_api_key_secret_id
    ) : (
    try(azurerm_key_vault_secret.ai_runs_cursor_api_key[0].id, null)
  )
}

data "azurerm_client_config" "current" {}

# ---------------------------------------------------------------------------
# Shared Service Bus namespace — AI run lanes (background now; interactive later)
# ---------------------------------------------------------------------------

resource "azurerm_servicebus_namespace" "ai_runs" {
  name                = local.ai_runs_namespace_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"
  tags                = merge(var.tags, { Environment = var.environment, Workload = "ai-runs" })
}

resource "azurerm_servicebus_queue" "ai_runs_background" {
  name         = local.ai_runs_queue_name
  namespace_id = azurerm_servicebus_namespace.ai_runs.id

  # Dead-lettering for poison messages (DoD-0).
  max_delivery_count                   = 5
  dead_lettering_on_message_expiration = true

  # Max Service Bus lock duration (5m); SDKs renew during long runs.
  lock_duration = "PT5M"
}

# KEDA scaler auth — queue-scoped Manage SAS for queue-length polling only.
# Message *receive* stays on the runner MI (Azure Service Bus Data Receiver).
# azurerm ~> 3.0 cannot set scale-rule identity_id (needs >= 4.73).
resource "azurerm_servicebus_queue_authorization_rule" "ai_runs_keda" {
  name     = "ai-runs-keda-manage"
  queue_id = azurerm_servicebus_queue.ai_runs_background.id

  listen = true
  send   = true
  manage = true
}

# ---------------------------------------------------------------------------
# Runner user-assigned managed identity
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "ai_runs_runner" {
  name                = local.ai_runs_runner_mi_name
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
  tags                = merge(var.tags, { Environment = var.environment, Workload = "ai-runs" })
}

# ---------------------------------------------------------------------------
# Dedicated Key Vault + CURSOR_API_KEY (unless existing IDs are supplied)
# ---------------------------------------------------------------------------

resource "azurerm_key_vault" "ai_runs" {
  count = var.ai_runs_key_vault_id == null ? 1 : 0

  name                       = local.ai_runs_key_vault_name
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = var.azure_tenant_id
  sku_name                   = "standard"
  enable_rbac_authorization  = true
  soft_delete_retention_days = 90
  purge_protection_enabled   = var.environment == "prd"

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-runs" })
}

# Terraform needs data-plane permission to seed CURSOR_API_KEY. This role is
# scoped to the dedicated vault and is not created when existing vault IDs are used.
resource "azurerm_role_assignment" "ai_runs_deployer_kv_secrets_officer" {
  count = var.ai_runs_key_vault_id == null ? 1 : 0

  scope                = azurerm_key_vault.ai_runs[0].id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_key_vault_secret" "ai_runs_cursor_api_key" {
  count = var.ai_runs_key_vault_id == null && var.ai_runs_cursor_api_key_secret_id == null ? 1 : 0

  name         = "cursor-api-key"
  value        = var.cursor_api_key
  key_vault_id = azurerm_key_vault.ai_runs[0].id
  content_type = "Apex AI-runs worker Cursor API key"

  depends_on = [azurerm_role_assignment.ai_runs_deployer_kv_secrets_officer]
}

# ---------------------------------------------------------------------------
# RBAC — runner MI (queue receive + Key Vault + AcrPull on load-test ACR)
# ---------------------------------------------------------------------------

resource "azurerm_role_assignment" "ai_runs_runner_sb_receiver" {
  scope                = azurerm_servicebus_queue.ai_runs_background.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = local.ai_runs_runner_principal_id
}

resource "azurerm_role_assignment" "ai_runs_runner_kv_secrets_user" {
  scope                = local.ai_runs_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = local.ai_runs_runner_principal_id
}

# Reuse load-test ACR; CI publishes apex-ai-runs alongside apex-lt-k6.
resource "azurerm_role_assignment" "ai_runs_runner_acr_pull" {
  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPull"
  principal_id         = local.ai_runs_runner_principal_id
}

# ---------------------------------------------------------------------------
# RBAC — Apex API identity (queue send only; no receive)
# ---------------------------------------------------------------------------

resource "azurerm_role_assignment" "ai_runs_api_sb_sender" {
  scope                = azurerm_servicebus_queue.ai_runs_background.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "ai_runs_staging_sb_sender" {
  count = var.enable_staging_slot && var.ai_runs_enable_staging_slot_rbac ? 1 : 0

  scope                = azurerm_servicebus_queue.ai_runs_background.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app_slot.staging[0].identity[0].principal_id
}

# ---------------------------------------------------------------------------
# Azure Files share for pinned workspaces (mounted at resolveDataRoot/workspaces
# by App Service, the background Job, and the interactive actor host)
# ---------------------------------------------------------------------------

resource "azurerm_storage_share" "ai_runs_workspace" {
  name                 = local.ai_runs_file_share
  storage_account_name = azurerm_storage_account.shared.name
  quota                = var.ai_runs_file_share_quota_gb
}

# ---------------------------------------------------------------------------
# Container Apps Environment + File storage binding
# ---------------------------------------------------------------------------

resource "azurerm_container_app_environment" "ai_runs" {
  name                = local.ai_runs_cae_name
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name

  infrastructure_subnet_id       = var.ai_runs_vnet_subnet_id != null ? var.ai_runs_vnet_subnet_id : null
  internal_load_balancer_enabled = var.ai_runs_vnet_subnet_id != null ? true : null

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-runs" })
}

resource "azurerm_container_app_environment_storage" "ai_runs_workspace" {
  name                         = "ai-runs-workspace"
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id
  account_name                 = azurerm_storage_account.shared.name
  share_name                   = azurerm_storage_share.ai_runs_workspace.name
  access_key                   = azurerm_storage_account.shared.primary_access_key
  access_mode                  = "ReadWrite"
}

# ---------------------------------------------------------------------------
# Container Apps Job — KEDA azure-servicebus scaler, one message → one Job
# max_executions bound to ai_runs_max_in_flight (BR-003 / PBI-003 AC-2)
# ---------------------------------------------------------------------------

resource "azurerm_container_app_job" "ai_runs_runner" {
  name                         = local.ai_runs_job_name
  location                     = local.app_service_location
  resource_group_name          = local.app_resource_group_name
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id

  # Wall-clock guard for a single background generation (cold-start + run).
  replica_timeout_in_seconds = 3600

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ai_runs_runner.id]
  }

  registry {
    server   = azurerm_container_registry.lt.login_server
    identity = azurerm_user_assigned_identity.ai_runs_runner.id
  }

  secret {
    name  = "ai-runs-keda-sb-connection"
    value = azurerm_servicebus_queue_authorization_rule.ai_runs_keda.primary_connection_string
  }

  dynamic "secret" {
    for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
    content {
      name  = "ai-runs-runner-callback-token"
      value = var.ai_runs_runner_callback_token
    }
  }

  dynamic "secret" {
    for_each = local.ai_runs_cursor_api_key_secret_id != null ? [1] : []
    content {
      name                = "cursor-api-key"
      key_vault_secret_id = local.ai_runs_cursor_api_key_secret_id
      identity            = azurerm_user_assigned_identity.ai_runs_runner.id
    }
  }

  event_trigger_config {
    parallelism              = 1
    replica_completion_count = 1

    scale {
      min_executions = 0
      max_executions = var.ai_runs_max_in_flight

      rules {
        name             = "ai-runs-servicebus-keda"
        custom_rule_type = "azure-servicebus"

        metadata = {
          queueName    = local.ai_runs_queue_name
          namespace    = azurerm_servicebus_namespace.ai_runs.name
          messageCount = "1"
        }

        authentication {
          secret_name       = "ai-runs-keda-sb-connection"
          trigger_parameter = "connection"
        }
      }
    }
  }

  template {
    volume {
      name         = "ai-pilot-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.ai_runs_workspace.name
    }

    container {
      name   = "ai-runs-runner"
      image  = var.ai_runs_runner_image
      cpu    = var.ai_runs_runner_cpu
      memory = var.ai_runs_runner_memory

      volume_mounts {
        name = "ai-pilot-data"
        path = var.ai_runs_workspace_mount_path
      }

      env {
        name  = "APEX_CALLBACK_URL"
        value = var.ai_runs_apex_callback_base_url
      }

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.ai_runs_runner.client_id
      }

      env {
        name  = "AZURE_TENANT_ID"
        value = var.azure_tenant_id
      }

      env {
        name  = "AI_RUNS_SERVICEBUS_NAMESPACE"
        value = azurerm_servicebus_namespace.ai_runs.name
      }

      env {
        name  = "AI_RUNS_BACKGROUND_QUEUE_NAME"
        value = azurerm_servicebus_queue.ai_runs_background.name
      }

      env {
        name  = "AI_RUNS_BACKGROUND_INFLIGHT_LIMIT"
        value = tostring(var.ai_runs_max_in_flight)
      }

      env {
        name  = "AI_PILOT_DATA_DIR"
        value = local.ai_runs_data_dir
      }

      dynamic "env" {
        for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
        content {
          name        = "AI_RUNS_RUNNER_CALLBACK_TOKEN"
          secret_name = "ai-runs-runner-callback-token"
        }
      }

      dynamic "env" {
        for_each = var.enable_ai_runs_entra_app || var.ai_runs_callback_token_audience != null ? [1] : []
        content {
          name  = "AI_RUNS_CALLBACK_TOKEN_AUDIENCE"
          value = local.ai_runs_ingest_identifier_uri
        }
      }

      dynamic "env" {
        for_each = local.ai_runs_cursor_api_key_secret_id != null ? [1] : []
        content {
          name        = "CURSOR_API_KEY"
          secret_name = "cursor-api-key"
        }
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-runs" })

  lifecycle {
    precondition {
      condition = (
        var.ai_runs_key_vault_id == null
        && var.ai_runs_cursor_api_key_secret_id == null
        ) || (
        var.ai_runs_key_vault_id != null
        && var.ai_runs_cursor_api_key_secret_id != null
      )
      error_message = "Set both ai_runs_key_vault_id and ai_runs_cursor_api_key_secret_id to use an existing vault, or leave both null to provision the dedicated Apex vault."
    }

    ignore_changes = [
      template[0].container[0].image,
    ]
  }

  depends_on = [azurerm_role_assignment.ai_runs_runner_kv_secrets_user]
}
