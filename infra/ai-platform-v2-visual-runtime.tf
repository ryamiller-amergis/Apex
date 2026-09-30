# AI Platform V2 visual lane worker Container App (design prototypes, UI Lab).
#
# Consumes ai-runs-v2-visual as the "visual" V2 identity and calls Bedrock with
# the AWS credentials App Service already uses. Created only once a visual image
# is supplied; images are built via scripts/ci/publish-ai-runs-visual.sh and
# lifecycle ignores image drift after first apply.

locals {
  ai_platform_v2_visual_enabled = (
    local.ai_platform_v2_runtime_enabled && var.ai_platform_v2_visual_image != null
  )

  ai_platform_v2_visual_app_name = coalesce(
    var.ai_platform_v2_visual_container_app_name,
    "ca-apex-ai-runs-visual-v2-${var.environment}",
  )
}

resource "azurerm_role_assignment" "ai_platform_v2_visual_acr_pull" {
  count = local.ai_platform_v2_visual_enabled ? 1 : 0

  scope                = data.azurerm_container_registry.ai_platform_v2_acr[0].id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["visual"].principal_id
}

resource "azurerm_container_app" "ai_platform_v2_visual" {
  count = local.ai_platform_v2_visual_enabled ? 1 : 0

  name                         = local.ai_platform_v2_visual_app_name
  container_app_environment_id = data.azurerm_container_app_environment.ai_platform_v2_host[0].id
  resource_group_name          = data.azurerm_resource_group.ai_platform_v2_host[0].name
  revision_mode                = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.ai_platform_v2["visual"].id]
  }

  registry {
    server   = data.azurerm_container_registry.ai_platform_v2_acr[0].login_server
    identity = azurerm_user_assigned_identity.ai_platform_v2["visual"].id
  }

  secret {
    name  = "aws-access-key-id"
    value = var.ai_platform_v2_visual_aws_access_key_id
  }

  secret {
    name  = "aws-secret-access-key"
    value = var.ai_platform_v2_visual_aws_secret_access_key
  }

  template {
    min_replicas = var.ai_platform_v2_visual_min_replicas
    max_replicas = var.ai_platform_v2_visual_max_replicas

    container {
      name   = "ai-runs-visual-v2"
      image  = var.ai_platform_v2_visual_image
      cpu    = var.ai_platform_v2_visual_cpu
      memory = var.ai_platform_v2_visual_memory

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.ai_platform_v2["visual"].client_id
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
      env {
        name        = "AWS_ACCESS_KEY_ID"
        secret_name = "aws-access-key-id"
      }
      env {
        name        = "AWS_SECRET_ACCESS_KEY"
        secret_name = "aws-secret-access-key"
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
    azurerm_role_assignment.ai_platform_v2_visual_acr_pull,
  ]
}
