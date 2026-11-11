# Production remote state. Use with:
#   terraform init -reconfigure -backend-config=backend/prd.hcl
#
# Values printed by scripts/bootstrap-tfstate.sh (run 2026-11-09).
# This file holds no secrets: auth is your Azure CLI login (Azure AD).

subscription_id      = "2a8a9b11-bc1f-478d-84b4-a16375f3fae2"
tenant_id            = "4ecc6f49-04fd-4b4a-9ee4-c4e679a141d7"
resource_group_name  = "rg-apex-tfstate-prd"
storage_account_name = "stapextfstateprd"
container_name       = "tfstate"
key                  = "prd.tfstate"
use_azuread_auth     = true
