# Real-Time Interactive Agent Transport — FEAT-007 / TBI-009 / PBI-007
#
# Provisions the interactive lane: a warm Azure Container App running the Dapr
# virtual-actor session host + stateless WebSocket gateway, plus an Azure Cache
# for Redis backplane used as the Dapr pub/sub (live fan-out) AND actor state
# store. Interactive turns are dispatched IN-CLUSTER (gateway → actor via Dapr
# service invocation) — NO ai-runs-interactive Service Bus queue is created;
# the ai-runs-background lane in ai-runs-worker.tf is unchanged (BR-013, VT-11).
#
# Reuses Phase 1 (FEAT-003): the ai-runs Container Apps Environment, the runner
# managed identity (already granted AcrPull + Key Vault Secrets User +
# AiRun.Runner), the shared Azure Files workspace mount, and the Cursor API key
# secret. The whole module is gated by enable_ai_runs_interactive so it stays
# additive and inert while the ai-runs-interactive flag is disabled.
#
# Backplane SKU: smallest Azure Cache for Redis tier meeting first-token latency
# (Basic C0 by default) — see assumptions.md "Live backplane component and SKU".

locals {
  ai_runs_interactive_enabled      = var.enable_ai_runs_interactive
  ai_runs_interactive_app_name     = coalesce(var.ai_runs_interactive_container_app_name, "ca-apex-ai-interactive-${var.environment}")
  ai_runs_interactive_redis_name   = coalesce(var.ai_runs_interactive_redis_name, "redis-apex-ai-${var.environment}")
  ai_runs_interactive_dapr_app_id  = "apex-ai-interactive"
  ai_runs_interactive_max_replicas = var.ai_runs_interactive_reserved + var.ai_runs_interactive_burst_max
}

# ---------------------------------------------------------------------------
# Azure Cache for Redis — Dapr pub/sub (live fan-out) + actor state store.
# The backplane carries only sanitized live run-event envelopes (BR-016/BR-019);
# durability stays in Postgres agent_run_events. Smallest tier by default.
# ---------------------------------------------------------------------------

resource "azurerm_redis_cache" "ai_runs_interactive" {
  count = local.ai_runs_interactive_enabled ? 1 : 0

  name                 = local.ai_runs_interactive_redis_name
  location             = local.app_service_location
  resource_group_name  = local.app_resource_group_name
  capacity             = var.ai_runs_interactive_redis_capacity
  family               = var.ai_runs_interactive_redis_family
  sku_name             = var.ai_runs_interactive_redis_sku
  non_ssl_port_enabled = false
  minimum_tls_version  = "1.2"

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-runs-interactive" })
}

# ---------------------------------------------------------------------------
# Dapr components (scoped to the interactive app id): pub/sub + actor state.
# Both point at the same Redis with different metadata; the state store sets
# actorStateStore=true so virtual actors can persist activation state.
# ---------------------------------------------------------------------------

resource "azurerm_container_app_environment_dapr_component" "ai_runs_interactive_pubsub" {
  count = local.ai_runs_interactive_enabled ? 1 : 0

  name                         = "interactive-pubsub"
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id
  component_type               = "pubsub.redis"
  version                      = "v1"
  scopes                       = [local.ai_runs_interactive_dapr_app_id]

  secret {
    name  = "redis-password"
    value = azurerm_redis_cache.ai_runs_interactive[0].primary_access_key
  }

  metadata {
    name  = "redisHost"
    value = "${azurerm_redis_cache.ai_runs_interactive[0].hostname}:${azurerm_redis_cache.ai_runs_interactive[0].ssl_port}"
  }
  metadata {
    name        = "redisPassword"
    secret_name = "redis-password"
  }
  metadata {
    name  = "enableTLS"
    value = "true"
  }
}

