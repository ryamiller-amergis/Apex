# PDF assembly runs inside the Apex App Service (azurerm_linux_web_app.main).
# This file grants that app access to the shared pdf-artifacts container only —
# no separate worker host and no Service Bus (Postgres queue owns job delivery).

resource "azurerm_role_assignment" "api_pdf_blob_contributor" {
  scope                = azurerm_storage_container.shared[var.pdf_blob_container_name].resource_manager_id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_linux_web_app.main.identity[0].principal_id
}
