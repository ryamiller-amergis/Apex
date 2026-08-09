output "resource_group_name" {
  description = "Name of the created resource group"
  value       = azurerm_resource_group.main.name
}

output "app_service_name" {
  description = "Name of the App Service"
  value       = azurerm_linux_web_app.main.name
}

output "app_service_url" {
  description = "URL of the deployed App Service"
  value       = "https://${azurerm_linux_web_app.main.default_hostname}"
}

output "app_service_staging_slot_url" {
  description = "URL of the staging deployment slot (blue-green target)"
  value       = var.enable_staging_slot ? "https://${azurerm_linux_web_app.main.name}-${var.staging_slot_name}.azurewebsites.net" : null
}

output "app_service_plan_name" {
  description = "Name of the App Service Plan"
  value       = azurerm_service_plan.main.name
}

output "application_insights_instrumentation_key" {
  description = "Application Insights Instrumentation Key"
  value       = azurerm_application_insights.main.instrumentation_key
  sensitive   = true
}

output "application_insights_connection_string" {
  description = "Application Insights Connection String"
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}

output "postgresql_server_fqdn" {
  description = "Fully qualified domain name of the PostgreSQL Flexible Server"
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgresql_database_name" {
  description = "Name of the PostgreSQL database"
  value       = azurerm_postgresql_flexible_server_database.main.name
}

output "postgresql_connection_string" {
  description = "Full PostgreSQL connection URI for the application"
  value       = "postgresql://${var.postgresql_admin_username}:${var.postgresql_admin_password}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${var.postgresql_database_name}?sslmode=require"
  sensitive   = true
}

# Shared async Blob platform
output "shared_storage_account_name" {
  description = "Shared private Storage Account for async workload artifacts"
  value       = azurerm_storage_account.shared.name
}

output "blob_container_names" {
  description = "Private blob containers provisioned on the shared storage account"
  value       = sort(keys(azurerm_storage_container.shared))
}

# Repository grounding bundle workload
output "grounding_storage_account_name" {
  description = "Storage Account used by repository grounding bundles"
  value       = azurerm_storage_account.shared.name
}

output "grounding_blob_container_name" {
  description = "Private Blob container used for immutable repository grounding bundles"
  value       = azurerm_storage_container.shared["repo-grounding"].name
}

output "grounding_app_setting_names" {
  description = "Non-secret app setting contract for repository grounding bundle storage"
  value = {
    blob_account_name   = "GROUNDING_BLOB_ACCOUNT_NAME"
    blob_container_name = "GROUNDING_BLOB_CONTAINER_NAME"
  }
}

# PDF workload (first consumer of shared blob)
output "pdf_storage_account_name" {
  description = "Storage Account used by PDF (alias of shared_storage_account_name)"
  value       = azurerm_storage_account.shared.name
}

output "pdf_blob_container_name" {
  description = "Private Blob container used for PDF artifacts"
  value       = azurerm_storage_container.shared[var.pdf_blob_container_name].name
}

output "pdf_api_managed_identity_principal_id" {
  description = "Apex App Service identity granted PDF Blob contributor role"
  value       = try(azurerm_linux_web_app.main.identity[0].principal_id, null)
}

output "pdf_staging_managed_identity_principal_id" {
  description = "Production staging-slot identity granted PDF Blob contributor role"
  value       = var.enable_staging_slot ? try(azurerm_linux_web_app_slot.staging[0].identity[0].principal_id, null) : null
}

output "pdf_app_setting_names" {
  description = "Non-secret app setting contract for PDF assembly inside the Apex application"
  value = {
    blob_account_name   = "PDF_BLOB_ACCOUNT_NAME"
    blob_container_name = "PDF_BLOB_CONTAINER_NAME"
  }
}

# ---------------------------------------------------------------------------
# Load Test module outputs (FEAT-002)
# Wire these into Apex app settings and the Container Apps Job environment
# for FEAT-007 (enqueue) and FEAT-008 (runner callback).
# ---------------------------------------------------------------------------

