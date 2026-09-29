# AI Platform V2 runtime — orchestrator + document lane worker Container Apps
#
# Gated by enable_ai_platform_v2_runtime (requires enable_ai_platform_v2).
# Host-reuse: deploys onto data.azurerm_container_app_environment.ai_platform_v2_host.
# Images are built via scripts/ci/publish-ai-orchestrator.sh and publish-ai-runs-documents-v2.sh
# (or `az acr build`); lifecycle ignores image drift after first apply.

locals {
  ai_platform_v2_runtime_enabled = var.enable_ai_platform_v2 && var.enable_ai_platform_v2_runtime

  ai_platform_v2_orchestrator_app_name = coalesce(
    var.ai_platform_v2_orchestrator_container_app_name,
    "ca-apex-ai-orchestrator-${var.environment}",
  )
  ai_platform_v2_documents_app_name = coalesce(
    var.ai_platform_v2_documents_container_app_name,
    "ca-apex-ai-runs-documents-v2-${var.environment}",
  )

  ai_platform_v2_orchestrator_interactive_fast_dispatch_url = (
    local.ai_platform_v2_split_interactive_enabled
    ? local.ai_platform_v2_interactive_dispatch_urls.fast
    : var.ai_platform_v2_interactive_dispatch_base_url
  )
  ai_platform_v2_orchestrator_interactive_agentic_dispatch_url = (
    local.ai_platform_v2_split_interactive_enabled
    ? local.ai_platform_v2_interactive_dispatch_urls.agentic
    : var.ai_platform_v2_interactive_dispatch_base_url
  )
}

check "ai_platform_v2_runtime_inputs" {
  assert {
    condition = (
      !local.ai_platform_v2_runtime_enabled || (
        var.ai_platform_v2_orchestrator_image != null &&
        var.ai_platform_v2_documents_v2_image != null &&
        var.ai_platform_v2_database_url != null &&
        var.ai_platform_v2_database_url != "" &&
        var.ai_platform_v2_acr_name != null &&
        var.ai_platform_v2_acr_resource_group_name != null &&
        (
          local.ai_platform_v2_split_interactive_enabled || (
            var.ai_platform_v2_interactive_dispatch_base_url != null &&
            var.ai_platform_v2_interactive_dispatch_base_url != ""
          )
        )
      )
    )
    error_message = "enable_ai_platform_v2_runtime requires images, database_url, ACR, and interactive dispatch URLs (split interactive apps or interactive_dispatch_base_url)."
  }
}

data "azurerm_container_registry" "ai_platform_v2_acr" {
  count = local.ai_platform_v2_runtime_enabled ? 1 : 0

  name                = var.ai_platform_v2_acr_name
  resource_group_name = var.ai_platform_v2_acr_resource_group_name
}

data "azurerm_linux_web_app" "ai_platform_v2_api" {
  count = local.ai_platform_v2_runtime_enabled && var.ai_platform_v2_grant_app_service_blob ? 1 : 0

  name                = coalesce(var.ai_platform_v2_app_service_name, var.app_service_name)
  resource_group_name = data.azurerm_resource_group.ai_platform_v2_host[0].name
}

resource "azurerm_role_assignment" "ai_platform_v2_orchestrator_acr_pull" {
  count = local.ai_platform_v2_runtime_enabled ? 1 : 0

  scope                = data.azurerm_container_registry.ai_platform_v2_acr[0].id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_document_acr_pull" {
  count = local.ai_platform_v2_runtime_enabled ? 1 : 0

  scope                = data.azurerm_container_registry.ai_platform_v2_acr[0].id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["document"].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_api_blob_contributor" {
  count = local.ai_platform_v2_runtime_enabled && var.ai_platform_v2_grant_app_service_blob ? 1 : 0

  scope                = azurerm_storage_container.ai_platform_v2_artifacts[0].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_linux_web_app.ai_platform_v2_api[0].identity[0].principal_id
}

