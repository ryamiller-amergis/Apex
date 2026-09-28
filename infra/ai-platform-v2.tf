# AI Platform V2 — additive onto the existing host platform
#
# Gated by enable_ai_platform_v2 (default false).
# Does NOT create a new resource group, Service Bus namespace, storage account,
# VNet, or Container Apps Environment. Those stay on the live env host:
#   DEV  → East US  (e.g. rg-scrum-dev / sbns-apex-ai-dev / stapexdevasync / cae-apex-ai-dev)
#   PROD → Central US (existing prod AI RG / sbns-apex-ai-prd / shared async / CAE)
#
# This module only adds: V2 queues, artifact container, UAMIs, and entity RBAC.
# Queue / identity contracts: ai-platform-v2-contracts.json.

locals {
  ai_platform_v2_enabled = var.enable_ai_platform_v2

  ai_platform_v2_contracts = jsondecode(file("${path.module}/ai-platform-v2-contracts.json"))

  ai_platform_v2_location = coalesce(
    var.ai_platform_v2_location,
    try(local.ai_platform_v2_contracts.locationsByEnvironment[var.environment], null)
  )

  ai_platform_v2_artifact_container = local.ai_platform_v2_contracts.artifactContainer

  ai_platform_v2_queues = {
    for name, cfg in local.ai_platform_v2_contracts.queues : name => {
      kind                         = cfg.kind
      requires_duplicate_detection = cfg.requiresDuplicateDetection
      requires_session             = cfg.requiresSession
      duplicate_detection_window   = local.ai_platform_v2_contracts.queueDefaults.duplicateDetectionHistoryTimeWindow
      max_delivery_count           = local.ai_platform_v2_contracts.queueDefaults.maxDeliveryCount
      lock_duration                = local.ai_platform_v2_contracts.queueDefaults.lockDuration
      dead_lettering_on_expiration = local.ai_platform_v2_contracts.queueDefaults.deadLetteringOnMessageExpiration
    }
  }

  ai_platform_v2_command_queue_names = [
    for name, cfg in local.ai_platform_v2_queues : name if cfg.kind == "command"
  ]

  ai_platform_v2_tags = merge(var.tags, {
    Environment = var.environment
    Workload    = "ai-platform-v2"
  })
}

check "ai_platform_v2_host_inputs" {
  assert {
    condition = (
      !local.ai_platform_v2_enabled || (
        var.ai_platform_v2_resource_group_name != null &&
        var.ai_platform_v2_servicebus_namespace_name != null &&
        var.ai_platform_v2_storage_account_name != null &&
        var.ai_platform_v2_container_app_env_name != null &&
        local.ai_platform_v2_location != null
      )
    )
    error_message = "enable_ai_platform_v2 requires resource_group, servicebus_namespace, storage_account, container_app_env names, and location (or locationsByEnvironment[environment] in contracts)."
  }
}

# ---------------------------------------------------------------------------
# Existing host lookups (no create)
# ---------------------------------------------------------------------------

data "azurerm_resource_group" "ai_platform_v2_host" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name = var.ai_platform_v2_resource_group_name
}

data "azurerm_servicebus_namespace" "ai_platform_v2_host" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                = var.ai_platform_v2_servicebus_namespace_name
  resource_group_name = data.azurerm_resource_group.ai_platform_v2_host[0].name
}

data "azurerm_storage_account" "ai_platform_v2_host" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                = var.ai_platform_v2_storage_account_name
  resource_group_name = data.azurerm_resource_group.ai_platform_v2_host[0].name
}

data "azurerm_container_app_environment" "ai_platform_v2_host" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                = var.ai_platform_v2_container_app_env_name
  resource_group_name = data.azurerm_resource_group.ai_platform_v2_host[0].name
}

# ---------------------------------------------------------------------------
# Additive V2 queues on the existing Service Bus namespace
# ---------------------------------------------------------------------------

resource "azurerm_servicebus_queue" "ai_platform_v2" {
  for_each = local.ai_platform_v2_enabled ? local.ai_platform_v2_queues : {}

  name         = each.key
  namespace_id = data.azurerm_servicebus_namespace.ai_platform_v2_host[0].id

  max_delivery_count                   = each.value.max_delivery_count
  dead_lettering_on_message_expiration = each.value.dead_lettering_on_expiration
  lock_duration                        = each.value.lock_duration
  requires_session                     = each.value.requires_session

  # CHANGING duplicate detection replaces the queue. Drain before changes.
  requires_duplicate_detection = each.value.requires_duplicate_detection
  duplicate_detection_history_time_window = each.value.requires_duplicate_detection ? (
    each.value.duplicate_detection_window
  ) : null
}

# ---------------------------------------------------------------------------
# Artifact container on the existing shared async storage account
# (no new storage account; no account-level lifecycle policy — avoid colliding
# with any policy already on the shared account)
# ---------------------------------------------------------------------------

resource "azurerm_storage_container" "ai_platform_v2_artifacts" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                  = local.ai_platform_v2_artifact_container
  storage_account_name  = data.azurerm_storage_account.ai_platform_v2_host[0].name
  container_access_type = "private"
}
