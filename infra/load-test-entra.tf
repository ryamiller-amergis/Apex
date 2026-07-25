# Load-test Entra (Azure AD) resources — FEAT-007/008 runner → Apex ingest auth
#
# OPTIONAL long-term path: dedicated Entra app + LoadTest.Runner role for MI JWTs.
# Short-term: leave lt_enable_entra_ingest_app=false and use LT_RUNNER_CALLBACK_TOKEN
# on App Service + Container Apps Job (see deploy workflows / GitHub secrets).
#
# Enabling requires the azuread provider principal to have
# Application.ReadWrite.OwnedBy (or Application.ReadWrite.All) and
# AppRoleAssignment.ReadWrite.All.

locals {
  lt_ingest_display_name = "apex-lt-ingest-${var.environment}"
  # Stable App ID URI used when the Entra ingest app is enabled.
  lt_ingest_identifier_uri = coalesce(
    var.lt_callback_token_audience,
    "api://apex-lt-ingest-${var.environment}",
  )
}

resource "random_uuid" "lt_ingest_app_role" {
  count = var.lt_enable_entra_ingest_app ? 1 : 0
}

resource "azuread_application" "lt_ingest" {
  count = var.lt_enable_entra_ingest_app ? 1 : 0

  display_name     = local.lt_ingest_display_name
  sign_in_audience = "AzureADMyOrg"

  identifier_uris = [local.lt_ingest_identifier_uri]

  app_role {
    allowed_member_types = ["Application"]
    description          = "Allow the Apex load-test Container Apps Job runner to call ingest APIs"
    display_name         = "LoadTest.Runner"
    enabled              = true
    id                   = random_uuid.lt_ingest_app_role[0].result
    value                = "LoadTest.Runner"
  }

  api {
    mapped_claims_enabled          = false
    requested_access_token_version = 2
  }

  feature_tags {
    enterprise = true
  }
}

resource "azuread_service_principal" "lt_ingest" {
  count = var.lt_enable_entra_ingest_app ? 1 : 0

  client_id                    = azuread_application.lt_ingest[0].client_id
  app_role_assignment_required = false

  feature_tags {
    enterprise = true
  }
}

# Grant the load-test runner user-assigned MI the LoadTest.Runner application role.
resource "azuread_app_role_assignment" "lt_runner_ingest" {
  count = var.lt_enable_entra_ingest_app ? 1 : 0

  app_role_id         = random_uuid.lt_ingest_app_role[0].result
  principal_object_id = azurerm_user_assigned_identity.lt_runner.principal_id
  resource_object_id  = azuread_service_principal.lt_ingest[0].object_id
}
