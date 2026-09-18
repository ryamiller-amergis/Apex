# AI Platform V2 monitoring — Log Analytics for the new CAE
#
# Prefer an existing workspace ID (e.g. law-apex-ai-prd from R0). Optionally
# create a dedicated Central US workspace when none is supplied.
# Private endpoints and network diagnostics for PE phase are deferred.

locals {
  ai_platform_v2_create_log_analytics = (
    local.ai_platform_v2_enabled &&
    var.ai_platform_v2_log_analytics_workspace_id == null &&
    var.ai_platform_v2_create_log_analytics_workspace
  )

  ai_platform_v2_log_analytics_name = coalesce(
    var.ai_platform_v2_log_analytics_workspace_name,
    "law-apex-ai-v2-${var.environment}"
  )

  ai_platform_v2_log_analytics_workspace_id = local.ai_platform_v2_enabled ? (
    var.ai_platform_v2_log_analytics_workspace_id != null ? (
      var.ai_platform_v2_log_analytics_workspace_id
      ) : (
      local.ai_platform_v2_create_log_analytics ? azurerm_log_analytics_workspace.ai_platform_v2[0].id : null
    )
  ) : null
}

resource "azurerm_log_analytics_workspace" "ai_platform_v2" {
  count = local.ai_platform_v2_create_log_analytics ? 1 : 0

  name                = local.ai_platform_v2_log_analytics_name
  location            = azurerm_resource_group.ai_platform_v2[0].location
  resource_group_name = azurerm_resource_group.ai_platform_v2[0].name
  sku                 = "PerGB2018"
  retention_in_days   = var.ai_platform_v2_log_analytics_retention_days
  tags                = local.ai_platform_v2_tags
}

check "ai_platform_v2_log_analytics_required" {
  assert {
    condition = (
      !local.ai_platform_v2_enabled ||
      local.ai_platform_v2_log_analytics_workspace_id != null
    )
    error_message = "enable_ai_platform_v2 requires ai_platform_v2_log_analytics_workspace_id or ai_platform_v2_create_log_analytics_workspace=true."
  }
}