resource "azurerm_container_app_environment_dapr_component" "ai_runs_interactive_state" {
  count = local.ai_runs_interactive_enabled ? 1 : 0

  name                         = "interactive-actor-state"
  container_app_environment_id = azurerm_container_app_environment.ai_runs.id
  component_type               = "state.redis"
  version                      = "v1"
  scopes                       = [local.ai_runs_interactive_dapr_app_id]

  secret {
    name  = "redis-password"
    value = azurerm_redis_cache.ai_runs_interactive[0].primary_access_key
  }

  metadata {
    name  = "redisHost"
    value = "${azurerm_redis_cache.ai_runs_interactive[0].hostname}:${azurerm_redis_cache.ai_runs_interactive[0].ssl_port}"
  }
  metadata {
    name        = "redisPassword"
    secret_name = "redis-password"
  }
  metadata {
    name  = "enableTLS"
    value = "true"
  }
  # Required for Dapr virtual actors (single activation + turn-based concurrency).
  metadata {
    name  = "actorStateStore"
    value = "true"
  }
}

# ---------------------------------------------------------------------------
# Warm interactive Container App — Dapr virtual-actor host + WS gateway.
# min_replicas = reserved warm floor (no scale-to-zero); max = reserved + burst.
# Managed Dapr is enabled via the dapr block; WebSocket ingress via transport.
# ---------------------------------------------------------------------------

resource "azurerm_container_app" "ai_runs_interactive" {
  count = local.ai_runs_interactive_enabled ? 1 : 0

  name                         = local.ai_runs_interactive_app_name
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
    for_each = local.ai_runs_cursor_api_key_secret_id != null ? [1] : []
    content {
      name                = "cursor-api-key"
      key_vault_secret_id = local.ai_runs_cursor_api_key_secret_id
      identity            = azurerm_user_assigned_identity.ai_runs_runner.id
    }
  }

  # Managed Dapr — actor runtime + pub/sub backplane (in-cluster, mTLS).
  dapr {
    app_id       = local.ai_runs_interactive_dapr_app_id
    app_port     = var.ai_runs_interactive_target_port
    app_protocol = "http"
  }

  # WebSocket ingress: transport "auto" negotiates HTTP/1.1 upgrades (WS).
  ingress {
    external_enabled = true
    target_port      = var.ai_runs_interactive_target_port
    transport        = "auto"

    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    # Warm floor keeps reserved actors resident so first-token latency is not
    # gated by cold start (TBI-009 NFR). Burst adds headroom before shed.
    min_replicas = var.ai_runs_interactive_reserved
    max_replicas = local.ai_runs_interactive_max_replicas

    volume {
      name         = "ai-pilot-data"
      storage_type = "AzureFile"
      storage_name = azurerm_container_app_environment_storage.ai_runs_workspace.name
    }

    container {
      name   = "ai-runs-interactive"
      image  = var.ai_runs_interactive_image
      cpu    = var.ai_runs_interactive_cpu
      memory = var.ai_runs_interactive_memory

      volume_mounts {
        name = "ai-pilot-data"
        path = var.ai_runs_workspace_mount_path
      }

      env {
        name  = "APEX_CALLBACK_URL"
        value = var.ai_runs_apex_callback_base_url
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
        value = var.ai_runs_workspace_mount_path
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_RESERVED"
        value = tostring(var.ai_runs_interactive_reserved)
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_BURST_MAX"
        value = tostring(var.ai_runs_interactive_burst_max)
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_FIRST_TOKEN_SLO_MS"
        value = tostring(var.ai_runs_interactive_first_token_slo_ms)
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_DAPR_APP_ID"
        value = local.ai_runs_interactive_dapr_app_id
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_PUBSUB_NAME"
        value = "interactive-pubsub"
      }
      env {
        name  = "AI_RUNS_INTERACTIVE_STATE_STORE"
        value = "interactive-actor-state"
      }

      dynamic "env" {
        for_each = var.enable_ai_runs_entra_app || var.ai_runs_callback_token_audience != null ? [1] : []
        content {
          name  = "AI_RUNS_CALLBACK_TOKEN_AUDIENCE"
          value = local.ai_runs_ingest_identifier_uri
        }
      }

      dynamic "env" {
        for_each = local.ai_runs_cursor_api_key_secret_id != null ? [1] : []
        content {
          name        = "CURSOR_API_KEY"
          secret_name = "cursor-api-key"
        }
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-runs-interactive" })

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
    ]
  }

  depends_on = [
    azurerm_role_assignment.ai_runs_runner_kv_secrets_user,
    azurerm_role_assignment.ai_runs_runner_acr_pull,
  ]
}
