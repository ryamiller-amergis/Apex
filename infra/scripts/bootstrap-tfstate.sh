#!/usr/bin/env bash
# One-time setup of the Azure Storage account that holds Terraform remote state
# for one environment. Run once per subscription, by someone who can create
# resource groups and assign roles there. Safe to re-run: existing resources are
# updated to the settings below rather than recreated.
#
#   infra/scripts/bootstrap-tfstate.sh <dev|prd> <subscription-id> <location> [resource-group] [storage-account]
#   infra/scripts/bootstrap-tfstate.sh dev 00000000-0000-0000-0000-000000000000 eastus
#
# TFSTATE_SKU=Standard_ZRS selects zone-redundant storage (default Standard_LRS).
# The account accepts Azure AD auth only (shared keys are disabled), so the
# signed-in user is granted Storage Blob Data Contributor on it.
set -euo pipefail
export MSYS_NO_PATHCONV=1

usage() {
  echo "Usage: $0 <dev|prd> <subscription-id> <location> [resource-group] [storage-account]" >&2
  exit 1
}

[ $# -ge 3 ] || usage

ENV=$1
SUBSCRIPTION=$2
LOCATION=$3
case "$ENV" in
  dev | prd) ;;
  *) usage ;;
esac

RG=${4:-rg-apex-tfstate-$ENV}
ACCOUNT=${5:-stapextfstate$ENV}
CONTAINER=tfstate
SKU=${TFSTATE_SKU:-Standard_LRS}
RETENTION_DAYS=30
ROLE="Storage Blob Data Contributor"

if ! [[ "$ACCOUNT" =~ ^[a-z0-9]{3,24}$ ]]; then
  echo "Storage account name must be 3-24 lowercase letters or digits: $ACCOUNT" >&2
  exit 1
fi

az account set --subscription "$SUBSCRIPTION"
TENANT=$(az account show --query tenantId -o tsv)

echo "Resource group $RG ($LOCATION)"
az group create --name "$RG" --location "$LOCATION" \
  --tags Workload=terraform-state Environment="$ENV" -o none

if az storage account show -g "$RG" -n "$ACCOUNT" -o none 2>/dev/null; then
  echo "Storage account $ACCOUNT exists; applying settings"
  az storage account update -g "$RG" -n "$ACCOUNT" \
    --allow-blob-public-access false \
    --allow-shared-key-access false \
    --min-tls-version TLS1_2 \
    --https-only true -o none
else
  if [ "$(az storage account check-name -n "$ACCOUNT" --query nameAvailable -o tsv)" != "true" ]; then
    echo "Storage account name $ACCOUNT is taken; pass a different name as the 5th argument" >&2
    exit 1
  fi
  echo "Creating storage account $ACCOUNT ($SKU)"
  az storage account create -g "$RG" -n "$ACCOUNT" -l "$LOCATION" \
    --kind StorageV2 --sku "$SKU" \
    --allow-blob-public-access false \
    --allow-shared-key-access false \
    --min-tls-version TLS1_2 \
    --https-only true \
    --tags Workload=terraform-state Environment="$ENV" -o none
fi

echo "Blob versioning and ${RETENTION_DAYS}-day soft delete"
az storage account blob-service-properties update -g "$RG" --account-name "$ACCOUNT" \
  --enable-versioning true \
  --enable-delete-retention true --delete-retention-days "$RETENTION_DAYS" \
  --enable-container-delete-retention true --container-delete-retention-days "$RETENTION_DAYS" \
  -o none

ACCOUNT_ID=$(az storage account show -g "$RG" -n "$ACCOUNT" --query id -o tsv)
USER_ID=$(az ad signed-in-user show --query id -o tsv)

if [ "$(az role assignment list --assignee "$USER_ID" --role "$ROLE" --scope "$ACCOUNT_ID" --query 'length(@)' -o tsv)" = "0" ]; then
  echo "Granting $ROLE to the signed-in user"
  az role assignment create --assignee-object-id "$USER_ID" --assignee-principal-type User \
    --role "$ROLE" --scope "$ACCOUNT_ID" -o none
else
  echo "Signed-in user already has $ROLE"
fi

# A new role assignment can take a few minutes to reach the data plane.
echo "Container $CONTAINER"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if az storage container create --name "$CONTAINER" --account-name "$ACCOUNT" \
    --auth-mode login --public-access off -o none 2>/dev/null; then
    break
  fi
  if [ "$attempt" = 10 ]; then
    echo "Could not create container $CONTAINER; check the role assignment and re-run" >&2
    exit 1
  fi
  echo "  waiting for role assignment to take effect (attempt $attempt)"
  sleep 30
done

cat <<EOF

Done. Put these values in infra/backend/$ENV.hcl:

subscription_id      = "$SUBSCRIPTION"
tenant_id            = "$TENANT"
resource_group_name  = "$RG"
storage_account_name = "$ACCOUNT"
container_name       = "$CONTAINER"
key                  = "$ENV.tfstate"
use_azuread_auth     = true
EOF
