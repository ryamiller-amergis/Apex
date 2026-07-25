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
  description = "App setting key contract for the Apex API to wire load-test Service Bus + Blob access (FEAT-007)"
  value = {
    servicebus_namespace = "LT_SERVICEBUS_NAMESPACE"
    servicebus_queue     = "LT_SERVICEBUS_QUEUE_NAME"
    blob_account_name    = "LT_BLOB_ACCOUNT_NAME"
    blob_container_name  = "LT_BLOB_CONTAINER_NAME"
  }
}