output "lt_servicebus_namespace_name" {
  description = "Load-test dedicated Service Bus namespace name (e.g. sbns-apex-lt-dev)"
  value       = azurerm_servicebus_namespace.load_test.name
}

output "lt_servicebus_namespace_fqdn" {
  description = "Load-test Service Bus FQDN for SDK connection (e.g. sbns-apex-lt-dev.servicebus.windows.net)"
  value       = "${azurerm_servicebus_namespace.load_test.name}.servicebus.windows.net"
}

output "lt_servicebus_queue_name" {
  description = "Load-test dispatch queue name"
  value       = azurerm_servicebus_queue.lt_dispatch.name
}

output "lt_servicebus_dlq_name" {
  description = "Load-test dead-letter queue name (Azure auto-creates as <queue>/$DeadLetterQueue)"
  value       = "${azurerm_servicebus_queue.lt_dispatch.name}/$DeadLetterQueue"
}

output "lt_data_resource_group_name" {
  description = "Resource group containing load-test Service Bus and shared Blob data resources"
  value       = azurerm_servicebus_namespace.load_test.resource_group_name
}

output "lt_compute_resource_group_name" {
  description = "Resource group containing the load-test Container Apps compute and runner identity"
  value       = azurerm_container_app_job.load_test_runner.resource_group_name
}

output "lt_container_app_environment_name" {
  description = "Container Apps Environment name for the load-test runner (e.g. cae-apex-lt-dev)"
  value       = azurerm_container_app_environment.load_test.name
}

output "lt_container_app_job_name" {
  description = "Container Apps Job name for the k6 runner (e.g. caj-apex-lt-dev)"
  value       = azurerm_container_app_job.load_test_runner.name
}

output "lt_container_app_job_id" {
  description = "Container Apps Job resource ID"
  value       = azurerm_container_app_job.load_test_runner.id
}

output "lt_blob_account_name" {
  description = "Storage Account holding load-test artifacts (shared Apex async account)"
  value       = azurerm_storage_account.shared.name
}

output "lt_blob_container_name" {
  description = "Blob container for load-test summary and time-series artifacts (90-day lifecycle)"
  value       = azurerm_storage_container.lt_artifacts.name
}

output "lt_acr_name" {
  description = "Load-test ACR name — set GitHub env var LT_ACR_NAME for runner image publish"
  value       = azurerm_container_registry.lt.name
}

output "lt_acr_login_server" {
  description = "Load-test ACR login server (e.g. acrapexltdev.azurecr.io)"
  value       = azurerm_container_registry.lt.login_server
}

output "lt_runner_image_repository" {
  description = "Repository name used by CI for the k6 runner image"
  value       = local.lt_runner_image_repository
}

output "lt_runner_identity_client_id" {
  description = "Runner user-assigned MI client ID — needed for FEAT-008 workload identity wiring"
  value       = azurerm_user_assigned_identity.lt_runner.client_id
}

output "lt_runner_identity_principal_id" {
  description = "Runner user-assigned MI principal ID — Azure RBAC reference"
  value       = azurerm_user_assigned_identity.lt_runner.principal_id
}

output "lt_runner_identity_id" {
  description = "Runner user-assigned MI resource ID — referenced by Container Apps Job identity block"
  value       = azurerm_user_assigned_identity.lt_runner.id
}

