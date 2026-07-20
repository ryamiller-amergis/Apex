# PDF assembly runs inside the Apex App Service (azurerm_linux_web_app.main).
# The App Service identity is the cross-cutting runtime principal for in-process
# Apex workloads, so it receives access at the shared Storage Account scope.
# No separate worker host or Service Bus is used (Postgres owns job delivery).

locals {
  # AzureRM 3.x reports null while adding a system identity to an existing Web
  # App. The first apply creates the identity; the next plan creates this RBAC
  # assignment after Azure returns its principal ID.
  pdf_api_principal_id = try(azurerm_linux_web_app.main.identity[0].principal_id, null)
}

resource "azurerm_role_assignment" "api_pdf_blob_contributor" {
  count = local.pdf_api_principal_id == null ? 0 : 1

  scope                = azurerm_storage_account.shared.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = local.pdf_api_principal_id
}
