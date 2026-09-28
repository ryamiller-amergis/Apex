# V2 class-keyed interactive actor hosts (fast + agentic) on the FEAT-007 CAE.
#
# Reuses Redis Dapr components, Azure Files workspace, repo-read, KV, and the
# shared interactive actor image. Orchestrator dispatches over internal ingress;
# legacy ca-apex-ai-interactive stays for canonical-flag-off traffic only.

locals {
  ai_platform_v2_split_interactive_enabled = (
    local.ai_platform_v2_runtime_enabled
    && var.enable_ai_platform_v2_split_interactive
  )

  ai_platform_v2_interactive_class_keys = toset(["fast-interactive", "agentic"])

  ai_platform_v2_interactive_dapr_app_ids = {
    "fast-interactive" = "apex-ai-fast-interactive"
    agentic            = "apex-ai-agentic"
  }

  ai_platform_v2_interactive_dapr_components = {
    "interactive-pubsub" = {
      component_type = "pubsub.redis"
      actor_store    = false
    }
    "interactive-actor-state" = {
      component_type = "state.redis"
      actor_store    = true
    }
  }

  ai_platform_v2_interactive_app_names = {
    "fast-interactive" = coalesce(
      var.ai_platform_v2_fast_interactive_container_app_name,
      "ca-apex-ai-fast-interactive-${var.environment}",
    )
    agentic = coalesce(
      var.ai_platform_v2_agentic_container_app_name,
      "ca-apex-ai-agentic-${var.environment}",
    )
  }

  ai_platform_v2_interactive_replica_bounds = var.environment == "dev" ? {
    "fast-interactive" = { min = 1, max = 2 }
    agentic            = { min = 1, max = 2 }
    } : {
    "fast-interactive" = { min = 2, max = 16 }
    agentic            = { min = 2, max = 16 }
  }

  ai_platform_v2_orchestrator_interactive_cap    = var.environment == "dev" ? 4 : 16
  ai_platform_v2_orchestrator_lane_floor_fast    = var.environment == "dev" ? 1 : 2
  ai_platform_v2_orchestrator_lane_floor_agentic = var.environment == "dev" ? 1 : 2

  ai_platform_v2_interactive_dispatch_urls = local.ai_platform_v2_split_interactive_enabled ? {
    fast    = "https://${azurerm_container_app.ai_platform_v2_interactive_class["fast-interactive"].ingress[0].fqdn}"
    agentic = "https://${azurerm_container_app.ai_platform_v2_interactive_class["agentic"].ingress[0].fqdn}"
  } : null
}

check "ai_platform_v2_split_interactive_inputs" {
  assert {
    condition = (
      !local.ai_platform_v2_split_interactive_enabled || (
        var.ai_platform_v2_interactive_image != null &&
        var.ai_platform_v2_interactive_callback_base_url != null &&
        var.ai_platform_v2_interactive_callback_base_url != "" &&
        var.ai_platform_v2_interactive_redis_host != null &&
        var.ai_platform_v2_interactive_redis_host != "" &&
        var.ai_platform_v2_interactive_redis_key != null &&
        var.ai_platform_v2_interactive_cursor_api_key_secret_id != null &&
        var.ai_platform_v2_application_insights_connection_string != null &&
        var.ai_platform_v2_application_insights_connection_string != ""
      )
    )
    error_message = "V2 split interactive runtime requires its image, callback URL, Redis host/key, Cursor API Key secret ID, and App Insights connection string."
  }
}

