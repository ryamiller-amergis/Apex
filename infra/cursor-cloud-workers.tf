# Cursor self-hosted Team Pool for My Work development sessions.
#
# This stack is intentionally dev-only. It reuses cae-apex-ai-{environment}
# for networking/logging, but keeps Cursor controller and worker identities
# separate from the Apex AI-runs runner.
#
# Runtime contract:
# - The controller image contains the Cursor `agent` CLI, Azure CLI, and
#   /opt/cursor/spawn-aca-job.sh.
# - The spawn hook starts one execution of the manual Container Apps Job and
#   passes CURSOR_AGENT_WORKER_ID and CURSOR_POOL from the controller process
#   into that execution.
# - The worker image contains the Cursor `agent` CLI and git.
# - The Key Vault secret referenced by local.ai_runs_cursor_api_key_secret_id
#   must contain a Cursor service-account API key authorized for Team Pools.

locals {
  cursor_pool_enabled         = var.enable_cursor_pool_workers && var.environment == "dev"
  cursor_pool_name            = coalesce(var.cursor_pool_name, "apex-my-work")
  cursor_pool_controller_name = coalesce(var.cursor_pool_controller_app_name, "ca-apex-cursor-controller-${var.environment}")
  cursor_pool_worker_job_name = coalesce(var.cursor_pool_worker_job_name, "caj-apex-cursor-worker-${var.environment}")
  cursor_pool_controller_mi   = coalesce(var.cursor_pool_controller_identity_name, "mi-apex-cursor-controller-${var.environment}")
  cursor_pool_worker_mi       = coalesce(var.cursor_pool_worker_identity_name, "mi-apex-cursor-worker-${var.environment}")
  cursor_pool_clone_flag      = var.cursor_pool_clone_git_repos ? "--clone-git-repos" : ""
}

resource "azurerm_user_assigned_identity" "cursor_pool_controller" {
  count = local.cursor_pool_enabled ? 1 : 0

  name                = local.cursor_pool_controller_mi
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
  tags                = merge(var.tags, { Environment = var.environment, Workload = "cursor-pool-controller" })
}

resource "azurerm_user_assigned_identity" "cursor_pool_worker" {
  count = local.cursor_pool_enabled ? 1 : 0

  name                = local.cursor_pool_worker_mi
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
  tags                = merge(var.tags, { Environment = var.environment, Workload = "cursor-pool-worker" })
}

resource "azurerm_role_assignment" "cursor_pool_controller_acr_pull" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.cursor_pool_controller[0].principal_id
}

resource "azurerm_role_assignment" "cursor_pool_worker_acr_pull" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.cursor_pool_worker[0].principal_id
}

resource "azurerm_role_assignment" "cursor_pool_controller_kv_secrets_user" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope                = local.ai_runs_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.cursor_pool_controller[0].principal_id
}

resource "azurerm_role_assignment" "cursor_pool_worker_kv_secrets_user" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope                = local.ai_runs_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.cursor_pool_worker[0].principal_id
}

# A manual Job is the worker template. The controller's spawn hook starts one
# execution per claimed Cursor request and overrides the claim-specific worker
# id. Worker source lives on ephemeral storage; the shared Azure Files checkout
# is deliberately not mounted.
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

# Limit the controller to exactly the Job operations needed by the spawn hook.
resource "azurerm_role_definition" "cursor_pool_job_starter" {
  count = local.cursor_pool_enabled ? 1 : 0

  name        = "Apex Cursor Pool Job Starter ${var.environment}"
  scope       = local.use_dedicated_app_rg ? azurerm_resource_group.app[0].id : azurerm_resource_group.main.id
  description = "Start and inspect the Apex Cursor pool worker Container Apps Job."

  permissions {
    actions = [
      "Microsoft.App/jobs/read",
      "Microsoft.App/jobs/start/action",
      "Microsoft.App/jobs/executions/read",
    ]
    not_actions = [
      "Microsoft.App/jobs/listSecrets/action",
    ]
  }

  assignable_scopes = [
    local.use_dedicated_app_rg ? azurerm_resource_group.app[0].id : azurerm_resource_group.main.id,
  ]
}

resource "azurerm_role_assignment" "cursor_pool_controller_job_starter" {
  count = local.cursor_pool_enabled ? 1 : 0

  scope              = azurerm_container_app_job.cursor_pool_worker[0].id
  role_definition_id = azurerm_role_definition.cursor_pool_job_starter[0].role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.cursor_pool_controller[0].principal_id
}

# The controller maintains Cursor's pending-request SSE watch and invokes the
# image-provided spawn hook after it claims a request. It has no ingress.
resource "azurerm_container_app" "cursor_pool_controller" {
  count = local.cursor_pool_enabled ? 1 : 0

  name                         = local.cursor_pool_controller_name
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id
  resource_group_name          = local.app_resource_group_name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.cursor_pool_controller[0].id]
  }

  registry {
    server   = azurerm_container_registry.lt.login_server
    identity = azurerm_user_assigned_identity.cursor_pool_controller[0].id
  }

  secret {
    name                = "cursor-api-key"
    key_vault_secret_id = local.ai_runs_cursor_api_key_secret_id
    identity            = azurerm_user_assigned_identity.cursor_pool_controller[0].id
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "cursor-pool-controller"
      image  = var.cursor_pool_controller_image
      cpu    = var.cursor_pool_controller_cpu
      memory = var.cursor_pool_controller_memory

      command = ["/bin/sh", "-lc"]
      args = [
        "exec agent worker controller --spawn /opt/cursor/spawn-aca-job.sh --api-key \"$CURSOR_API_KEY\" --pool \"$CURSOR_WORKER_POOL_NAME\""
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
        name  = "CURSOR_WORKER_JOB_RESOURCE_ID"
        value = azurerm_container_app_job.cursor_pool_worker[0].id
      }

      env {
        name  = "CURSOR_WORKER_JOB_NAME"
        value = azurerm_container_app_job.cursor_pool_worker[0].name
      }

      env {
        name  = "AZURE_SUBSCRIPTION_ID"
        value = data.azurerm_client_config.current.subscription_id
      }

      env {
        name  = "AZURE_RESOURCE_GROUP"
        value = local.app_resource_group_name
      }

      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
      }

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.cursor_pool_controller[0].client_id
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "cursor-pool-controller" })

  lifecycle {
    precondition {
      condition     = local.ai_runs_cursor_api_key_secret_id != null
      error_message = "Cursor pool controller requires the AI-runs Cursor API key secret ID."
    }

    ignore_changes = [
      template[0].container[0].image,
    ]
  }

  depends_on = [
    azurerm_role_assignment.cursor_pool_controller_acr_pull,
    azurerm_role_assignment.cursor_pool_controller_kv_secrets_user,
    azurerm_role_assignment.cursor_pool_controller_job_starter,
  ]
}
