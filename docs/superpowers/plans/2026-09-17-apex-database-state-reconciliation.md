# Apex Production Database Terraform State Reconciliation

## Purpose

Move Terraform ownership from stopped `psql-apex-eus2` to active
`psql-apex-cus` without creating, replacing, resizing, restarting, or deleting a
PostgreSQL server.

This runbook prepares state operations. Every state mutation and the eventual
old-server deletion require separate approval.

## Execution record

The user approved and the state-only reconciliation completed on 2026-09-17.

- State backup:
  `infra/terraform.tfstate.d/prd/pre-db-reconcile-20260917T1529Z.tfstate`
- Backup SHA-256:
  `3090dbf54812e036fc9cef6643375a1ec5cf2629ac5a5e5e51c3aaa2f501c8b2`
- Removed from state: the East US 2 server, database, and firewall rule
- Imported into the same addresses: the Central US server, database `hub`, and
  Azure-services firewall rule
- Azure resources changed: none
- Terraform apply executed: no
- Final refreshed plan: no changes

The stopped East US 2 server is no longer owned by Terraform. Its deletion
remains a separate user-approved operation.

## Verified resources

Before reconciliation, Terraform owned:

```text
azurerm_postgresql_flexible_server.main
  -> psql-apex-eus2
azurerm_postgresql_flexible_server_database.main
  -> psql-apex-eus2/databases/hub
azurerm_postgresql_flexible_server_firewall_rule.azure_services
  -> psql-apex-eus2/firewallRules/allow-azure-services
```

Production currently uses:

```text
Server: psql-apex-cus
Region: Central US
Zone: 1
SKU: Standard_D2ds_v5 / Terraform GP_Standard_D2ds_v5
Storage: 128 GiB
Backup retention: 30 days
Database: hub
HA: disabled
Public network access: enabled
```

Known runtime consumers pointing to `psql-apex-cus`:

- App Service production
- App Service staging
- `ca-apex-repo-read-d4-prd`

The AI Job and interactive Container App have no `DATABASE_URL`.

After reconciliation, the same three Terraform addresses point to
`psql-apex-cus`.

## Preconditions

The checklist below remains the reusable procedure for any future replay. The
execution record above captures the completed 2026-09-17 state transition; an
unchecked reusable item does not mean that transition is still pending.

- [ ] No deployment, slot swap, migration, or production Terraform operation is running.
- [ ] Azure subscription is `MSS-Production`.
- [ ] Terraform workspace is `prd`.
- [ ] Working tree contains the approved configuration changes only.
- [ ] Production and staging still point to `psql-apex-cus`.
- [ ] GitHub's production database hostname guard passes.
- [ ] `psql-apex-eus2` remains stopped and undeleted.
- [ ] Active Central US database backup status is healthy.
- [ ] Current Terraform state is copied to encrypted storage outside the repository.
- [ ] The operator and approving reviewer verify the exact state addresses and
  Azure resource IDs.

## Required configuration shape

Before state import, Terraform configuration and uncommitted production
variables must describe the active server:

```text
postgresql_server_name              = "psql-apex-cus"
postgresql_location                 = "Central US"
postgresql_sku_name                 = "GP_Standard_D2ds_v5"
postgresql_storage_mb               = 131072
postgresql_backup_retention_days    = 30
postgresql_availability_zone        = "1"
postgresql_high_availability_mode   = null
postgresql_azure_services_firewall_rule_name =
  "AllowAllAzureServicesAndResourcesWithinAzureIps_2026-8-25_19-7-14"
```

The active server also has an unmanaged one-IP client firewall rule. Do not
import or delete it as part of this reconciliation.

## Capture state backup

Run only after approval:

```bash
cd infra
terraform workspace select prd
terraform state pull > <encrypted-operator-path>/apex-prd-before-db-reconcile.tfstate
```

Record the backup checksum and state serial in the change ticket. Never place
the state file in the repository or chat.

## Confirm the expected pre-state plan

With configuration changed to Central US but state still pointing at East US 2,
a no-refresh plan is expected to show PostgreSQL replacement. This is evidence
that state reconciliation is required; it must not be applied.

```bash
terraform plan \
  -refresh=false \
  -no-color \
  -var-file=terraform.prd.tfvars
```

Stop if the plan includes unrelated resources.

## State transition

Run these commands only after a separate native approval and second-engineer
review.

Remove child resources first, then the server:

```bash
terraform state rm azurerm_postgresql_flexible_server_firewall_rule.azure_services
terraform state rm azurerm_postgresql_flexible_server_database.main
terraform state rm azurerm_postgresql_flexible_server.main
```

These commands change Terraform state only. They must not delete Azure
resources.

Import the active server:

```bash
terraform import \
  -var-file=terraform.prd.tfvars \
  azurerm_postgresql_flexible_server.main \
  "/subscriptions/2a8a9b11-bc1f-478d-84b4-a16375f3fae2/resourceGroups/rg-apex-prd-data/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-apex-cus"
```

Import database `hub`:

```bash
terraform import \
  -var-file=terraform.prd.tfvars \
  azurerm_postgresql_flexible_server_database.main \
  "/subscriptions/2a8a9b11-bc1f-478d-84b4-a16375f3fae2/resourceGroups/rg-apex-prd-data/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-apex-cus/databases/hub"
```

Import the active Azure-services firewall rule:

```bash
terraform import \
  -var-file=terraform.prd.tfvars \
  azurerm_postgresql_flexible_server_firewall_rule.azure_services \
  "/subscriptions/2a8a9b11-bc1f-478d-84b4-a16375f3fae2/resourceGroups/rg-apex-prd-data/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-apex-cus/firewallRules/AllowAllAzureServicesAndResourcesWithinAzureIps_2026-8-25_19-7-14"
```

## Mandatory post-import plan

```bash
terraform plan \
  -no-color \
  -detailed-exitcode \
  -lock-timeout=30s \
  -var-file=terraform.prd.tfvars
```

Required result:

- No PostgreSQL create, replace, resize, restart, or destroy
- No database or firewall replacement
- No App Service database-setting change
- No unrelated resource change
- No undeclared-variable warnings

If any requirement fails:

1. Do not apply.
2. Restore the state backup if state addresses are incorrect.
3. Correct configuration/state ownership.
4. Repeat import and plan review.

## Runtime verification

- [ ] Production database hostname remains `psql-apex-cus`.
- [ ] Staging database hostname remains `psql-apex-cus`.
- [ ] Repo-read database hostname remains `psql-apex-cus`.
- [ ] App health and database health endpoints respond normally.
- [ ] PostgreSQL connection, CPU, and error metrics show no regression.
- [ ] GitHub deployment database-host guard still passes.

## Old-server decommission gate

Delete `psql-apex-eus2` only when all are true:

- [ ] Terraform state contains no address under `psql-apex-eus2`.
- [ ] A refreshed Terraform plan does not recreate it.
- [ ] All known runtime consumers point to Central US.
- [ ] No deployment source references its hostname.
- [ ] The old server has remained stopped through the observation window.
- [ ] No user-facing or background feature failed because it was stopped.
- [ ] A final retained backup/export exists.
- [ ] The user explicitly approves deletion.

Deletion is a separate operation from state reconciliation and must never be
bundled into the same approval.
