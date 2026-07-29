# Load Test Azure Infrastructure — FEAT-002
#
# Dedicated resources for the Apex Load Testing module. These are intentionally
# isolated from the shared async platform (shared-async.tf / pdf-processing.tf)
# because load-test dispatch must never share queue/compute with latency-sensitive
# platform workloads (PRD isolation driver; accepted ADR).
#
# Identity model:
#   lt_runner MI  — Container Apps Job executor:
#                   queue receive, blob contribute (lt-artifacts), Key Vault Secrets User,
#                   AcrPull (apex-lt-k6 images)
#   Apex API MI   — existing App Service system identity (pdf_api_principal_id):
#                   queue send, blob read (lt-artifacts)
#
# Resource naming follows the Apex convention {type}-apex-lt-{environment}:
#   sbns-apex-lt-dev / sbns-apex-lt-prd   Service Bus namespace
#   cae-apex-lt-dev  / cae-apex-lt-prd    Container Apps Environment
#   caj-apex-lt-dev  / caj-apex-lt-prd    Container Apps Job
#   mi-apex-lt-runner-dev / mi-apex-lt-runner-prd  Runner user-assigned identity
#   acrapexlt{env}                         ACR for apex-lt-k6 runner image (alphanumeric)
#   lt-artifacts                           Blob container (env already in account name)

locals {
  lt_namespace_name = coalesce(var.lt_servicebus_namespace_name, "sbns-apex-lt-${var.environment}")
  lt_queue_name     = coalesce(var.lt_servicebus_queue_name, "lt-dispatch")
  lt_cae_name       = coalesce(var.lt_container_app_env_name, "cae-apex-lt-${var.environment}")
  lt_job_name       = coalesce(var.lt_container_app_job_name, "caj-apex-lt-${var.environment}")
  lt_runner_mi_name = coalesce(var.lt_runner_identity_name, "mi-apex-lt-runner-${var.environment}")
  # ACR names are globally unique and alphanumeric-only (no hyphens).
  lt_acr_name                = coalesce(var.lt_acr_name, "acrapexlt${var.environment}")
  lt_blob_container          = coalesce(var.lt_blob_container_name, "lt-artifacts")
  lt_runner_image_repository = "apex-lt-k6"

  lt_runner_principal_id = azurerm_user_assigned_identity.lt_runner.principal_id
}

# ---------------------------------------------------------------------------
# Service Bus namespace — dedicated to load-test dispatch (not shared)
# ---------------------------------------------------------------------------

resource "azurerm_servicebus_namespace" "load_test" {
  name                = local.lt_namespace_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "Standard"
  tags                = merge(var.tags, { Environment = var.environment, Workload = "load-test" })
}

# Dispatch queue — primary consumer is the Container Apps Job (KEDA).
resource "azurerm_servicebus_queue" "lt_dispatch" {
  name         = local.lt_queue_name
  namespace_id = azurerm_servicebus_namespace.load_test.id

  # Dead-lettering for poison messages; max delivery attempts before DLQ.
  max_delivery_count                   = 5
  dead_lettering_on_message_expiration = true

  # Keep messages long enough for cold-start + max job duration (60 min).
  # Default lock duration 1 min; session lock is not required (FIFO not needed).
  lock_duration = "PT5M"
}

# SAS for the KEDA azure-servicebus scaler.
# KEDA polls queue length via the Service Bus management API, which requires
# Manage (EntityRead) — Listen-only returns 401 and DesiredJobCount stays 0.
# azurerm 3.x cannot set scale-rule identity_id (added in azurerm 4.73+);
# without a connection setting KEDA fails with:
#   "error parsing azure service bus metadata: no connection setting given"
# Runner message receive still uses the user-assigned MI (Data Receiver).
resource "azurerm_servicebus_namespace_authorization_rule" "lt_keda_listen" {
  name         = "lt-keda-listen"
  namespace_id = azurerm_servicebus_namespace.load_test.id

  listen = true
  send   = true
  manage = true
}

# ---------------------------------------------------------------------------
# Blob container for load-test artifacts (summary + time-series)
# Placed on the shared storage account; isolated by container + RBAC.
# ---------------------------------------------------------------------------

resource "azurerm_storage_container" "lt_artifacts" {
  name                  = local.lt_blob_container
  storage_account_name  = azurerm_storage_account.shared.name
  container_access_type = "private"
}

