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
  ai_runs_interactive_redis_region = coalesce(var.ai_runs_interactive_redis_location, local.app_service_location)
  ai_runs_interactive_legacy_redis = local.ai_runs_interactive_enabled && var.ai_runs_interactive_redis_backend == "cache"
  ai_runs_interactive_managed_redis = (
    local.ai_runs_interactive_enabled
    && var.ai_runs_interactive_redis_backend == "managed"
  )
  ai_runs_interactive_dapr_app_id  = "apex-ai-interactive"
  ai_runs_interactive_max_replicas = var.ai_runs_interactive_reserved + var.ai_runs_interactive_burst_max
}

# ---------------------------------------------------------------------------
# Redis backplane — Dapr pub/sub (live fan-out) + actor state store.
# Existing environments can retain Azure Cache for Redis. New production
# environments use Azure Managed Redis because Azure blocks new legacy caches.
# Durability stays in Postgres agent_run_events.
# ---------------------------------------------------------------------------

resource "azurerm_redis_cache" "ai_runs_interactive" {
  count = local.ai_runs_interactive_legacy_redis ? 1 : 0

  name                 = local.ai_runs_interactive_redis_name
  location             = local.ai_runs_interactive_redis_region
  resource_group_name  = local.app_resource_group_name
  capacity             = var.ai_runs_interactive_redis_capacity
  family               = var.ai_runs_interactive_redis_family
  sku_name             = var.ai_runs_interactive_redis_sku
  non_ssl_port_enabled = false
  minimum_tls_version  = "1.2"

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-runs-interactive" })
}

resource "azapi_resource" "ai_runs_interactive_redis" {
  count = local.ai_runs_interactive_managed_redis ? 1 : 0

  type      = "Microsoft.Cache/redisEnterprise@2025-04-01"
  name      = local.ai_runs_interactive_redis_name
  location  = local.ai_runs_interactive_redis_region
  parent_id = local.use_dedicated_app_rg ? azurerm_resource_group.app[0].id : azurerm_resource_group.main.id

  body = {
    properties = {
      encryption        = {}
      highAvailability  = var.ai_runs_interactive_managed_redis_high_availability ? "Enabled" : "Disabled"
      minimumTlsVersion = "1.2"
    }
    sku = {
      name = var.ai_runs_interactive_managed_redis_sku
    }
  }

  response_export_values = ["properties.hostName"]
  tags                   = merge(var.tags, { Environment = var.environment, Workload = "ai-runs-interactive" })

  # The backplane holds no durable data (durability rides Postgres
  # agent_run_events), but the clustering policy is immutable — switching it
  # replaces the database. Provision the replacement BEFORE destroying the old
  # instance so the cutover has no downtime (requires a distinct redis name).
  lifecycle {
    create_before_destroy = true
  }
}

resource "azapi_resource" "ai_runs_interactive_redis_database" {
  count = local.ai_runs_interactive_managed_redis ? 1 : 0

  type      = "Microsoft.Cache/redisEnterprise/databases@2025-07-01"
  name      = "default"
  parent_id = azapi_resource.ai_runs_interactive_redis[0].id

  body = {
    properties = {
      accessKeysAuthentication = "Enabled"
      clientProtocol           = "Encrypted"
      clusteringPolicy         = var.ai_runs_interactive_managed_redis_clustering_policy
      evictionPolicy           = "VolatileLRU"
      modules                  = []
      port                     = 10000
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

data "azapi_resource_action" "ai_runs_interactive_redis_keys" {
  count = local.ai_runs_interactive_managed_redis ? 1 : 0

  type                   = "Microsoft.Cache/redisEnterprise/databases@2025-07-01"
  resource_id            = azapi_resource.ai_runs_interactive_redis_database[0].id
  action                 = "listKeys"
  method                 = "POST"
  response_export_values = ["primaryKey"]
}

locals {
  ai_runs_interactive_redis_hostname = local.ai_runs_interactive_managed_redis ? (
    azapi_resource.ai_runs_interactive_redis[0].output.properties.hostName
    ) : (
    azurerm_redis_cache.ai_runs_interactive[0].hostname
  )
  ai_runs_interactive_redis_port = local.ai_runs_interactive_managed_redis ? (
    10000
    ) : (
    azurerm_redis_cache.ai_runs_interactive[0].ssl_port
  )
  ai_runs_interactive_redis_key = local.ai_runs_interactive_managed_redis ? (
    data.azapi_resource_action.ai_runs_interactive_redis_keys[0].output.primaryKey
    ) : (
    azurerm_redis_cache.ai_runs_interactive[0].primary_access_key
  )
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
    value = local.ai_runs_interactive_redis_key
  }

  metadata {
    name  = "redisHost"
    value = "${local.ai_runs_interactive_redis_hostname}:${local.ai_runs_interactive_redis_port}"
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
    value = local.ai_runs_interactive_redis_key
  }

  metadata {
    name  = "redisHost"
    value = "${local.ai_runs_interactive_redis_hostname}:${local.ai_runs_interactive_redis_port}"
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

  # Short-term static ingest bridge (same token as the background Job). Required
  # while enable_ai_runs_entra_app is false; the actor host prefers this over MI.
  dynamic "secret" {
    for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
    content {
      name  = "ai-runs-runner-callback-token"
      value = var.ai_runs_runner_callback_token
    }
  }

  # Raw Redis primary key for the ioredis live-bus publisher (ephemeral live
  # fan-out). Distinct from the Dapr-managed redis-password above; the actor
  # publishes token/tool frames directly to Redis so the socket-holding App
  # Service gateway streams them in real time (durability stays in Postgres).
  secret {
    name  = "redis-key"
    value = local.ai_runs_interactive_redis_key
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
        # Same shared checkout path as App Service + background Job.
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
        value = local.ai_runs_data_dir
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

      # Raw ioredis live-bus connection (TLS 6380). Consumed by
      # interactiveLiveBus.resolveRedisConfig — REDIS_HOST + REDIS_SSL_PORT +
      # REDIS_KEY imply a TLS connection. Ephemeral live fan-out only.
      env {
        name  = "REDIS_HOST"
        value = local.ai_runs_interactive_redis_hostname
      }
      env {
        name  = "REDIS_SSL_PORT"
        value = tostring(local.ai_runs_interactive_redis_port)
      }
      env {
        name        = "REDIS_KEY"
        secret_name = "redis-key"
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

      # Opt the container (NODE_ENV=production) into the short-term static
      # callback bridge — without this flag resolveStaticAiRunnerCallbackToken
      # ignores AI_RUNS_RUNNER_CALLBACK_TOKEN in production runtimes.
      dynamic "env" {
        for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
        content {
          name  = "AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN"
          value = "true"
        }
      }

      dynamic "env" {
        for_each = var.ai_runs_runner_callback_token != null && var.ai_runs_runner_callback_token != "" ? [1] : []
        content {
          name        = "AI_RUNS_RUNNER_CALLBACK_TOKEN"
          secret_name = "ai-runs-runner-callback-token"
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
