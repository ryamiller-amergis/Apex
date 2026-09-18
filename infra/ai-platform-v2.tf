# AI Platform V2 foundation — additive Central US control plane
#
# Gated by enable_ai_platform_v2 (default false). Does not modify or destroy
# V1 East US Service Bus (sbns-apex-ai-*), shared async storage, or existing
# CAE/Jobs/interactive resources. Retirement of V1 is a later approved task.
#
# Immutable queue / CAE contracts live in ai-platform-v2-contracts.json.

locals {
  ai_platform_v2_enabled = var.enable_ai_platform_v2

  ai_platform_v2_contracts = jsondecode(file("${path.module}/ai-platform-v2-contracts.json"))

  ai_platform_v2_location = coalesce(var.ai_platform_v2_location, local.ai_platform_v2_contracts.location)

  ai_platform_v2_env_token = replace(lower(var.environment), "/[^a-z0-9]/", "")

  ai_platform_v2_rg_name = coalesce(
    var.ai_platform_v2_resource_group_name,
    "rg-apex-ai-v2-${var.environment}"
  )

  ai_platform_v2_sb_name = coalesce(
    var.ai_platform_v2_servicebus_namespace_name,
    "sbns-apex-ai-v2-${var.environment}"
  )

  ai_platform_v2_cae_name = coalesce(
    var.ai_platform_v2_container_app_env_name,
    "cae-apex-ai-v2-${var.environment}"
  )

  ai_platform_v2_storage_account_name = coalesce(
    var.ai_platform_v2_storage_account_name,
    substr("stapex${local.ai_platform_v2_env_token}aiv2", 0, 24)
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

# Dedicated Central US RG so V2 is not forced into the East US main RG.
resource "azurerm_resource_group" "ai_platform_v2" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name     = local.ai_platform_v2_rg_name
  location = local.ai_platform_v2_location
  tags     = local.ai_platform_v2_tags
}

# ---------------------------------------------------------------------------
# Service Bus — new Central US Standard namespace + V2 queues
# ---------------------------------------------------------------------------

resource "azurerm_servicebus_namespace" "ai_platform_v2" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                = local.ai_platform_v2_sb_name
  location            = azurerm_resource_group.ai_platform_v2[0].location
  resource_group_name = azurerm_resource_group.ai_platform_v2[0].name
  sku                 = local.ai_platform_v2_contracts.sku
  tags                = local.ai_platform_v2_tags
}

resource "azurerm_servicebus_queue" "ai_platform_v2" {
  for_each = local.ai_platform_v2_enabled ? local.ai_platform_v2_queues : {}

  name         = each.key
  namespace_id = azurerm_servicebus_namespace.ai_platform_v2[0].id

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
# Artifact storage — new Central US account (V1 shared async stays East US)
# ---------------------------------------------------------------------------

resource "azurerm_storage_account" "ai_platform_v2_artifacts" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                            = local.ai_platform_v2_storage_account_name
  resource_group_name             = azurerm_resource_group.ai_platform_v2[0].name
  location                        = azurerm_resource_group.ai_platform_v2[0].location
  account_tier                    = "Standard"
  account_replication_type        = var.ai_platform_v2_storage_replication_type
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  # First smoke keeps public network access; private endpoints are a later phase.
  public_network_access_enabled = true
  tags                          = local.ai_platform_v2_tags

  blob_properties {
    versioning_enabled       = false
    last_access_time_enabled = true
  }
}

resource "azurerm_storage_container" "ai_platform_v2_artifacts" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  name                  = local.ai_platform_v2_artifact_container
  storage_account_name  = azurerm_storage_account.ai_platform_v2_artifacts[0].name
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "ai_platform_v2_artifacts" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  storage_account_id = azurerm_storage_account.ai_platform_v2_artifacts[0].id

  rule {
    name    = "ai-run-artifacts-lifecycle"
    enabled = true

    filters {
      prefix_match = ["${local.ai_platform_v2_artifact_container}/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = coalesce(
          var.ai_platform_v2_artifact_lifecycle_days,
          local.ai_platform_v2_contracts.artifactLifecycleDays
        )
      }

      snapshot {
        delete_after_days_since_creation_greater_than = coalesce(
          var.ai_platform_v2_artifact_lifecycle_days,
          local.ai_platform_v2_contracts.artifactLifecycleDays
        )
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Container Apps Environment — zone-redundant at creation + workload profiles
# zoneRedundant is not on azurerm ~> 3.x CAE, so create via AzAPI (immutable).
# Logs use azure-monitor (resource-specific tables) per Task 4.
# ---------------------------------------------------------------------------

resource "azapi_resource" "ai_platform_v2_cae" {
  count = local.ai_platform_v2_enabled ? 1 : 0

  type      = "Microsoft.App/managedEnvironments@2024-03-01"
  name      = local.ai_platform_v2_cae_name
  location  = azurerm_resource_group.ai_platform_v2[0].location
  parent_id = azurerm_resource_group.ai_platform_v2[0].id
  tags      = local.ai_platform_v2_tags

  body = {
    properties = {
      zoneRedundant = local.ai_platform_v2_contracts.zoneRedundant
      appLogsConfiguration = {
        destination = "azure-monitor"
      }
      vnetConfiguration = {
        infrastructureSubnetId = local.ai_platform_v2_cae_subnet_id
        internal               = var.ai_platform_v2_internal_load_balancer
      }
      workloadProfiles = [
        for profile in local.ai_platform_v2_contracts.workloadProfiles : merge(
          {
            name                = profile.name
            workloadProfileType = profile.workloadProfileType
          },
          try(profile.minimumCount, null) != null ? { minimumCount = profile.minimumCount } : {},
          try(profile.maximumCount, null) != null ? { maximumCount = profile.maximumCount } : {}
        )
      ]
    }
  }

  response_export_values = ["id", "properties"]
}

# Route CAE diagnostics into Log Analytics when a workspace is configured.
resource "azurerm_monitor_diagnostic_setting" "ai_platform_v2_cae" {
  count = local.ai_platform_v2_enabled && local.ai_platform_v2_log_analytics_workspace_id != null ? 1 : 0

  name                       = "diag-cae-apex-ai-v2-${var.environment}"
  target_resource_id         = azapi_resource.ai_platform_v2_cae[0].id
  log_analytics_workspace_id = local.ai_platform_v2_log_analytics_workspace_id

  enabled_log {
    category = "ContainerAppConsoleLogs"
  }

  enabled_log {
    category = "ContainerAppSystemLogs"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}
