# Production alerts.
#
# Everything here is created only when alert_email_receivers is non-empty. Each
# alert names the user-facing failure it predicts: interviews and chats that hang,
# ADRs that never generate, repositories that cannot clone, and a disk or file
# share that the app can no longer use.

locals {
  alerts_enabled = length(var.alert_email_receivers) > 0

  # App Service (P1v3) gives prod and its staging slot one shared /home quota.
  app_service_storage_bytes = var.app_service_storage_quota_gb * 1024 * 1024 * 1024

  alert_log_queries = {
    interactive-turns-not-starting = {
      description = "Interactive turns are being reaped because no worker started or kept running them. Users see chats and interviews hang."
      severity    = 1
      threshold   = 2
      query       = <<-KQL
        traces
        | where message has "[reaper] Reaped interactive run"
      KQL
    }
    interactive-admission-failures = {
      description = "V2 refused turns because a skill, repository grounding, or MaxView connection was unavailable."
      severity    = 1
      threshold   = 0
      query       = <<-KQL
        traces
        | where message has_any ("INTERACTIVE_V2_SKILL_UNAVAILABLE", "INTERACTIVE_V2_GROUNDING_UNAVAILABLE", "INTERACTIVE_V2_MAXVIEW_UNAVAILABLE", "[durable-interactive] skill unavailable")
      KQL
    }
    interactive-worker-unhealthy = {
      description = "An interactive worker replica lost its Dapr sidecar or crashed on start."
      severity    = 1
      threshold   = 0
      query       = <<-KQL
        traces
        | where message has_any ("InteractiveSidecarUnhealthy", "InteractiveActorHostFatal")
      KQL
    }
    repo-storage = {
      description = "Repository storage is low or unusable: the disk is nearly full, a clone ran out of space, or the workspace share is not mounted."
      severity    = 1
      threshold   = 0
      query       = <<-KQL
        traces
        | where message has_any ("[repo-cache] disk-low", "[storage-health] failed", "Repository storage is full")
      KQL
    }
    adr-generation-failed = {
      description = "An ADR generation run ended without an ADR file or failed to start."
      severity    = 2
      threshold   = 0
      query       = <<-KQL
        traces
        | where message has_any ("[adr] generation produced no ADR", "[adr] ADR generation kickoff failed")
      KQL
    }
    app-exceptions = {
      description = "App Service is logging unhandled exceptions at an unusual rate."
      severity    = 2
      threshold   = 20
      query       = <<-KQL
        exceptions
        | where cloud_RoleName == "${var.app_service_name}"
      KQL
    }
  }

  alert_container_app_ids = {
    for name, app in data.azurerm_container_app.alerted : name => app.id
  }
}

