# AI Platform V2 networking — additive Central US VNet/subnets (optional create)
#
# Zone-redundant CAE requires an infrastructure subnet. Either:
#   1) set ai_platform_v2_create_network = true (Terraform creates VNet + subnets), or
#   2) supply ai_platform_v2_infrastructure_subnet_id for an existing delegated subnet.
#
# Private-endpoint subnet is reserved for a later reversible phase; not wired yet.

locals {
  ai_platform_v2_create_network = local.ai_platform_v2_enabled && var.ai_platform_v2_create_network

  ai_platform_v2_vnet_name = coalesce(
    var.ai_platform_v2_vnet_name,
    "vnet-apex-ai-v2-${var.environment}"
  )

  ai_platform_v2_cae_subnet_name = coalesce(
    var.ai_platform_v2_cae_subnet_name,
    "snet-apex-ai-v2-cae-${var.environment}"
  )

  ai_platform_v2_app_subnet_name = coalesce(
    var.ai_platform_v2_app_service_subnet_name,
    "snet-apex-ai-v2-app-${var.environment}"
  )

  ai_platform_v2_pe_subnet_name = coalesce(
    var.ai_platform_v2_private_endpoint_subnet_name,
    "snet-apex-ai-v2-pe-${var.environment}"
  )

  ai_platform_v2_cae_subnet_id = local.ai_platform_v2_enabled ? (
    local.ai_platform_v2_create_network ? (
      azurerm_subnet.ai_platform_v2_cae[0].id
      ) : (
      var.ai_platform_v2_infrastructure_subnet_id
    )
  ) : null
}

resource "azurerm_virtual_network" "ai_platform_v2" {
  count = local.ai_platform_v2_create_network ? 1 : 0

  name                = local.ai_platform_v2_vnet_name
  location            = azurerm_resource_group.ai_platform_v2[0].location
  resource_group_name = azurerm_resource_group.ai_platform_v2[0].name
  address_space       = var.ai_platform_v2_vnet_address_space
  tags                = local.ai_platform_v2_tags
}

# /25 infrastructure subnet for zone-redundant Container Apps Environment.
resource "azurerm_subnet" "ai_platform_v2_cae" {
  count = local.ai_platform_v2_create_network ? 1 : 0

  name                 = local.ai_platform_v2_cae_subnet_name
  resource_group_name  = azurerm_resource_group.ai_platform_v2[0].name
  virtual_network_name = azurerm_virtual_network.ai_platform_v2[0].name
  address_prefixes     = [var.ai_platform_v2_cae_subnet_cidr]

  delegation {
    name = "Microsoft.App.environments"

    service_delegation {
      name = "Microsoft.App/environments"
      actions = [
        "Microsoft.Network/virtualNetworks/subnets/join/action",
      ]
    }
  }
}

# Reserved for future App Service VNet integration (not required for first smoke).
resource "azurerm_subnet" "ai_platform_v2_app" {
  count = local.ai_platform_v2_create_network ? 1 : 0

  name                 = local.ai_platform_v2_app_subnet_name
  resource_group_name  = azurerm_resource_group.ai_platform_v2[0].name
  virtual_network_name = azurerm_virtual_network.ai_platform_v2[0].name
  address_prefixes     = [var.ai_platform_v2_app_service_subnet_cidr]
}

# Reserved for a later private-endpoint phase (independent, reversible).
resource "azurerm_subnet" "ai_platform_v2_pe" {
  count = local.ai_platform_v2_create_network ? 1 : 0

  name                 = local.ai_platform_v2_pe_subnet_name
  resource_group_name  = azurerm_resource_group.ai_platform_v2[0].name
  virtual_network_name = azurerm_virtual_network.ai_platform_v2[0].name
  address_prefixes     = [var.ai_platform_v2_private_endpoint_subnet_cidr]
}

check "ai_platform_v2_subnet_required" {
  assert {
    condition = (
      !local.ai_platform_v2_enabled ||
      local.ai_platform_v2_cae_subnet_id != null
    )
    error_message = "enable_ai_platform_v2 requires ai_platform_v2_create_network=true or ai_platform_v2_infrastructure_subnet_id (zone-redundant CAE needs a /25 infrastructure subnet)."
  }
}
