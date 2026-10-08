# AI Platform V2 monitoring.
#
# App Service telemetry stays on the existing App Insights. The shared Container Apps
# Environment saves no logs by default, so a crashed replica leaves no reason behind.
# When enabled, its console and system logs go to a small Log Analytics workspace.

locals {
  ai_platform_v2_container_logs_enabled = local.ai_platform_v2_enabled && var.enable_ai_platform_v2_container_logs
}

resource "azurerm_log_analytics_workspace" "ai_platform_v2_container_logs" {
  count = local.ai_platform_v2_container_logs_enabled ? 1 : 0

  name                = "log-apex-ai-${var.environment}"
  location            = local.ai_platform_v2_location
  resource_group_name = data.azurerm_resource_group.ai_platform_v2_host[0].name
  sku                 = "PerGB2018"
  retention_in_days   = var.ai_platform_v2_container_logs_retention_days
  daily_quota_gb      = var.ai_platform_v2_container_logs_daily_quota_gb

  tags = merge(var.tags, { Environment = var.environment, Workload = "ai-platform-v2" })
}

# The environment is a host lookup, not managed here. "azure-monitor" routes logs through the
# diagnostic setting below, so no workspace shared key is stored on the environment.
resource "azapi_resource_action" "ai_platform_v2_container_logs_destination" {
  count = local.ai_platform_v2_container_logs_enabled ? 1 : 0

  type        = "Microsoft.App/managedEnvironments@2025-01-01"
  resource_id = data.azurerm_container_app_environment.ai_platform_v2_host[0].id
  method      = "PATCH"

  body = {
    properties = {
      appLogsConfiguration = {
        destination = "azure-monitor"
      }
    }
  }
}

resource "azurerm_monitor_diagnostic_setting" "ai_platform_v2_container_logs" {
  count = local.ai_platform_v2_container_logs_enabled ? 1 : 0

  name                       = "apex-ai-container-logs"
  target_resource_id         = data.azurerm_container_app_environment.ai_platform_v2_host[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.ai_platform_v2_container_logs[0].id

  enabled_log {
    category = "ContainerAppConsoleLogs"
  }

  enabled_log {
    category = "ContainerAppSystemLogs"
  }

  depends_on = [azapi_resource_action.ai_platform_v2_container_logs_destination]
}