resource "azurerm_monitor_action_group" "alerts" {
  count = local.alerts_enabled ? 1 : 0

  name                = "ag-apex-${var.environment}"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = substr("apex${var.environment}", 0, 12)

  dynamic "email_receiver" {
    for_each = var.alert_email_receivers
    content {
      name                    = "email-${email_receiver.key}"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# ── App Service ─────────────────────────────────────────────────────────────

resource "azurerm_monitor_metric_alert" "app_http_5xx" {
  count = local.alerts_enabled ? 1 : 0

  name                = "alert-apex-${var.environment}-http-5xx"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.main.id]
  description         = "App Service is returning server errors."
  severity            = 1
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "Http5xx"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = var.alert_http_5xx_threshold
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

resource "azurerm_monitor_metric_alert" "app_health_check" {
  count = local.alerts_enabled ? 1 : 0

  name                = "alert-apex-${var.environment}-health-check"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.main.id]
  description         = "An App Service instance is failing its health check."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "HealthCheckStatus"
    aggregation      = "Average"
    operator         = "LessThan"
    threshold        = 100
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# Azure reports file system usage every six hours, so this is an early warning.
# The storage availability test below catches a full disk within minutes.
resource "azurerm_monitor_metric_alert" "app_file_system" {
  for_each = local.alerts_enabled ? { warning = 0.70, critical = 0.85 } : {}

  name                = "alert-apex-${var.environment}-disk-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_linux_web_app.main.id]
  description         = "App Service storage (shared by prod and staging) is over ${floor(each.value * 100)}% full."
  severity            = each.key == "critical" ? 1 : 2
  frequency           = "PT1H"
  window_size         = "PT6H"

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "FileSystemUsage"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = floor(local.app_service_storage_bytes * each.value)
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# Checks the data root, the Azure Files workspace mount and free space from outside.
resource "azurerm_application_insights_standard_web_test" "storage" {
  count = local.alerts_enabled ? 1 : 0

  name                    = "webtest-apex-${var.environment}-storage"
  resource_group_name     = azurerm_resource_group.main.name
  location                = azurerm_application_insights.main.location
  application_insights_id = azurerm_application_insights.main.id
  frequency               = 900
  timeout                 = 30
  geo_locations           = ["us-va-ash-azr"]
  retry_enabled           = true

  request {
    url = "https://${azurerm_linux_web_app.main.default_hostname}/api/health/storage"
  }

  validation_rules {
    expected_status_code = 200
  }

  tags = merge(var.tags, { Environment = var.environment })

  lifecycle {
    # App Insights adds a hidden-link tag to every web test.
    ignore_changes = [tags]
  }
}

resource "azurerm_monitor_metric_alert" "storage_availability" {
  count = local.alerts_enabled ? 1 : 0

  name                = "alert-apex-${var.environment}-storage-health"
  resource_group_name = azurerm_resource_group.main.name
  scopes = [
    azurerm_application_insights_standard_web_test.storage[0].id,
    azurerm_application_insights.main.id,
  ]
  description = "The storage health check is failing: the data root is not writable, the workspace share is not mounted, or the disk is nearly full."
  severity    = 1
  frequency   = "PT5M"
  window_size = "PT15M"

  application_insights_web_test_location_availability_criteria {
    web_test_id           = azurerm_application_insights_standard_web_test.storage[0].id
    component_id          = azurerm_application_insights.main.id
    failed_location_count = 1
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# ── PostgreSQL ──────────────────────────────────────────────────────────────

resource "azurerm_monitor_metric_alert" "postgres" {
  for_each = local.alerts_enabled ? {
    down    = { metric = "is_db_alive", aggregation = "Maximum", operator = "LessThan", threshold = 1, severity = 0, description = "PostgreSQL is not responding." }
    cpu     = { metric = "cpu_percent", aggregation = "Average", operator = "GreaterThan", threshold = 85, severity = 2, description = "PostgreSQL CPU is above 85%." }
    storage = { metric = "storage_percent", aggregation = "Average", operator = "GreaterThan", threshold = 80, severity = 1, description = "PostgreSQL storage is above 80%." }
  } : {}

  name                = "alert-apex-${var.environment}-postgres-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = each.value.description
  severity            = each.value.severity
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = each.value.metric
    aggregation      = each.value.aggregation
    operator         = each.value.operator
    threshold        = each.value.threshold
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# ── Container Apps ──────────────────────────────────────────────────────────

# Looked up by name: some of these apps are managed outside this state.
data "azurerm_container_app" "alerted" {
  for_each = local.alerts_enabled ? toset(var.alert_container_app_names) : toset([])

  name                = each.value
  resource_group_name = var.alert_container_app_resource_group_name
}

resource "azurerm_monitor_metric_alert" "container_app_down" {
  for_each = local.alert_container_app_ids

  name                = "alert-${each.key}-down"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value]
  description         = "${each.key} has no running replica."
  severity            = 0
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Replicas"
    aggregation      = "Maximum"
    operator         = "LessThan"
    threshold        = 1
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

resource "azurerm_monitor_metric_alert" "container_app_restarts" {
  for_each = local.alert_container_app_ids

  name                = "alert-${each.key}-restarts"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value]
  description         = "${each.key} replicas are restarting repeatedly."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    threshold        = 2
  }

  action {
    action_group_id = azurerm_monitor_action_group.alerts[0].id
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# ── Application log alerts ──────────────────────────────────────────────────

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "app_logs" {
  for_each = local.alerts_enabled ? local.alert_log_queries : {}

  name                    = "alert-apex-${var.environment}-${each.key}"
  resource_group_name     = azurerm_resource_group.main.name
  location                = azurerm_application_insights.main.location
  description             = each.value.description
  severity                = each.value.severity
  scopes                  = [azurerm_application_insights.main.id]
  evaluation_frequency    = "PT5M"
  window_duration         = "PT15M"
  auto_mitigation_enabled = true

  criteria {
    query                   = each.value.query
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = each.value.threshold

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.alerts[0].id]
  }

  tags = merge(var.tags, { Environment = var.environment })
}

# ── Email hours ─────────────────────────────────────────────────────────────

# An alert that fires while suppressed does not email when the window opens.
resource "azurerm_monitor_alert_processing_rule_suppression" "outside_email_hours" {
  count = local.alerts_enabled && var.alert_email_hours != null ? 1 : 0

  name                = "apr-apex-${var.environment}-outside-email-hours"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = ["/subscriptions/${data.azurerm_client_config.current.subscription_id}"]
  description         = "Suppress Apex alert emails outside ${var.alert_email_hours.start}-${var.alert_email_hours.end} ${var.alert_email_hours.time_zone}."

  # Every rule in this file lives in the main resource group.
  condition {
    alert_rule_id {
      operator = "Contains"
      values   = ["/${azurerm_resource_group.main.name}/"]
    }
  }

  schedule {
    time_zone = var.alert_email_hours.time_zone

    recurrence {
      daily {
        start_time = "00:00:00"
        end_time   = var.alert_email_hours.start
      }
      daily {
        start_time = var.alert_email_hours.end
        end_time   = "23:59:59"
      }
    }
  }

  tags = merge(var.tags, { Environment = var.environment })
}
