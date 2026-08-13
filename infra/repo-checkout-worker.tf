# Async repository checkout worker
#
# Moves admin Clone/Refresh git + Azure Files materialize off the App Service
# HTTP process onto a dedicated Container Apps Job in the existing AI-runs
# environment. Queue `repo-checkout` lives on sbns-apex-ai-* (do not create a
# namespace; do not reuse caj-apex-ai-runs-*). max_executions = 1.
#
# Identity model:
#   repo_checkout_runner MI — Job executor: queue receive, AcrPull, git env
#   Apex API MI             — App Service system identity: queue send only

locals {
  repo_checkout_queue_name       = coalesce(var.repo_checkout_queue_name, "repo-checkout")
  repo_checkout_job_name         = coalesce(var.repo_checkout_container_app_job_name, "caj-apex-repo-checkout-${var.environment}")
  repo_checkout_runner_mi_name   = coalesce(var.repo_checkout_runner_identity_name, "mi-apex-repo-checkout-${var.environment}")
  repo_checkout_image_repository = "apex-repo-checkout"
  repo_checkout_database_url     = "postgresql://${var.postgresql_admin_username}:${var.postgresql_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgresql_database_name}?sslmode=require"
}

resource "azurerm_servicebus_queue" "repo_checkout" {
  name         = local.repo_checkout_queue_name
  namespace_id = azurerm_servicebus_namespace.ai_runs.id

  max_delivery_count                   = 5
  dead_lettering_on_message_expiration = true
  lock_duration                        = "PT5M"
}

resource "azurerm_servicebus_queue_authorization_rule" "repo_checkout_keda" {
  name     = "repo-checkout-keda-manage"
  queue_id = azurerm_servicebus_queue.repo_checkout.id

  listen = true
  send   = false
  manage = true
}

resource "azurerm_user_assigned_identity" "repo_checkout_runner" {
  name                = local.repo_checkout_runner_mi_name
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
  tags                = merge(var.tags, { Environment = var.environment, Workload = "repo-checkout" })
}

resource "azurerm_role_assignment" "repo_checkout_runner_sb_receiver" {
  scope                = azurerm_servicebus_queue.repo_checkout.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.repo_checkout_runner.principal_id
}

resource "azurerm_role_assignment" "repo_checkout_runner_acr_pull" {
  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.repo_checkout_runner.principal_id
}

resource "azurerm_role_assignment" "repo_checkout_api_sb_sender" {
  scope                = azurerm_servicebus_queue.repo_checkout.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "repo_checkout_staging_sb_sender" {
  count = var.enable_staging_slot && var.ai_runs_enable_staging_slot_rbac ? 1 : 0

  scope                = azurerm_servicebus_queue.repo_checkout.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app_slot.staging[0].identity[0].principal_id
}

resource "azurerm_container_app_job" "repo_checkout" {
  name                         = local.repo_checkout_job_name
  location                     = local.app_service_location
  resource_group_name          = local.app_resource_group_name
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id

  # Must exceed COLD_CACHE_TIMEOUT_MS (30 min).
  replica_timeout_in_seconds = 3600

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.repo_checkout_runner.id]
  }

  registry {
    server   = azurerm_container_registry.lt.login_server
    identity = azurerm_user_assigned_identity.repo_checkout_runner.id
  }

  secret {
    name  = "repo-checkout-keda-sb-connection"
    value = azurerm_servicebus_queue_authorization_rule.repo_checkout_keda.primary_connection_string
  }

  secret {
    name  = "database-url"
    value = local.repo_checkout_database_url
  }

  secret {
    name  = "ado-pat"
    value = var.ado_pat
  }

  dynamic "secret" {
    for_each = var.github_token != null && var.github_token != "" ? [1] : []
    content {
      name  = "github-token"
      value = var.github_token
    }
  }

  event_trigger_config {
    parallelism              = 1
    replica_completion_count = 1

    scale {
      min_executions = 0
      max_executions = 1

      rules {
        name             = "repo-checkout-servicebus-keda"
        custom_rule_type = "azure-servicebus"

        metadata = {
          queueName    = local.repo_checkout_queue_name
          namespace    = azurerm_servicebus_namespace.ai_runs.name
          messageCount = "1"
        }

        authentication {
          secret_name       = "repo-checkout-keda-sb-connection"
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
      name   = "repo-checkout-worker"
      image  = var.repo_checkout_runner_image
      cpu    = var.repo_checkout_runner_cpu
      memory = var.repo_checkout_runner_memory

      volume_mounts {
        name = "ai-pilot-data"
        path = var.ai_runs_workspace_mount_path
      }

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.repo_checkout_runner.client_id
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
        name  = "REPO_CHECKOUT_QUEUE_NAME"
        value = azurerm_servicebus_queue.repo_checkout.name
      }

      env {
        name  = "AI_PILOT_DATA_DIR"
        value = local.ai_runs_data_dir
      }

      env {
        name  = "ADO_ORG"
        value = var.ado_org
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "ADO_PAT"
        secret_name = "ado-pat"
      }

      dynamic "env" {
        for_each = var.github_org != null && var.github_org != "" ? [1] : []
        content {
          name  = "GITHUB_ORG"
          value = var.github_org
        }
      }

      dynamic "env" {
        for_each = var.github_token != null && var.github_token != "" ? [1] : []
        content {
          name        = "GITHUB_TOKEN"
          secret_name = "github-token"
        }
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "repo-checkout" })

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
    ]
  }
}