# ~90-day lifecycle policy on the load-test artifacts container.
# Manages the shared storage account's lifecycle policy. If another module
# requires lifecycle rules, extend the `rule` blocks here rather than
# creating a second azurerm_storage_management_policy resource.
resource "azurerm_storage_management_policy" "lt_artifacts_lifecycle" {
  storage_account_id = azurerm_storage_account.shared.id

  rule {
    name    = "lt-artifacts-90day"
    enabled = true

    filters {
      prefix_match = ["${local.lt_blob_container}/"]
      blob_types   = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 90
      }

      snapshot {
        delete_after_days_since_creation_greater_than = 90
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Runner user-assigned managed identity
# ---------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "lt_runner" {
  name                = local.lt_runner_mi_name
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name
  tags                = merge(var.tags, { Environment = var.environment, Workload = "load-test" })
}

# ---------------------------------------------------------------------------
# ACR — apex-lt-k6 runner images (published by PR deploy / production deploy)
# ---------------------------------------------------------------------------

resource "azurerm_container_registry" "lt" {
  name                = local.lt_acr_name
  resource_group_name = local.app_resource_group_name
  location            = local.app_service_location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = merge(var.tags, { Environment = var.environment, Workload = "load-test" })
}

# Runner pulls private images via the job's user-assigned identity.
resource "azurerm_role_assignment" "lt_runner_acr_pull" {
  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPull"
  principal_id         = local.lt_runner_principal_id
}

# GitHub Actions deploy SP(s) push images (set object IDs via lt_acr_push_principal_ids).
resource "azurerm_role_assignment" "lt_ci_acr_push" {
  for_each = toset(var.lt_acr_push_principal_ids)

  scope                = azurerm_container_registry.lt.id
  role_definition_name = "AcrPush"
  principal_id         = each.value
}

# ---------------------------------------------------------------------------
# RBAC — runner MI (queue receive + blob contribute + Key Vault Secrets User)
# ---------------------------------------------------------------------------

# Runner: receive from the dedicated dispatch queue only.
resource "azurerm_role_assignment" "lt_runner_sb_receiver" {
  scope                = azurerm_servicebus_queue.lt_dispatch.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = local.lt_runner_principal_id
}

# Runner: write and read artifacts in the load-test container only.
resource "azurerm_role_assignment" "lt_runner_blob_contributor" {
  scope                = azurerm_storage_container.lt_artifacts.resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = local.lt_runner_principal_id
}

# Runner: read Key Vault secrets for target auth injection at run time.
# Scope to the project Key Vault when var.lt_key_vault_id is set.
resource "azurerm_role_assignment" "lt_runner_kv_secrets_user" {
  count = var.lt_key_vault_id != null ? 1 : 0

  scope                = var.lt_key_vault_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = local.lt_runner_principal_id
}

# ---------------------------------------------------------------------------
# RBAC — Apex API identity (queue send + blob read)
# Created after the App Service identity is available (same two-apply pattern
# as pdf-processing.tf).
# ---------------------------------------------------------------------------

resource "azurerm_role_assignment" "lt_api_sb_sender" {
  scope                = azurerm_servicebus_queue.lt_dispatch.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "lt_api_blob_reader" {
  scope                = azurerm_storage_container.lt_artifacts.resource_manager_id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}

# Staging slot identity is slot-specific and does not move on swap (same pattern
# as staging_pdf_blob_contributor). Grant Send + Blob Reader so pre-swap smoke
# and staging-slot deploys can enqueue and read artifacts.
resource "azurerm_role_assignment" "lt_staging_sb_sender" {
  count = var.enable_staging_slot && var.lt_enable_staging_slot_rbac ? 1 : 0

  scope                = azurerm_servicebus_queue.lt_dispatch.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_linux_web_app_slot.staging[0].identity[0].principal_id
}

resource "azurerm_role_assignment" "lt_staging_blob_reader" {
  count = var.enable_staging_slot && var.lt_enable_staging_slot_rbac ? 1 : 0

  scope                = azurerm_storage_container.lt_artifacts.resource_manager_id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_web_app_slot.staging[0].identity[0].principal_id
}

# ---------------------------------------------------------------------------
# Container Apps Environment (VNet-integrated for non-prod target reachability)
# ---------------------------------------------------------------------------

resource "azurerm_container_app_environment" "load_test" {
  name                = local.lt_cae_name
  location            = local.app_service_location
  resource_group_name = local.app_resource_group_name

  # VNet integration is required for runner egress to allowlisted non-prod
  # targets (A-007). Provide var.lt_vnet_subnet_id when the VNet/subnet exists.
  # Leave null for initial stand-up; re-apply once the subnet is peered.
  # NOTE: internal_load_balancer_enabled must only be set alongside
  # infrastructure_subnet_id — omit both when VNet is not yet configured.
  infrastructure_subnet_id       = var.lt_vnet_subnet_id != null ? var.lt_vnet_subnet_id : null
  internal_load_balancer_enabled = var.lt_vnet_subnet_id != null ? true : null

  tags = merge(var.tags, { Environment = var.environment, Workload = "load-test" })
}

# ---------------------------------------------------------------------------
# Container Apps Job — KEDA Service Bus scaler, k6 runner image
# max_executions enforces global concurrency cap of 1–2 (default 2).
# ---------------------------------------------------------------------------

resource "azurerm_container_app_job" "load_test_runner" {
  name                         = local.lt_job_name
  location                     = local.app_service_location
  resource_group_name          = local.app_resource_group_name
  container_app_environment_id = azurerm_container_app_environment.load_test.id

  # Maximum wall-clock time for a single execution (60 min PRD guardrail).
  replica_timeout_in_seconds = 3600

  # User-assigned identity allows the runner to authenticate to Service Bus,
  # Blob, Key Vault, and private ACR without connection strings.
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.lt_runner.id]
  }

  registry {
    server   = azurerm_container_registry.lt.login_server
    identity = azurerm_user_assigned_identity.lt_runner.id
  }

  # KEDA scaler auth (SAS with Manage — required for queue-length polling).
  # Prefer scale-rule identity_id once on azurerm >= 4.73; until then the
  # connection secret is required.
  secret {
    name  = "lt-keda-sb-connection"
    value = azurerm_servicebus_namespace_authorization_rule.lt_keda_listen.primary_connection_string
  }

  # Short-term shared runner→Apex ingest token (omit when MI Entra path is enabled).
  dynamic "secret" {
    for_each = var.lt_runner_callback_token != null && var.lt_runner_callback_token != "" ? [1] : []
    content {
      name  = "lt-runner-callback-token"
      value = var.lt_runner_callback_token
    }
  }

  # Event-driven: scale from 0; KEDA fires one execution per queued message
  # up to max_executions. Extra messages wait on the queue (PBI-002 edge AC).
  event_trigger_config {
    parallelism              = 1
    replica_completion_count = 1

    scale {
      min_executions = 0
      max_executions = var.lt_max_executions

      rules {
        name             = "lt-servicebus-keda"
        custom_rule_type = "azure-servicebus"

        metadata = {
          queueName    = local.lt_queue_name
          namespace    = azurerm_servicebus_namespace.load_test.name
          messageCount = "1"
        }

        authentication {
          secret_name       = "lt-keda-sb-connection"
          trigger_parameter = "connection"
        }
      }
    }
  }

  template {
    container {
      name   = "k6-runner"
      image  = var.lt_runner_image
      cpu    = var.lt_runner_cpu
      memory = var.lt_runner_memory

      # Runtime configuration consumed by the entrypoint (FEAT-008).
      env {
        name  = "APEX_CALLBACK_URL"
        value = var.lt_apex_callback_base_url
      }

      dynamic "env" {
        for_each = var.lt_runner_callback_token != null && var.lt_runner_callback_token != "" ? [1] : []
        content {
          name        = "LT_RUNNER_CALLBACK_TOKEN"
          secret_name = "lt-runner-callback-token"
        }
      }

      # Long-term MI audience (only when Entra ingest app is enabled or explicitly set).
      dynamic "env" {
        for_each = var.lt_enable_entra_ingest_app || var.lt_callback_token_audience != null ? [1] : []
        content {
          name  = "LT_CALLBACK_TOKEN_AUDIENCE"
          value = local.lt_ingest_identifier_uri
        }
      }

      env {
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.lt_runner.client_id
      }

      env {
        name  = "AZURE_TENANT_ID"
        value = var.azure_tenant_id
      }

      env {
        name  = "LT_BLOB_ACCOUNT_NAME"
        value = azurerm_storage_account.shared.name
      }

      env {
        name  = "LT_BLOB_CONTAINER_NAME"
        value = azurerm_storage_container.lt_artifacts.name
      }

      env {
        name  = "LT_SERVICEBUS_NAMESPACE"
        value = azurerm_servicebus_namespace.load_test.name
      }

      env {
        name  = "LT_QUEUE_NAME"
        value = azurerm_servicebus_queue.lt_dispatch.name
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "load-test" })

  # CI (pr-tests / deploy) publishes a new apex-lt-k6 tag and updates the job
  # image outside Terraform. Ignore drift so plan/apply does not revert to the
  # placeholder image.
  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
    ]
  }
}
