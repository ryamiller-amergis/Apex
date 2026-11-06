# Dev remote state. Use with:
#   terraform init -reconfigure -backend-config=backend/dev.hcl
#
# Replace the <...> placeholders with the values printed by
# scripts/bootstrap-tfstate.sh. Storage account names are globally unique; if
# the suggested name is taken, bootstrap with a suffix and record it here.
# This file holds no secrets: auth is your Azure CLI login (Azure AD).

subscription_id      = "<dev-subscription-id>"
tenant_id            = "<tenant-id>"
resource_group_name  = "rg-apex-tfstate-dev"
storage_account_name = "stapextfstatedev"
container_name       = "tfstate"
key                  = "dev.tfstate"
use_azuread_auth     = true
