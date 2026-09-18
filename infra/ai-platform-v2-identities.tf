# AI Platform V2 identities — entity-scoped RBAC (queues + artifact container)
#
# Does not grant namespace- or account-wide data-plane roles when a queue/container
# scope exists. V1 runner MI and App Service roles are left unchanged.

locals {
  ai_platform_v2_identity_keys = local.ai_platform_v2_enabled ? toset(
    local.ai_platform_v2_contracts.identities
  ) : toset([])

  ai_platform_v2_identity_name_prefix = "mi-apex-ai-v2"
}

resource "azurerm_user_assigned_identity" "ai_platform_v2" {
  for_each = local.ai_platform_v2_identity_keys

  name                = "${local.ai_platform_v2_identity_name_prefix}-${each.key}-${var.environment}"
  location            = azurerm_resource_group.ai_platform_v2[0].location
  resource_group_name = azurerm_resource_group.ai_platform_v2[0].name
  tags                = local.ai_platform_v2_tags
}

# Orchestrator: send on command queues; receive on checkpoint + result.
resource "azurerm_role_assignment" "ai_platform_v2_orchestrator_command_sender" {
  for_each = local.ai_platform_v2_enabled ? toset(local.ai_platform_v2_command_queue_names) : toset([])

  scope                = azurerm_servicebus_queue.ai_platform_v2[each.key].id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_orchestrator_checkpoint_receiver" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  scope                = azurerm_servicebus_queue.ai_platform_v2["ai-runs-v2-checkpoint"].id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_orchestrator_result_receiver" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  scope                = azurerm_servicebus_queue.ai_platform_v2["ai-runs-v2-result"].id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_orchestrator_blob_contributor" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  scope                = azurerm_storage_container.ai_platform_v2_artifacts[0].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2["orchestrator"].principal_id
}

# Lane workers: receive their command queue; write artifacts.
locals {
  ai_platform_v2_worker_queue_by_identity = {
    document           = "ai-runs-v2-document"
    visual             = "ai-runs-v2-visual"
    "fast-interactive" = "ai-runs-v2-fast"
    agentic            = "ai-runs-v2-agentic"
  }
}

resource "azurerm_role_assignment" "ai_platform_v2_worker_queue_receiver" {
  for_each = local.ai_platform_v2_enabled ? local.ai_platform_v2_worker_queue_by_identity : {}

  scope                = azurerm_servicebus_queue.ai_platform_v2[each.value].id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_worker_result_sender" {
  for_each = local.ai_platform_v2_enabled ? local.ai_platform_v2_worker_queue_by_identity : {}

  scope                = azurerm_servicebus_queue.ai_platform_v2["ai-runs-v2-result"].id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_worker_checkpoint_sender" {
  for_each = local.ai_platform_v2_enabled ? local.ai_platform_v2_worker_queue_by_identity : {}

  scope                = azurerm_servicebus_queue.ai_platform_v2["ai-runs-v2-checkpoint"].id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

resource "azurerm_role_assignment" "ai_platform_v2_worker_blob_contributor" {
  for_each = local.ai_platform_v2_enabled ? local.ai_platform_v2_worker_queue_by_identity : {}

  scope                = azurerm_storage_container.ai_platform_v2_artifacts[0].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.ai_platform_v2[each.key].principal_id
}

# Optional: Apex API may send V2 commands later without touching V1 queue roles.
resource "azurerm_role_assignment" "ai_platform_v2_api_command_sender" {
  for_each = local.ai_platform_v2_enabled && var.ai_platform_v2_grant_app_service_sender ? (
    toset(local.ai_platform_v2_command_queue_names)
  ) : toset([])

  scope                = azurerm_servicebus_queue.ai_platform_v2[each.key].id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}
