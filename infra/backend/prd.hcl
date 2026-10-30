# Production remote state. Use with:
#   terraform init -reconfigure -backend-config=backend/prd.hcl
#
# Replace the <...> placeholders with the values printed by
# scripts/bootstrap-tfstate.sh. Storage account names are globally unique; if
# the suggested name is taken, bootstrap with a suffix and record it here.
# This file holds no secrets: auth is your Azure CLI login (Azure AD).

subscription_id      = "<prd-subscription-id>"
tenant_id            = "<tenant-id>"
resource_group_name  = "rg-apex-tfstate-prd"
storage_account_name = "stapextfstateprd"
container_name       = "tfstate"
key                  = "prd.tfstate"
use_azuread_auth     = true
