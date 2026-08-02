locals {
  shared_storage_environment_token = replace(lower(var.environment), "/[^a-z0-9]/", "")
  shared_storage_account_name = coalesce(
    var.shared_storage_account_name,
    substr("stapex${local.shared_storage_environment_token}async", 0, 24)
  )
}

# Shared private blob account for Apex async workloads (PDF session artifacts first).
# Isolate modules with containers — not separate storage accounts — unless a
# workload needs a hard security, lifecycle, or cost boundary.
# Job delivery for PDF uses the Postgres queue (revised ADR); Service Bus is
# deferred until scale-up triggers fire — do not provision a broker by default.
resource "azurerm_storage_account" "shared" {
  name                            = local.shared_storage_account_name
  resource_group_name             = azurerm_resource_group.main.name
  location                        = azurerm_resource_group.main.location
  account_tier                    = "Standard"
  account_replication_type        = var.shared_storage_replication_type
  account_kind                    = "StorageV2"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = merge(var.tags, { Environment = var.environment, Workload = "shared-async" })

  blob_properties {
    versioning_enabled       = false
    last_access_time_enabled = true
  }
}

resource "azurerm_storage_container" "shared" {
  for_each = var.blob_containers

  name                  = each.key
  storage_account_name  = azurerm_storage_account.shared.name
  container_access_type = "private"
}

# Grounding bundles are server-only and use the Apex App Service managed
# identity. Keep this grant at the container boundary.
resource "azurerm_role_assignment" "grounding_api_blob_contributor" {
  scope                = azurerm_storage_container.shared["repo-grounding"].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "grounding_staging_blob_contributor" {
  count = var.enable_staging_slot ? 1 : 0

  scope                = azurerm_storage_container.shared["repo-grounding"].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app_slot.staging[0].identity[0].principal_id
}
