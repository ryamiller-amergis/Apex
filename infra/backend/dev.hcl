# Dev remote state. Use with:
#   terraform init -reconfigure -backend-config=backend/dev.hcl
#
# Values printed by scripts/bootstrap-tfstate.sh (run 2026-11-09).
# This file holds no secrets: auth is your Azure CLI login (Azure AD).

subscription_id      = "9d08693d-0c89-4f11-aa43-6cbdb89cf1cb"
tenant_id            = "4ecc6f49-04fd-4b4a-9ee4-c4e679a141d7"
resource_group_name  = "rg-apex-tfstate-dev"
storage_account_name = "stapextfstatedev"
container_name       = "tfstate"
key                  = "dev.tfstate"
use_azuread_auth     = true
