# Container Apps Job for My Work cloud-agent runs.
#
# Dev only. Apex starts one execution per Start cloud agent click and overrides
# the command to /usr/local/bin/cursor-run-cli. There is no pool controller.
#
# The worker image contains the Cursor `agent` CLI and git. The Key Vault
# secret referenced by local.ai_runs_cursor_api_key_secret_id must contain a
# Cursor API key the CLI can use.

locals {
  cursor_pool_enabled         = var.enable_cursor_pool_workers && var.environment == "dev"
  cursor_pool_name            = coalesce(var.cursor_pool_name, "apex-my-work")
  cursor_pool_worker_job_name = coalesce(var.cursor_pool_worker_job_name, "caj-apex-cursor-worker-${var.environment}")
  cursor_pool_worker_mi       = coalesce(var.cursor_pool_worker_identity_name, "mi-apex-cursor-worker-${var.environment}")
  cursor_pool_clone_flag      = var.cursor_pool_clone_git_repos ? "--clone-git-repos" : ""
}

resource "azurerm_user_assigned_identity" "cursor_pool_worker" {
  count = local.cursor_pool_enabled ? 1 : 0

  name                = local.cursor_pool_worker_mi
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
  tags                = merge(var.tags, { Environment = var.environment, Workload = "cursor-pool-worker" })
}

resource "azurerm_role_assignment" "cursor_pool_worker_acr_pull" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.cursor_pool_worker[0].principal_id
}

resource "azurerm_role_assignment" "cursor_pool_worker_kv_secrets_user" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope                = local.ai_runs_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.cursor_pool_worker[0].principal_id
}

# Manual Job. Apex replaces the command, image, and env for each execution.
# The command below is only the idle template. Worker source lives on
# ephemeral storage; the shared Azure Files checkout is not mounted.
resource "azurerm_container_app_job" "cursor_pool_worker" {
  count = local.cursor_pool_enabled ? 1 : 0

  name                         = local.cursor_pool_worker_job_name
  location                     = local.app_service_location
  resource_group_name          = local.app_resource_group_name
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id
  replica_timeout_in_seconds   = var.cursor_pool_worker_timeout_seconds
  replica_retry_limit          = 1

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.cursor_pool_worker[0].id]
  }

  registry {
    server   = azurerm_container_registry.lt.login_server
    identity = azurerm_user_assigned_identity.cursor_pool_worker[0].id
  }

  secret {
    name                = "cursor-api-key"
    key_vault_secret_id = local.ai_runs_cursor_api_key_secret_id
    identity            = azurerm_user_assigned_identity.cursor_pool_worker[0].id
  }

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name   = "cursor-pool-worker"
      image  = var.cursor_pool_worker_image
      cpu    = var.cursor_pool_worker_cpu
      memory = var.cursor_pool_worker_memory

      command = ["/bin/sh", "-lc"]
      args = [
        "exec agent worker --pool \"$CURSOR_WORKER_POOL_NAME\" --management-addr \":8080\" --idle-release-timeout \"$CURSOR_WORKER_IDLE_RELEASE_TIMEOUT\" ${local.cursor_pool_clone_flag} start"
      ]

      env {
        name        = "CURSOR_API_KEY"
        secret_name = "cursor-api-key"
      }

      env {
        name  = "CURSOR_WORKER_POOL_NAME"
        value = local.cursor_pool_name
      }

      env {
        name  = "CURSOR_WORKER_IDLE_RELEASE_TIMEOUT"
        value = tostring(var.cursor_pool_worker_idle_release_seconds)
      }

      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "cursor-pool-worker" })

  lifecycle {
    precondition {
      condition     = local.ai_runs_cursor_api_key_secret_id != null
      error_message = "Cursor pool workers require the AI-runs Cursor API key secret ID."
    }

    ignore_changes = [
      template[0].container[0].image,
    ]
  }

  depends_on = [
    azurerm_role_assignment.cursor_pool_worker_acr_pull,
    azurerm_role_assignment.cursor_pool_worker_kv_secrets_user,
  ]
}