resource "azurerm_role_assignment" "ai_platform_v2_interactive_acr_pull" {
  for_each = local.ai_platform_v2_split_interactive_enabled ? local.ai_platform_v2_interactive_class_keys : toset([])

  scope                = data.azurerm_container_registry.ai_platform_v2_acr[0].id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_interactive_kv_secrets_user" {
  for_each = (
    local.ai_platform_v2_split_interactive_enabled
    && var.ai_platform_v2_interactive_key_vault_id != null
  ) ? local.ai_platform_v2_interactive_class_keys : toset([])

  scope                = var.ai_platform_v2_interactive_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_interactive_blob_contributor" {
  for_each = local.ai_platform_v2_split_interactive_enabled ? local.ai_platform_v2_interactive_class_keys : toset([])

  scope                = azurerm_storage_container.ai_platform_v2_artifacts[0].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

moved {
  from = azurerm_role_assignment.ai_platform_v2_worker_blob_contributor["fast-interactive"]
  to   = azurerm_role_assignment.ai_platform_v2_interactive_blob_contributor["fast-interactive"]
}

moved {
  from = azurerm_role_assignment.ai_platform_v2_worker_blob_contributor["agentic"]
  to   = azurerm_role_assignment.ai_platform_v2_interactive_blob_contributor["agentic"]
}

resource "azuread_app_role_assignment" "ai_platform_v2_interactive_runner_ingest" {
  for_each = (
    local.ai_platform_v2_split_interactive_enabled
    && var.ai_platform_v2_interactive_runner_app_role_id != null
    && var.ai_platform_v2_interactive_runner_service_principal_object_id != null
  ) ? local.ai_platform_v2_interactive_class_keys : toset([])

  app_role_id         = var.ai_platform_v2_interactive_runner_app_role_id
  principal_object_id = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
  resource_object_id  = var.ai_platform_v2_interactive_runner_service_principal_object_id
}

resource "azapi_update_resource" "ai_platform_v2_interactive_dapr_scopes" {
  for_each = local.ai_platform_v2_split_interactive_enabled ? local.ai_platform_v2_interactive_dapr_components : {}

  type        = "Microsoft.App/managedEnvironments/daprComponents@2024-03-01"
  resource_id = "${data.azurerm_container_app_environment.ai_platform_v2_host[0].id}/daprComponents/${each.key}"

  body = {
    properties = {
      componentType = each.value.component_type
      version       = "v1"
      ignoreErrors  = false
      initTimeout   = "5s"
      metadata = concat(
        [
          {
            name  = "redisHost"
            value = "${var.ai_platform_v2_interactive_redis_host}:${var.ai_platform_v2_interactive_redis_port}"
          },
          {
            name      = "redisPassword"
            secretRef = "redis-password"
          },
          {
            name  = "enableTLS"
            value = "true"
          },
        ],
        each.value.actor_store ? [
          {
            name  = "actorStateStore"
            value = "true"
          },
        ] : [],
      )
      scopes = [
        "apex-ai-interactive",
        local.ai_platform_v2_interactive_dapr_app_ids["fast-interactive"],
        local.ai_platform_v2_interactive_dapr_app_ids["agentic"],
      ]
      secrets = [
        {
          name  = "redis-password"
          value = var.ai_platform_v2_interactive_redis_key
        },
      ]
    }
  }
}

resource "azurerm_container_app" "ai_platform_v2_interactive_class" {
  for_each = local.ai_platform_v2_split_interactive_enabled ? local.ai_platform_v2_interactive_class_keys : toset([])

  name                         = local.ai_platform_v2_interactive_app_names[each.key]
  container_app_environment_id = data.azurerm_container_app_environment.ai_platform_v2_host[0].id
  resource_group_name          = data.azurerm_resource_group.ai_platform_v2_host[0].name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ai_platform_v2[each.key].id]
  }

  registry {
    server   = data.azurerm_container_registry.ai_platform_v2_acr[0].login_server
    identity = azurerm_user_assigned_identity.ai_platform_v2[each.key].id
  }

  dynamic "secret" {
    for_each = var.ai_platform_v2_interactive_cursor_api_key_secret_id != null ? [1] : []
    content {
      name                = "cursor-api-key"
      key_vault_secret_id = var.ai_platform_v2_interactive_cursor_api_key_secret_id
      identity            = azurerm_user_assigned_identity.ai_platform_v2[each.key].id
    }
  }

  dynamic "secret" {
    for_each = var.ai_platform_v2_interactive_callback_token != null && var.ai_platform_v2_interactive_callback_token != "" ? [1] : []
    content {
      name  = "ai-runs-runner-callback-token"
      value = var.ai_platform_v2_interactive_callback_token
    }
  }

  dynamic "secret" {
    for_each = var.ai_platform_v2_interactive_repo_read_service_token != null ? [1] : []
    content {
      name  = "repo-read-service-token"
      value = var.ai_platform_v2_interactive_repo_read_service_token
    }
  }

  secret {
    name  = "redis-key"
    value = var.ai_platform_v2_interactive_redis_key
  }

  dapr {
    app_id       = local.ai_platform_v2_interactive_dapr_app_ids[each.key]
    app_port     = var.ai_platform_v2_interactive_target_port
    app_protocol = "http"
  }

  ingress {
    external_enabled = false
    target_port      = var.ai_platform_v2_interactive_target_port
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = local.ai_platform_v2_interactive_replica_bounds[each.key].min
    max_replicas = local.ai_platform_v2_interactive_replica_bounds[each.key].max

    volume {
      name         = "ai-pilot-data"
      storage_type = "AzureFile"
      storage_name = var.ai_platform_v2_interactive_workspace_storage_name
    }

    container {
      name   = "ai-runs-interactive"
      image  = var.ai_platform_v2_interactive_image
      cpu    = var.ai_platform_v2_interactive_cpu
      memory = var.ai_platform_v2_interactive_memory

      volume_mounts {
        name = "ai-pilot-data"
        path = var.ai_platform_v2_interactive_workspace_mount_path
      }

      liveness_probe {
        transport = "HTTP"
        port      = var.ai_platform_v2_interactive_target_port
        path      = "/health"
      }

      readiness_probe {
        transport = "HTTP"
        port      = var.ai_platform_v2_interactive_target_port
        path      = "/health"
      }

      startup_probe {
        transport               = "HTTP"
        port                    = var.ai_platform_v2_interactive_target_port
        path                    = "/health"
        interval_seconds        = 5
        failure_count_threshold = 10
      }

      env {
        name  = "APEX_CALLBACK_URL"
        value = var.ai_platform_v2_interactive_callback_base_url
      }
      env {
        name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        value = var.ai_platform_v2_application_insights_connection_string
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.ai_platform_v2[each.key].client_id
      }
      env {
        name  = "AI_PLATFORM_V2_IDENTITY_CLIENT_ID"
        value = azurerm_user_assigned_identity.ai_platform_v2[each.key].client_id
      }
      env {
        name  = "AZURE_TENANT_ID"
        value = var.azure_tenant_id
      }
      env {
        name  = "AI_PLATFORM_V2_BLOB_ACCOUNT_NAME"
        value = data.azurerm_storage_account.ai_platform_v2_host[0].name
      }
      env {
        name  = "AI_PLATFORM_V2_ARTIFACT_CONTAINER"
        value = local.ai_platform_v2_artifact_container
      }
      env {
        name  = "AI_PILOT_DATA_DIR"
        value = var.ai_platform_v2_interactive_workspace_mount_path
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_DAPR_APP_ID"
        value = local.ai_platform_v2_interactive_dapr_app_ids[each.key]
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_PUBSUB_NAME"
        value = "interactive-pubsub"
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_STATE_STORE"
        value = "interactive-actor-state"
      }
      env {
        name  = "REDIS_HOST"
        value = var.ai_platform_v2_interactive_redis_host
      }
      env {
        name  = "REDIS_SSL_PORT"
        value = tostring(var.ai_platform_v2_interactive_redis_port)
      }
      env {
        name        = "REDIS_KEY"
        secret_name = "redis-key"
      }

      dynamic "env" {
        for_each = var.ai_platform_v2_interactive_callback_token_audience != null ? [1] : []
        content {
          name  = "AI_RUNS_CALLBACK_TOKEN_AUDIENCE"
          value = var.ai_platform_v2_interactive_callback_token_audience
        }
      }

      dynamic "env" {
        for_each = var.ai_platform_v2_interactive_cursor_api_key_secret_id != null ? [1] : []
        content {
          name        = "CURSOR_API_KEY"
          secret_name = "cursor-api-key"
        }
      }

      dynamic "env" {
        for_each = var.ai_platform_v2_interactive_callback_token != null && var.ai_platform_v2_interactive_callback_token != "" ? [1] : []
        content {
          name  = "AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN"
          value = "true"
        }
      }

      dynamic "env" {
        for_each = var.ai_platform_v2_interactive_callback_token != null && var.ai_platform_v2_interactive_callback_token != "" ? [1] : []
        content {
          name        = "AI_RUNS_RUNNER_CALLBACK_TOKEN"
          secret_name = "ai-runs-runner-callback-token"
        }
      }

      dynamic "env" {
        for_each = var.ai_platform_v2_interactive_repo_read_service_url != null ? [1] : []
        content {
          name  = "REPO_READ_SERVICE_URL"
          value = var.ai_platform_v2_interactive_repo_read_service_url
        }
      }

      dynamic "env" {
        for_each = var.ai_platform_v2_interactive_repo_read_service_token != null ? [1] : []
        content {
          name        = "REPO_READ_SERVICE_TOKEN"
          secret_name = "repo-read-service-token"
        }
      }
    }
  }

  tags = merge(var.tags, {
    Environment = var.environment
    Workload    = "ai-platform-v2-interactive"
    Class       = each.key
  })

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.ai_platform_v2_interactive_acr_pull,
    azurerm_role_assignment.ai_platform_v2_interactive_kv_secrets_user,
    azurerm_role_assignment.ai_platform_v2_interactive_blob_contributor,
    azapi_update_resource.ai_platform_v2_interactive_dapr_scopes,
  ]
}
