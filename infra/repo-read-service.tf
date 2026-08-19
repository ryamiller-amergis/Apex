# Repo read service — Stage 3 of design-docs/repo-grounding-consolidation.md
#
# Dedicated Container App that serves git cat-file / ls-tree / grep from a
# bare mirror on ephemeral local disk. Azure Files is intentionally not
# mounted (git on SMB is the hot-path we are leaving). Blob container
# repo-grounding remains the durable restore source.
#
# Gated by enable_repo_read_service (default false). Reuses the ai-runs
# Container Apps Environment, runner identity, ACR, and Key Vault.

locals {
  repo_read_service_enabled  = var.enable_repo_read_service
  repo_read_service_app_name = coalesce(var.repo_read_service_container_app_name, "ca-apex-repo-read-${var.environment}")
  repo_read_service_data_dir = "/tmp/ai-pilot"
}

resource "azurerm_role_assignment" "repo_read_service_blob_contributor" {
  count = local.repo_read_service_enabled ? 1 : 0

  scope                = azurerm_storage_container.shared["repo-grounding"].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.ai_runs_runner.principal_id
}

resource "azurerm_container_app" "repo_read_service" {
  count = local.repo_read_service_enabled ? 1 : 0

  name                         = local.repo_read_service_app_name
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id
  resource_group_name          = local.app_resource_group_name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ai_runs_runner.id]
  }

  registry {
    server   = azurerm_container_registry.lt.login_server
    identity = azurerm_user_assigned_identity.ai_runs_runner.id
  }

  dynamic "secret" {
    for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
    content {
      name  = "ai-runs-runner-callback-token"
      value = var.ai_runs_runner_callback_token
    }
  }

  secret {
    name  = "database-url"
    value = "postgresql://${var.postgresql_admin_username}:${var.postgresql_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgresql_database_name}?sslmode=require"
  }

  secret {
    name  = "ado-pat"
    value = var.ado_pat
  }

  ingress {
    external_enabled = true
    target_port      = var.repo_read_service_target_port
    transport        = "http"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "repo-read-service"
      image  = var.repo_read_service_image
      cpu    = var.repo_read_service_cpu
      memory = var.repo_read_service_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = azurerm_application_insights.main.connection_string
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
        name  = "AI_PILOT_DATA_DIR"
        value = local.repo_read_service_data_dir
      }
      env {
        name  = "GROUNDING_BLOB_ACCOUNT_NAME"
        value = azurerm_storage_account.shared.name
      }
      env {
        name  = "GROUNDING_BLOB_CONTAINER_NAME"
        value = azurerm_storage_container.shared["repo-grounding"].name
      }
      env {
        name  = "ADO_ORG"
        value = var.ado_org
      }
      env {
        name  = "ADO_PROJECT"
        value = var.ado_project
      }
      env {
        name        = "ADO_PAT"
        secret_name = "ado-pat"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name  = "AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN"
        value = "true"
      }

      dynamic "env" {
        for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
        content {
          name        = "AI_RUNS_RUNNER_CALLBACK_TOKEN"
          secret_name = "ai-runs-runner-callback-token"
        }
      }

      # Without explicit probes the platform applies tight defaults, and a search
      # holds a core long enough that /healthz goes unanswered — so the container
      # is killed mid-read and has to re-materialize its mirror on the way back,
      # which reads to the caller as the search hanging. Grep over a bare mirror
      # has to inflate blobs, so slow is normal here and must not mean unhealthy.
      startup_probe {
        transport               = "HTTP"
        port                    = var.repo_read_service_target_port
        path                    = "/healthz"
        initial_delay           = 5
        interval_seconds        = 10
        timeout                 = 5
        failure_count_threshold = 30
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = var.repo_read_service_target_port
        path                    = "/healthz"
        initial_delay           = 30
        interval_seconds        = 30
        timeout                 = 10
        failure_count_threshold = 10
      }

      # Only one replica runs, so pulling it from rotation fails every caller
      # rather than shifting load. Tolerate the same slowness liveness does.
      readiness_probe {
        transport               = "HTTP"
        port                    = var.repo_read_service_target_port
        path                    = "/healthz"
        interval_seconds        = 30
        timeout                 = 10
        failure_count_threshold = 10
        success_count_threshold = 1
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "repo-read-service" })

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
    ]
  }

  depends_on = [
    azurerm_role_assignment.ai_runs_runner_kv_secrets_user,
    azurerm_role_assignment.ai_runs_runner_acr_pull,
    azurerm_role_assignment.repo_read_service_blob_contributor,
  ]
}