resource "azurerm_container_app" "ai_platform_v2_orchestrator" {
  count = local.ai_platform_v2_runtime_enabled ? 1 : 0

  name                         = local.ai_platform_v2_orchestrator_app_name
  container_app_environment_id = data.azurerm_container_app_environment.ai_platform_v2_host[0].id
  resource_group_name          = data.azurerm_resource_group.ai_platform_v2_host[0].name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].id]
  }

  registry {
    server   = data.azurerm_container_registry.ai_platform_v2_acr[0].login_server
    identity = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].id
  }

  secret {
    name  = "database-url"
    value = var.ai_platform_v2_database_url
  }

  template {
    min_replicas = var.ai_platform_v2_orchestrator_min_replicas
    max_replicas = var.ai_platform_v2_orchestrator_max_replicas

    container {
      name   = "ai-orchestrator"
      image  = var.ai_platform_v2_orchestrator_image
      cpu    = var.ai_platform_v2_orchestrator_cpu
      memory = var.ai_platform_v2_orchestrator_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AI_ORCHESTRATOR_ENABLED"
        value = "true"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].client_id
      }
      env {
        name  = "AZURE_TENANT_ID"
        value = var.azure_tenant_id
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name  = "AI_PLATFORM_V2_SERVICEBUS_NAMESPACE"
        value = data.azurerm_servicebus_namespace.ai_platform_v2_host[0].name
      }
      env {
        name  = "AI_PLATFORM_V2_CHECKPOINT_QUEUE"
        value = "ai-runs-v2-checkpoint"
      }
      env {
        name  = "AI_PLATFORM_V2_RESULT_QUEUE"
        value = "ai-runs-v2-result"
      }
      dynamic "env" {
        for_each = local.ai_platform_v2_orchestrator_interactive_fast_dispatch_url != null ? [1] : []
        content {
          name  = "AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL"
          value = local.ai_platform_v2_orchestrator_interactive_fast_dispatch_url
        }
      }
      dynamic "env" {
        for_each = local.ai_platform_v2_orchestrator_interactive_agentic_dispatch_url != null ? [1] : []
        content {
          name  = "AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL"
          value = local.ai_platform_v2_orchestrator_interactive_agentic_dispatch_url
        }
      }
      env {
        name  = "AI_ORCHESTRATOR_INTERACTIVE_CAP"
        value = tostring(local.ai_platform_v2_orchestrator_interactive_cap)
      }
      env {
        name  = "AI_ORCHESTRATOR_LANE_FLOOR_FAST"
        value = tostring(local.ai_platform_v2_orchestrator_lane_floor_fast)
      }
      env {
        name  = "AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC"
        value = tostring(local.ai_platform_v2_orchestrator_lane_floor_agentic)
      }
      dynamic "env" {
        for_each = var.ai_platform_v2_application_insights_connection_string != null && var.ai_platform_v2_application_insights_connection_string != "" ? [1] : []
        content {
          name  = "APPLICATIONINSIGHTS_CONNECTION_STRING"
          value = var.ai_platform_v2_application_insights_connection_string
        }
      }
    }
  }

  tags = local.ai_platform_v2_tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.ai_platform_v2_orchestrator_acr_pull,
    azurerm_role_assignment.ai_platform_v2_orchestrator_command_sender,
    azurerm_role_assignment.ai_platform_v2_orchestrator_checkpoint_receiver,
    azurerm_role_assignment.ai_platform_v2_orchestrator_result_receiver,
    azurerm_container_app.ai_platform_v2_interactive_class,
  ]
}

resource "azurerm_container_app" "ai_platform_v2_documents" {
  count = local.ai_platform_v2_runtime_enabled ? 1 : 0

  name                         = local.ai_platform_v2_documents_app_name
  container_app_environment_id = data.azurerm_container_app_environment.ai_platform_v2_host[0].id
  resource_group_name          = data.azurerm_resource_group.ai_platform_v2_host[0].name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ai_platform_v2["document"].id]
  }

  registry {
    server   = data.azurerm_container_registry.ai_platform_v2_acr[0].login_server
    identity = azurerm_user_assigned_identity.ai_platform_v2["document"].id
  }

  # The document worker reads the pinned repository only through the repo-read service.
  dynamic "secret" {
    for_each = var.ai_platform_v2_interactive_repo_read_service_token != null ? [1] : []
    content {
      name  = "repo-read-service-token"
      value = var.ai_platform_v2_interactive_repo_read_service_token
    }
  }

  template {
    min_replicas = var.ai_platform_v2_documents_min_replicas
    max_replicas = var.ai_platform_v2_documents_max_replicas

    container {
      name   = "ai-runs-documents-v2"
      image  = var.ai_platform_v2_documents_v2_image
      cpu    = var.ai_platform_v2_documents_cpu
      memory = var.ai_platform_v2_documents_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.ai_platform_v2["document"].client_id
      }
      env {
        name  = "AZURE_TENANT_ID"
        value = var.azure_tenant_id
      }
      env {
        name  = "AI_PLATFORM_V2_SERVICEBUS_NAMESPACE"
        value = data.azurerm_servicebus_namespace.ai_platform_v2_host[0].name
      }
      env {
        name  = "AI_PLATFORM_V2_BLOB_ACCOUNT_NAME"
        value = data.azurerm_storage_account.ai_platform_v2_host[0].name
      }
      env {
        name  = "AI_PLATFORM_V2_ARTIFACT_CONTAINER"
        value = local.ai_platform_v2_artifact_container
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

  tags = local.ai_platform_v2_tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.ai_platform_v2_document_acr_pull,
  ]
}
