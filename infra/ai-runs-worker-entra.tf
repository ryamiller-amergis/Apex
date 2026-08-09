# AI-runs Entra (Azure AD) resources — FEAT-003 runner → Apex ingest auth
#
# OPTIONAL long-term path: dedicated Entra app + AiRun.Runner role for MI JWTs.
# Short-term: leave enable_ai_runs_entra_app=false and use AI_RUNS_RUNNER_CALLBACK_TOKEN
# on App Service + Container Apps Job (mirrors load-test lt_runner_callback_token).
#
# Enabling requires the azuread provider principal to have
# Application.ReadWrite.OwnedBy (or Application.ReadWrite.All) and
# AppRoleAssignment.ReadWrite.All.

locals {
  ai_runs_ingest_display_name = "apex-ai-runs-ingest-${var.environment}"
  ai_runs_ingest_identifier_uri = coalesce(
    var.ai_runs_callback_token_audience,
    "api://apex-ai-runs-ingest-${var.environment}",
  )
}

resource "random_uuid" "ai_runs_ingest_app_role" {
  count = var.enable_ai_runs_entra_app ? 1 : 0
}

resource "azuread_application" "ai_runs_ingest" {
  count = var.enable_ai_runs_entra_app ? 1 : 0

  display_name     = local.ai_runs_ingest_display_name
  sign_in_audience = "AzureADMyOrg"

  identifier_uris = [local.ai_runs_ingest_identifier_uri]

  app_role {
    allowed_member_types = ["Application"]
    description          = "Allow the Apex AI-runs Container Apps Job runner to call ingest APIs"
    display_name         = "AiRun.Runner"
    enabled              = true
    id                   = random_uuid.ai_runs_ingest_app_role[0].result
    value                = "AiRun.Runner"
  }

  api {
    mapped_claims_enabled          = false
    requested_access_token_version = 2
  }

  feature_tags {
    enterprise = true
  }
}

resource "azuread_service_principal" "ai_runs_ingest" {
  count = var.enable_ai_runs_entra_app ? 1 : 0

  client_id                    = azuread_application.ai_runs_ingest[0].client_id
  app_role_assignment_required = false

  feature_tags {
    enterprise = true
  }
}

# Grant the AI-runs runner user-assigned MI the AiRun.Runner application role.
resource "azuread_app_role_assignment" "ai_runs_runner_ingest" {
  count = var.enable_ai_runs_entra_app ? 1 : 0

  app_role_id         = random_uuid.ai_runs_ingest_app_role[0].result
  principal_object_id = azurerm_user_assigned_identity.ai_runs_runner.principal_id
  resource_object_id  = azuread_service_principal.ai_runs_ingest[0].object_id
}