output "lt_api_app_setting_names" {
  description = "App setting key contract for the Apex API to wire load-test Service Bus + Blob + runner auth (FEAT-007)"
  value = {
    servicebus_namespace      = "LT_SERVICEBUS_NAMESPACE"
    servicebus_queue          = "LT_SERVICEBUS_QUEUE_NAME"
    blob_account_name         = "LT_BLOB_ACCOUNT_NAME"
    blob_container_name       = "LT_BLOB_CONTAINER_NAME"
    apex_callback_base_url    = "LT_APEX_CALLBACK_BASE_URL"
    runner_callback_token     = "LT_RUNNER_CALLBACK_TOKEN"
    callback_token_audience   = "LT_CALLBACK_TOKEN_AUDIENCE"
    runner_allowed_client_ids = "LT_RUNNER_ALLOWED_CLIENT_IDS"
  }
}

output "lt_callback_token_audience" {
  description = "AAD App ID URI for MI ingest JWTs when lt_enable_entra_ingest_app is true"
  value       = var.lt_enable_entra_ingest_app || var.lt_callback_token_audience != null ? local.lt_ingest_identifier_uri : null
}

output "lt_ingest_application_client_id" {
  description = "Client ID of the dedicated load-test ingest Entra application (null when disabled)"
  value       = try(azuread_application.lt_ingest[0].client_id, null)
}

output "lt_ingest_app_role_id" {
  description = "LoadTest.Runner app role ID (null when Entra ingest app disabled)"
  value       = try(random_uuid.lt_ingest_app_role[0].result, null)
}

# ---------------------------------------------------------------------------
# AI Runs background worker outputs (FEAT-003)
# Wire AI_RUNS_* app settings so the governor/publisher and KEDA share one cap.
# ---------------------------------------------------------------------------

output "ai_runs_servicebus_namespace_name" {
  description = "Shared AI-runs Service Bus namespace name (e.g. sbns-apex-ai-dev)"
  value       = azurerm_servicebus_namespace.ai_runs.name
}

output "ai_runs_servicebus_namespace_fqdn" {
  description = "AI-runs Service Bus FQDN (e.g. sbns-apex-ai-dev.servicebus.windows.net)"
  value       = "${azurerm_servicebus_namespace.ai_runs.name}.servicebus.windows.net"
}

output "ai_runs_background_queue_name" {
  description = "Background dispatch queue name (ai-runs-background)"
  value       = azurerm_servicebus_queue.ai_runs_background.name
}

output "ai_runs_background_dlq_name" {
  description = "Background dead-letter queue name"
  value       = "${azurerm_servicebus_queue.ai_runs_background.name}/$DeadLetterQueue"
}

output "ai_runs_max_in_flight" {
  description = "Global background in-flight cap (KEDA max_executions and AI_RUNS_BACKGROUND_INFLIGHT_LIMIT)"
  value       = var.ai_runs_max_in_flight
}

output "ai_runs_container_app_environment_name" {
  description = "Container Apps Environment for the AI-runs background Job"
  value       = azurerm_container_app_environment.ai_runs.name
}

output "ai_runs_container_app_job_name" {
  description = "Container Apps Job name for the AI-runs background runner"
  value       = azurerm_container_app_job.ai_runs_runner.name
}

output "ai_runs_container_app_job_id" {
  description = "Container Apps Job resource ID"
  value       = azurerm_container_app_job.ai_runs_runner.id
}

output "ai_runs_file_share_name" {
  description = "Azure Files share for pinned worker workspaces"
  value       = azurerm_storage_share.ai_runs_workspace.name
}

output "ai_runs_key_vault_name" {
  description = "Key Vault holding the AI-runs CURSOR_API_KEY"
  value       = var.ai_runs_key_vault_id == null ? azurerm_key_vault.ai_runs[0].name : split("/", var.ai_runs_key_vault_id)[8]
}

output "ai_runs_key_vault_id" {
  description = "Key Vault resource ID holding the AI-runs CURSOR_API_KEY"
  value       = local.ai_runs_key_vault_id
}

output "ai_runs_cursor_api_key_secret_name" {
  description = "Key Vault secret name consumed by the AI-runs Job"
  value       = "cursor-api-key"
}

output "ai_runs_workspace_mount_path" {
  description = "Shared checkout mount path used by App Service and AI-run compute"
  value       = var.ai_runs_workspace_mount_path
}

