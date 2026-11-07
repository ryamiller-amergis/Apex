# Repo read service — Stage 3 of design-docs/repo-grounding-consolidation.md
#
# Dedicated Container App that serves git cat-file / ls-tree / grep from a
# bare mirror on ephemeral local disk. Mirrors never live on Azure Files (git
# on SMB is the hot-path we are leaving). Blob container repo-grounding
# remains the durable restore source.
#
# With GROUNDING_MAINTENANCE_MODE=v2-projects the service also runs repo
# upkeep for projects wholly on ai-runs-v2-transport and cleans the shared
# workspace share, which is mounted only at <data dir>/workspaces for that
# cleanup.
#
# Gated by enable_repo_read_service (default false). Shares the runner
# identity, ACR, and Key Vault with ai-runs. The Container Apps Environment
# defaults to the ai-runs one but prod overrides it: grep over a bare mirror
# needs a dedicated workload profile, and putting one on the shared
# environment would price every ai-runs app into it.

locals {
  repo_read_service_enabled  = var.enable_repo_read_service
  repo_read_service_app_name = coalesce(var.repo_read_service_container_app_name, "ca-apex-repo-read-${var.environment}")
  repo_read_service_data_dir = "/tmp/ai-pilot"
  repo_read_github_token     = var.github_token != null && var.github_token != ""

  # container_app_environment_id is ForceNew, so pointing this at the wrong
  # environment destroys and rebuilds the service rather than moving it.
  repo_read_service_environment_id = coalesce(
    var.repo_read_service_environment_id,
    azurerm_container_app_environment.ai_runs.id,
  )
  repo_read_service_own_environment = local.repo_read_service_environment_id != azurerm_container_app_environment.ai_runs.id
  repo_read_service_workspace_storage_name = local.repo_read_service_own_environment ? (
    azurerm_container_app_environment_storage.repo_read_workspace[0].name
  ) : azurerm_container_app_environment_storage.ai_runs_workspace.name
}

# The ai-runs environment already has this share; a dedicated repo-read
# environment needs its own registration to mount it.
resource "azurerm_container_app_environment_storage" "repo_read_workspace" {
  count = local.repo_read_service_enabled && local.repo_read_service_own_environment ? 1 : 0

  name                         = "ai-runs-workspace"
  container_app_environment_id = local.repo_read_service_environment_id
  account_name                 = azurerm_storage_account.shared.name
  share_name                   = azurerm_storage_share.ai_runs_workspace.name
  access_key                   = azurerm_storage_account.shared.primary_access_key
  access_mode                  = "ReadWrite"
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
  container_app_environment_id = local.repo_read_service_environment_id
  resource_group_name          = local.app_resource_group_name
  revision_mode                = "Single"
  workload_profile_name        = var.repo_read_service_workload_profile_name

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

  dynamic "secret" {
    for_each = local.repo_read_github_token ? [1] : []
    content {
      name  = "github-token"
      value = var.github_token
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

    volume {
      name         = "ai-pilot-workspaces"
      storage_type = "AzureFile"
      storage_name = local.repo_read_service_workspace_storage_name
    }

    container {
      name   = "repo-read-service"
      image  = var.repo_read_service_image
      cpu    = var.repo_read_service_cpu
      memory = var.repo_read_service_memory

      # Same layout as App Service: <data dir>/workspaces is the share, so
      # eviction sees the folders App Service and the workers create.
      volume_mounts {
        name = "ai-pilot-workspaces"
        path = "${local.repo_read_service_data_dir}/workspaces"
      }

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
        name  = "GITHUB_ORG"
        value = var.github_org
      }
      dynamic "env" {
        for_each = local.repo_read_github_token ? [1] : []
        content {
          name        = "GITHUB_TOKEN"
          secret_name = "github-token"
        }
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      dynamic "env" {
        for_each = var.repo_read_service_grounding_maintenance_mode != null ? [1] : []
        content {
          name  = "GROUNDING_MAINTENANCE_MODE"
          value = var.repo_read_service_grounding_maintenance_mode
        }
      }
      dynamic "env" {
        for_each = local.ai_runs_cursor_api_key_secret_id != null ? [1] : []
        content {
          name        = "CURSOR_API_KEY"
          secret_name = "cursor-api-key"
        }
      }
      # Share deletes run in rm child processes, but git and Blob I/O still use
      # the libuv pool alongside live reads.
      env {
        name  = "UV_THREADPOOL_SIZE"
        value = "16"
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
      # azurerm ~> 3.0 has no initial_delay on these probes; slack comes from
      # interval_seconds * failure_count_threshold instead. The provider caps
      # failure_count_threshold at 10, so the interval has to carry the slack:
      # a threshold above 10 fails the plan outright rather than the apply.
      # 30 * 10 keeps the intended five minutes.
      startup_probe {
        transport               = "HTTP"
        port                    = var.repo_read_service_target_port
        path                    = "/healthz"
        interval_seconds        = 30
        timeout                 = 5
        failure_count_threshold = 10
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = var.repo_read_service_target_port
        path                    = "/healthz"
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