output "ai_runs_runner_image_repository" {
  description = "ACR repository name for the AI-runs runner image (on load-test ACR)"
  value       = local.ai_runs_image_repository
}

output "ai_runs_runner_identity_client_id" {
  description = "Runner user-assigned MI client ID"
  value       = azurerm_user_assigned_identity.ai_runs_runner.client_id
}

output "ai_runs_runner_identity_principal_id" {
  description = "Runner user-assigned MI principal ID"
  value       = azurerm_user_assigned_identity.ai_runs_runner.principal_id
}

output "ai_runs_runner_identity_id" {
  description = "Runner user-assigned MI resource ID"
  value       = azurerm_user_assigned_identity.ai_runs_runner.id
}

output "ai_runs_api_app_setting_names" {
  description = "App setting key contract for Apex API AI-runs dispatch (FEAT-002 publisher + governor)"
  value = {
    servicebus_namespace    = "AI_RUNS_SERVICEBUS_NAMESPACE"
    background_queue        = "AI_RUNS_BACKGROUND_QUEUE_NAME"
    inflight_limit          = "AI_RUNS_BACKGROUND_INFLIGHT_LIMIT"
    data_dir                = "AI_PILOT_DATA_DIR"
    runner_callback_token   = "AI_RUNS_RUNNER_CALLBACK_TOKEN"
    callback_token_audience = "AI_RUNS_CALLBACK_TOKEN_AUDIENCE"
  }
}

output "ai_runs_callback_token_audience" {
  description = "AAD App ID URI for MI ingest JWTs when enable_ai_runs_entra_app is true"
  value       = var.enable_ai_runs_entra_app || var.ai_runs_callback_token_audience != null ? local.ai_runs_ingest_identifier_uri : null
}

output "ai_runs_ingest_application_client_id" {
  description = "Client ID of the dedicated AI-runs ingest Entra application (null when disabled)"
  value       = try(azuread_application.ai_runs_ingest[0].client_id, null)
}

output "ai_runs_ingest_app_role_id" {
  description = "AiRun.Runner app role ID (null when Entra ingest app disabled)"
  value       = try(random_uuid.ai_runs_ingest_app_role[0].result, null)
}

# ---------------------------------------------------------------------------
# FEAT-007 — interactive lane (null while enable_ai_runs_interactive is false)
# ---------------------------------------------------------------------------

output "ai_runs_interactive_app_fqdn" {
  description = "WebSocket gateway ingress FQDN for the interactive Container App"
  value       = try(azurerm_container_app.ai_runs_interactive[0].ingress[0].fqdn, null)
}

output "ai_runs_interactive_dapr_app_id" {
  description = "Dapr app id addressed for in-cluster gateway→actor service invocation"
  value       = var.enable_ai_runs_interactive ? local.ai_runs_interactive_dapr_app_id : null
}

output "ai_runs_interactive_redis_hostname" {
  description = "Redis hostname backing the Dapr pub/sub + actor state store"
  value       = try(local.ai_runs_interactive_redis_hostname, null)
}

output "ai_runs_interactive_redis_ssl_port" {
  description = "Redis TLS port. App Service must mirror REDIS_HOST/REDIS_SSL_PORT (+ REDIS_KEY) so the WS gateway subscribes to the live bus."
  value       = try(local.ai_runs_interactive_redis_port, null)
}

output "ai_runs_interactive_capacity" {
  description = "Reserved warm floor + burst ceiling; App Service must mirror these as AI_RUNS_INTERACTIVE_RESERVED / _BURST_MAX"
  value = {
    reserved     = var.ai_runs_interactive_reserved
    burst_max    = var.ai_runs_interactive_burst_max
    max_replicas = var.enable_ai_runs_interactive ? local.ai_runs_interactive_max_replicas : null
  }
}
