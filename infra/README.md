# Azure Infrastructure for AI-Pilot

This directory contains Terraform configuration for provisioning Azure resources for the AI-Pilot application.

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.0
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli) installed and authenticated
- Azure subscription with appropriate permissions


## Resources Created

- **Resource Group**: Container for all Azure resources
- **App Service Plan**: Linux-based plan with Node.js support (B1 tier)
- **App Service**: Linux web app running Node.js 24 LTS
- **Application Insights**: Monitoring and telemetry
- **Shared async Blob storage**: One private Storage Account per environment; modules isolate via private containers (`pdf-artifacts`, `repo-grounding`, and load-test `lt-artifacts`)
- **Managed-identity access**: The cross-cutting Apex App Service identity is scoped to the shared Storage Account. PDF assembly has moved to DocHub; the `pdf-artifacts` container is kept so apply does not destroy existing blobs. Job delivery for remaining Apex async work uses the Postgres queue (Service Bus deferred).
- **Load Test infrastructure** (FEAT-002): Dedicated Service Bus namespace, Container Apps Job, and managed identities — see [Load Test module](#load-test-module-feat-002) below.
- **AI Runs background worker** (FEAT-003): Shared AI-runs Service Bus namespace (`sbns-apex-ai-*`), `ai-runs-background` queue, KEDA Container Apps Job, runner MI, Azure Files workspace mount — see [AI Runs worker module](#ai-runs-background-worker-module-feat-003) below.
- **My Work Cursor worker Job** (dev and production): Manual Container Apps Job in `cae-apex-ai-{environment}` that Apex starts for each cloud-agent run — see [My Work Cursor worker Job](#my-work-cursor-worker-job-dev-and-production).
- **Repo read service** (optional): Container App serving git reads from ephemeral disk; gated by `enable_repo_read_service` — see [Repo read service](#repo-read-service) below.

## Shared async platform conventions

Prefer extending the shared storage account over provisioning one-offs:

| Need | Add | Do not |
|------|-----|--------|
| Binary/session artifacts for a module | A private container in `blob_containers` | A second storage account (unless hard isolation is required) |
| Background jobs at current PDF scale | Postgres job queue (app-owned) | Service Bus "because async" |
| Bounded background AI execution (accepted ADR) | Shared `sbns-apex-ai-*` namespace + per-lane queue | Dedicated namespace per lane; mega-queue |
| Worker compute | Prefer in-app on the Apex App Service unless isolation/scale requires a dedicated host | New App Service “because the feature is async” |

RBAC defaults to least-privilege per container (or queue). The shared Apex App Service identity is the documented exception because it hosts multiple in-process workloads and receives Blob Data Contributor at the shared account scope. Service Bus is provisioned only for accepted ADR scale-up paths (load-test dedicated namespace; AI-runs shared namespace).
## Setup

1. **Authenticate with Azure**:
   ```bash
   az login
   az account set --subscription "Your-Subscription-Name"
   ```

2. **Create your configuration file**:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   ```

3. **Edit `terraform.tfvars`** with your actual values:
   - Update Azure DevOps organization URL
   - Add your Personal Access Token (PAT)
   - Set project name
   - Copy App Service `GITHUB_ORG` / `GITHUB_TOKEN` into `github_org` / `github_token` so GitHub projects (including Apex) can be cloned by the repo-read Container App
   - Customize resource names if needed

4. **Initialize Terraform** against the dev remote state (see [Environments and remote state](#environments-and-remote-state)):
   ```bash
   terraform init -reconfigure -backend-config=backend/dev.hcl
   ```

5. **Review the plan**:
   ```bash
   terraform plan
   ```

6. **Apply the configuration**:
   ```bash
   terraform apply
   ```

## Environments and remote state

Dev and prod share the same `.tf` files but use separate **state keys**, **tfvars files**, and **Azure subscriptions**. State lives in Azure Storage, not on a laptop. Terraform workspaces are no longer used: the backend config file you pass to `terraform init` selects the environment.

| | Dev (lower) | Production |
|---|-------------|------------|
| **Backend config** | `backend/dev.hcl` | `backend/prd.hcl` |
| **State blob** | `tfstate/dev.tfstate` in the dev state account | `tfstate/prd.tfstate` in the prod state account |
| **Variables file** | `terraform.tfvars` (auto-loaded) | `terraform.prd.tfvars` (pass with `-var-file`) |
| **Azure subscription** | `MSS-DevTest` | `MSS-Production` |

`variables.tf` only defines variable names and defaults — it does not select an environment. Unset variables in `terraform.tfvars` use defaults (e.g. `B1` plan, no staging slot). Prod-only settings (P1v3, zone redundancy, staging slot, separate app resource group) belong in `terraform.prd.tfvars` only.

### Remote state

- **One state storage account per subscription** (`stapextfstatedev`, `stapextfstateprd` by default; names are globally unique, so yours may carry a suffix), each in its own resource group (`rg-apex-tfstate-dev`, `rg-apex-tfstate-prd`) and a private `tfstate` container. The state account is created by `scripts/bootstrap-tfstate.sh`, not by this module, so destroying the stack cannot delete its own state.
- **Locking**: the azurerm backend takes a blob lease on the state file for every `plan` and `apply`. A second run waits or fails with a lock error instead of overwriting state. If a crashed run leaves a lease behind, confirm nobody is running Terraform, then `terraform force-unlock <lock-id>`.
- **Auth**: Azure AD only (`use_azuread_auth = true`; shared keys are disabled on the account). Your `az login` identity needs `Storage Blob Data Contributor` on the state account. No keys or SAS tokens are stored anywhere.
- **Recovery**: blob versioning and 30-day blob and container soft delete are on, so an earlier state version can be restored from the portal.
- `.terraform.lock.hcl` is committed so everyone, and later the pipeline, uses the same provider versions. Run `terraform init -upgrade` only on purpose, and commit the resulting lock file.

Point your checkout at an environment (re-run whenever you switch):

```bash
cd infra
terraform init -reconfigure -backend-config=backend/dev.hcl   # or backend/prd.hcl
```

### Check where you are

```bash
grep -E 'storage_account_name|key' .terraform/terraform.tfstate   # backend this checkout uses
az account show --query "{subscription:name}" -o table
```

### Dev (lower environment)

```bash
az account set --subscription "MSS-DevTest"
cd infra
terraform init -reconfigure -backend-config=backend/dev.hcl
terraform plan    # loads terraform.tfvars automatically
```

### Production

```bash
az account set --subscription "MSS-Production"
cd infra
terraform init -reconfigure -backend-config=backend/prd.hcl
terraform plan -var-file="terraform.prd.tfvars"
```

### One-time bootstrap (per subscription)

Someone who can create resource groups and assign roles in the subscription runs:

```bash
az login
infra/scripts/bootstrap-tfstate.sh dev <dev-subscription-id> eastus   # prd: ... prd <prd-subscription-id> eastus
```

The script creates the resource group, the StorageV2 account (public blob access off, TLS 1.2 minimum, shared keys off, versioning and soft delete on), and the private `tfstate` container, and grants the caller `Storage Blob Data Contributor`. Set `TFSTATE_SKU=Standard_ZRS` for zone-redundant storage, and pass a resource group and account name as the 4th and 5th arguments if the defaults are taken. It prints the values to copy into `backend/<env>.hcl`; commit that file (it holds no secrets). Grant `Storage Blob Data Contributor` on the account to every other person who runs `plan`.

### One-time migration from local state

Do this once per environment, by the person who holds that environment's local state, with nobody else running Terraform. **Back up first.** Prod is currently one apply ahead of dev; that is expected and is not drift.

**Dev** (local `default` workspace, `infra/terraform.tfstate`):

```bash
cd infra
terraform workspace show                       # must print: default
cp terraform.tfstate ~/apex-dev-backup.tfstate
git pull                                       # brings in the backend block and backend/dev.hcl
az account set --subscription "MSS-DevTest"
terraform init -migrate-state -backend-config=backend/dev.hcl   # answer "yes" to copy state
terraform plan -var-file=terraform.tfvars
```

`scripts/dev-aiv2-tf.sh` still selects a separate local `dev-aiv2` workspace. This runbook does not move it; leave that workspace's local state in place until it gets its own state key.

The only changes the plan should show are the resources prod received in its most recent apply. Anything else means dev state and the code disagree; stop and investigate before applying.

**Prod** (local `prd` workspace, `infra/terraform.tfstate.d/prd/terraform.tfstate`):

```bash
cd infra
# BEFORE pulling the backend change:
terraform workspace select prd
terraform state pull > ~/apex-prd-backup.tfstate

git pull                                       # brings in the backend block and backend/prd.hcl
az account set --subscription "MSS-Production"
terraform init -reconfigure -backend-config=backend/prd.hcl     # default workspace on the new backend
terraform state push ~/apex-prd-backup.tfstate
terraform plan -var-file=terraform.prd.tfvars                   # must show: No changes
```

Prod pushes rather than migrates to leave workspaces behind. `-migrate-state` from the `prd` workspace would copy it into a workspace of the same name, and the azurerm backend stores non-default workspaces as `<key>env:<workspace>`, so state would land in `prd.tfstateenv:prd` instead of `prd.tfstate`. Pushing into the new backend's default workspace writes exactly `prd.tfstate`.

**Afterwards**, once both plans are confirmed:

- Delete local state: `terraform.tfstate`, `terraform.tfstate.backup`, and `terraform.tfstate.d/`. Keep the backup files outside the repo for a few weeks.
- Stop using `terraform workspace`; switch environments with `terraform init -reconfigure -backend-config=...` instead.

### Team rules

- Everyone can `plan` against shared state, for either environment they have access to.
- Once the GitHub Actions pipeline exists, `apply` runs there. Local `apply` is break-glass only, and the person doing it tells the team first.
- **Never** commit `*.tfvars` (other than `terraform.tfvars.example`) or state files. Both are gitignored.
- **Never** run `plan` or `apply` with `terraform.prd.tfvars` while initialized against `backend/dev.hcl`, or the reverse — Terraform would plan to destroy one environment and recreate it as the other. Check the backend and subscription first.
- **Never** reuse a saved plan file after state changes — run `plan` again. Delete stray `*.tfplan` files when you are done with them.
- **Always** run `terraform plan` before `apply` and confirm the backend, subscription, and destroy count.

## Production (first-time stand-up)

Dev and prod **must not share state**. See [Environments and remote state](#environments-and-remote-state) for day-to-day navigation.

1. **Create `terraform.prd.tfvars`** (copy from `terraform.tfvars` and update resource names, `environment = "prd"`, redirect URL, and prod-specific secrets). This file is gitignored.

2. **Switch to prod** (subscription + backend):
   ```bash
   az account set --subscription "MSS-Production"
   terraform init -reconfigure -backend-config=backend/prd.hcl
   ```

3. **Plan and verify** — greenfield stand-up must show **only creates**, zero destroys:
   ```bash
   terraform plan -var-file="terraform.prd.tfvars"
   ```

4. **Apply**:
   ```bash
   terraform apply -var-file="terraform.prd.tfvars"
   ```

5. **Post-provision checklist**:
   - Add `https://<app-service-name>.azurewebsites.net/auth/callback` to the Azure AD app registration
   - Run database migrations against the new PostgreSQL server
   - Deploy the app (runtime app settings are set by `.github/workflows/deploy.yml` on deploy — configure a prod deploy path or run `az webapp config appsettings set` manually for the first deploy)
   - Switch back to dev: [Switch back to dev after prod work](#switch-back-to-dev-after-prod-work)

## Configuration Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `resource_group_name` | Name of the resource group | `rg-ai-pilot` |
| `location` | Azure region | `East US` |
| `app_service_name` | Name of the App Service | `app-ai-pilot` |
| `app_service_plan_name` | Name of the App Service Plan | `plan-ai-pilot` |
| `environment` | Environment name | `dev` |
| `ado_org` | Azure DevOps org URL | (required) |
| `ado_pat` | Azure DevOps PAT | (required) |
| `ado_project` | Azure DevOps project | (required) |
| `github_org` | GitHub org for checkout (`GITHUB_ORG`; not the Apex product name) | `""` |
| `github_token` | GitHub PAT for clone/fetch (`GITHUB_TOKEN`; same as App Service) | `null` |
| `postgresql_location` | PostgreSQL Flexible Server region (keep equal to `app_service_location`) | `Central US` |
| `postgresql_server_name` | PostgreSQL Flexible Server name | `psql-hub-dev` |
| `postgresql_sku_name` | PostgreSQL compute SKU | `B_Standard_B1ms` |
| `postgresql_storage_mb` | Provisioned storage in MiB; cannot be reduced after growth | `32768` |
| `postgresql_backup_retention_days` | Point-in-time backup retention | `7` |
| `postgresql_azure_services_firewall_rule_name` | Name of the `0.0.0.0` Azure-services firewall rule | `allow-azure-services` |
| `postgresql_pg_stat_statements_track` | `pg_stat_statements` capture mode (`none` / `top` / `all`) | `top` |
| `postgresql_log_min_duration_statement_ms` | Log statements slower than this many ms (`-1` disables) | `5000` |

The App Service plan uses the fixed `app_service_worker_count`. Production
autoscaling is intentionally deferred until Interview and other long-running AI
flows have a multi-instance ownership, cleanup, and scale-in recovery design.

### Importing an existing PostgreSQL server

Before importing a Flexible Server, set its exact name, region, SKU, storage,
backup retention, availability zone, and managed firewall-rule name in the
environment's tfvars. Storage cannot shrink, and a mismatched region or name
produces a replacement plan.

Never change `postgresql_server_name` or `postgresql_location` and apply while
Terraform state still owns a different server. Back up state, remove the old
addresses from state without destroying Azure resources, import the active
server and child resources, then require a refreshed plan with no PostgreSQL
create, replacement, resize, or destroy. See the approved production
reconciliation runbook before changing production state. Terraform ignores
imported administrator credentials after server creation because Azure cannot
return them with matching state metadata; rotate the password through the
approved secret process. This credential-ownership rule applies to all
environments: after a server is created, administrator credentials are managed
outside Terraform rather than changed through tfvars.

### Shared async storage

The shared Blob account is created in every environment. PDF assembly has moved to DocHub; the `pdf-artifacts` container is **kept** in `blob_containers` so apply does not destroy existing blobs. Purge it in a later change after operators confirm it is unused. Job delivery for remaining Apex async work uses the **Postgres queue** — Terraform does **not** provision Service Bus for PDF.

**Do not** grant account-wide Blob Contributor “for PDF”; that role assignment lived in `pdf-processing.tf` and has been removed.

| Terraform variable | Purpose | Default |
|--------------------|---------|---------|
| `shared_storage_account_name` | Globally unique shared artifact account; null derives `stapex<environment>async` (for example, `stapexdevasync`) | derived |
| `blob_containers` | Map of private containers on the shared account | `{ pdf-artifacts, repo-grounding, cursor-prompts, playbook-step-outputs }` |

App setting contract for the Apex application (wire via deploy pipeline / App Service config — `main.tf` ignores `app_settings` drift):

| App setting | Value source | Consumer |
|-------------|--------------|----------|
| `GROUNDING_BLOB_ACCOUNT_NAME` | `grounding_storage_account_name` output | Grounding bundle store |
| `GROUNDING_BLOB_CONTAINER_NAME` | `grounding_blob_container_name` output | Grounding bundle store |
| `PLAYBOOK_STEP_OUTPUT_BLOB_ACCOUNT_NAME` | `shared_storage_account_name` output | Playbook step-output store |
| `PLAYBOOK_STEP_OUTPUT_CONTAINER_NAME` | `playbook_step_output_blob_container_name` output | Playbook step-output store |

`playbook-step-outputs` stores private JSON for Playbook steps whose output exceeds the inline limit. The Apex App Service identity, and a distinct staging-slot identity when enabled, receive `Storage Blob Data Contributor` only on that container. The application falls back to `GROUNDING_BLOB_ACCOUNT_NAME` or `PDF_BLOB_ACCOUNT_NAME` when the explicit account setting has not yet been deployed, because all three name the same shared account. A daily in-process sweep verifies referenced objects and deletes only unreferenced objects older than one hour. Apply this change in each environment before Playbook steps spill large output there.

### Repository grounding bundles

`repo-grounding` stores immutable, content-addressed git bundles at
`{provider}/{project}/{repo}/{sha}.bundle`. The container is private, anonymous
blob access is disabled at the account, and the Apex App Service system identity
and optional staging-slot system identity have `Storage Blob Data Contributor`
only at this container's scope. Runtime access uses those system-assigned
identities; `AZURE_CLIENT_ID` remains the application-auth registration ID and
must not be used as a Blob credential. Do not configure connection strings, SAS
tokens, or account keys.

Azure Storage Service Encryption with Microsoft-managed keys provides encryption
at rest. Account-level last-access tracking is enabled, and the shared account's
single lifecycle management policy deletes `repo-grounding/` block blobs after
14 days since last access. Application code must not delete bundles when a run
finishes.

The production Apex app and its staging deployment slot each have a distinct
system-assigned managed identity. Both receive Storage Account-scoped Blob
contributor for remaining shared containers (grounding, load-test artifacts).
Slot identities do not move during swaps; Terraform must retain the staging
identity and its RBAC grant.

When adding the system identity to an existing App Service with AzureRM 3.x,
provisioning is intentionally two-stage:

1. The first `terraform apply` adds the identity, Storage Account, and container.
2. Run `terraform plan` again after Azure returns the principal ID, then apply
   the container-scoped Blob role assignment.

#### Extending for another module

1. Add a container key to `blob_containers`.
2. Add a container-scoped role assignment for that module's identity.
3. Wire module-specific app settings to the shared account/container outputs.

#### Non-prod verification

After initializing against `backend/dev.hcl` and confirming the `MSS-DevTest` subscription:

```bash
terraform fmt -check
terraform validate
terraform plan
terraform output shared_storage_account_name
terraform output grounding_blob_container_name
```

Complete the following smoke checks before marking the infrastructure ready:

1. Attempt anonymous Blob access from an unassigned principal; access must fail.
2. Confirm `repo-grounding` is private, last-access tracking is enabled, its
   lifecycle rule uses 14 days since last access, and the Apex identity role is
   scoped to that container.
3. `pdf-artifacts` remains in `blob_containers` so this apply does not destroy
   historical PDF blobs. Purge later when operators confirm DocHub has replaced
   Apex PDF assembly.

---

## Load Test module (FEAT-002)

Isolated Azure infrastructure for on-demand k6 load tests. Load generation
runs in a dedicated **Container Apps Job** (outside the Apex App Service plan)
and dispatches via a dedicated **Service Bus namespace** so load bursts never
share capacity with latency-sensitive Apex workloads.

### Resource naming

Resources follow the Apex convention `{type}-apex-lt-{environment}`:

| Resource | Dev name | Prod name |
|----------|----------|-----------|
| Service Bus namespace | `sbns-apex-lt-dev` | `sbns-apex-lt-prd` |
| Dispatch queue | `lt-dispatch` | `lt-dispatch` |
| Container Apps Environment | `cae-apex-lt-dev` | `cae-apex-lt-prd` |
| Container Apps Job | `caj-apex-lt-dev` | `caj-apex-lt-prd` |
| Runner managed identity | `mi-apex-lt-runner-dev` | `mi-apex-lt-runner-prd` |
| Blob container | `lt-artifacts` | `lt-artifacts` |

### Resource placement

Load-test data-plane resources follow the data lifecycle, while executable
compute and its identity follow the application lifecycle:

| Resource group | Resources |
|----------------|-----------|
| Data (`resource_group_name`; prod `rg-apex-prd-data`) | Service Bus namespace/queue, shared Storage Account, `lt-artifacts`, lifecycle policy |
| App (`app_service_resource_group_name`, otherwise data RG; prod `rg-apex-prd-app`) | Container Apps Environment, Container Apps Job, runner managed identity |

The compute resources use `app_service_location`; Service Bus and Blob continue
to use the main data location. In environments without a dedicated app resource
group (current dev), both groups resolve to the same resource group.

### Provisioned resources

| Resource | Purpose |
|----------|---------|
| `azurerm_servicebus_namespace.load_test` | Dedicated dispatch namespace; not shared with other async workloads |
| `azurerm_servicebus_queue.lt_dispatch` | KEDA trigger queue; DLQ auto-created at `lt-dispatch/$DeadLetterQueue` |
| `azurerm_servicebus_namespace_authorization_rule.lt_keda_listen` | SAS with Manage for the KEDA scaler (`lt-keda-listen`; Listen-only 401s on queue metrics) |
| `azurerm_storage_container.lt_artifacts` | Blob container on the shared storage account; holds summary + time-series artifacts |
| `azurerm_storage_management_policy.lt_artifacts_lifecycle` | ~90-day deletion policy scoped to the `lt-artifacts/` prefix |
| `azurerm_container_app_environment.load_test` | VNet-integrated CAE for non-prod target reachability |
| `azurerm_container_registry.lt` | Basic ACR for `apex-lt-k6` runner images (CI publish) |
| `azurerm_container_app_job.load_test_runner` | KEDA-scaled k6 runner; max-executions enforces platform concurrency cap |
| `azurerm_user_assigned_identity.lt_runner` | Runner MI: queue receive + blob contribute + Key Vault Secrets User + AcrPull |

### Identity and RBAC

| Identity | Roles | Scope |
|----------|-------|-------|
| Runner MI (`mi-apex-lt-runner-*`) | Azure Service Bus Data **Receiver** | `lt-dispatch` queue |
| Runner MI | Storage Blob Data **Contributor** | `lt-artifacts` container |
| Runner MI | Key Vault Secrets **User** | `var.lt_key_vault_id` (when set) |
| Apex API (App Service system identity) | Azure Service Bus Data **Sender** | `lt-dispatch` queue |
| Apex API | Storage Blob Data **Reader** | `lt-artifacts` container |
| Apex staging slot (when enabled and `lt_enable_staging_slot_rbac=true`) | Azure Service Bus Data **Sender** | `lt-dispatch` queue |
| Apex staging slot (when enabled and `lt_enable_staging_slot_rbac=true`) | Storage Blob Data **Reader** | `lt-artifacts` container |

Set `lt_enable_staging_slot_rbac = false` when the Terraform apply principal
cannot manage role assignments or staging does not need to dispatch load tests.
This leaves the staging slot in place without provisioning its load-test RBAC.

### Terraform outputs (app config contract for FEAT-007/008)

```bash
terraform output lt_servicebus_namespace_name   # sbns-apex-lt-dev
terraform output lt_servicebus_namespace_fqdn   # sbns-apex-lt-dev.servicebus.windows.net
terraform output lt_servicebus_queue_name        # lt-dispatch
terraform output lt_servicebus_dlq_name          # lt-dispatch/$DeadLetterQueue
terraform output lt_data_resource_group_name
terraform output lt_compute_resource_group_name
terraform output lt_container_app_environment_name
terraform output lt_container_app_job_name
terraform output lt_blob_account_name
terraform output lt_blob_container_name          # lt-artifacts
terraform output lt_runner_identity_client_id
terraform output lt_runner_identity_principal_id
```

App setting keys expected by the Apex API (FEAT-007):

| App setting | Value source |
|-------------|-------------|
| `LT_SERVICEBUS_NAMESPACE` | `lt_servicebus_namespace_name` output |
| `LT_SERVICEBUS_QUEUE_NAME` | `lt_servicebus_queue_name` output |
| `LT_BLOB_ACCOUNT_NAME` | `lt_blob_account_name` output |
| `LT_BLOB_CONTAINER_NAME` | `lt_blob_container_name` output |
| `LT_APEX_CALLBACK_BASE_URL` | Host that should receive runner ingest (sticky per slot: staging URL vs prod URL) |
| `LT_RUNNER_CALLBACK_TOKEN` | Short-term shared ingest bearer (GitHub secret → App Service / job) |
| `LT_CALLBACK_TOKEN_AUDIENCE` | Long-term only — when `lt_enable_entra_ingest_app=true` |
| `LT_RUNNER_ALLOWED_CLIENT_IDS` | Long-term only — runner MI client ID |

### Runner callback auth

**Short-term (default):** shared bearer `LT_RUNNER_CALLBACK_TOKEN` on App Service and
the Container Apps Job. Set via GitHub environment secret `LT_RUNNER_CALLBACK_TOKEN`
(deploy / pr-tests pipelines) and optionally `var.lt_runner_callback_token` for the job.

**Long-term:** set `lt_enable_entra_ingest_app = true` after the apply identity has
Graph `Application.ReadWrite.*` + `AppRoleAssignment.ReadWrite.All`. Terraform then
creates `apex-lt-ingest-{environment}` + `LoadTest.Runner` role assignment; wire
`LT_CALLBACK_TOKEN_AUDIENCE` / `LT_RUNNER_ALLOWED_CLIENT_IDS` and remove the shared
secret.

### KEDA scale-rule authentication

The Container Apps Job event trigger must supply a Service Bus **connection**
setting. Putting `clientId` in scale-rule metadata alone is not enough — KEDA
fails with `error parsing azure service bus metadata: no connection setting given`
and never starts executions (runs stay `dispatched`).

Until the module is on **azurerm >= 4.73** (which supports scale-rule
`identity_id`), Terraform wires a namespace SAS with **Manage** rights
(`lt-keda-listen`) into a job secret `lt-keda-sb-connection` and references it
from the scale rule `authentication` block (`trigger_parameter = connection`).
KEDA's Service Bus scaler calls the management API for queue length — Listen-only
returns `401 Manage,EntityRead claims required` and jobs never start.
Runner **message receive** still uses the user-assigned MI (Data Receiver) —
the SAS is only for KEDA queue-length polling.

Smoke signal: Container Apps system logs must **not** show repeating
`KEDAScalerFailed` / `ScaledJobCheckFailed` after apply.

### Concurrency guardrail

`lt_max_executions` (default **2**) sets the KEDA `max-executions` on the
Container Apps Job. This enforces the PRD platform-wide concurrency limit of
1–2. Messages beyond the cap wait on the Service Bus queue rather than
launching extra executions.

### VNet integration (required for non-prod target reachability)

Provide `lt_vnet_subnet_id` pointing to a subnet delegated to
`Microsoft.App/environments`. Without it, the CAE is provisioned without VNet
integration (suitable for initial stand-up / validation); runner egress to
VNet-peered non-prod targets will fail until the subnet is wired.

```bash
# Example var for dev
lt_vnet_subnet_id = "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/snet-apex-lt-dev"
```

### Runner image (Lane B)

Terraform provisions a dedicated Basic ACR (`acrapexlt{environment}`) and wires
the Container Apps Job to pull via the runner MI (`AcrPull` + `registry` block).

CI publishes the Apex runner on every PR deploy (`pr-tests.yml`) and production
staging deploy (`deploy.yml`) via `scripts/ci/publish-lt-k6-runner.sh`:

1. `docker build -f runners/load-test-k6/Dockerfile` (requires prior `npm run build`)
2. Push `apex-lt-k6:<git-sha>` and `:latest` to the env ACR
3. `az containerapp job update --image …:<git-sha>`

Terraform **ignores** job image drift after apply so CI updates are not reverted.
The initial `var.lt_runner_image` placeholder (`grafana/k6:latest`) is only used
until the first successful publish.

**GitHub environment variables** (set per `dev` / `prd`):

| Variable | Example (dev) |
|----------|----------------|
| `LT_ACR_NAME` | `acrapexltdev` |
| `LT_CONTAINER_APP_JOB_NAME` | `caj-apex-lt-dev` |
| `LT_RESOURCE_GROUP` | `rg-scrum-dev` (optional; PR defaults to this, prod defaults to `RESOURCE_GROUP_NAME`) |

Grant the deploy SP **AcrPush** on the ACR (Terraform:
`lt_acr_push_principal_ids = ["<sp-object-id>"]`, or one-time
`az role assignment create --role AcrPush …`).

```bash
terraform output lt_acr_name
terraform output lt_acr_login_server
```

Optional: pin a digest in `lt_runner_image` for a controlled roll-forward; CI will
still overwrite the live job image on the next deploy.

### Non-prod verification (load-test module)

After initializing against `backend/dev.hcl` and confirming the `MSS-DevTest` subscription:

```bash
terraform fmt -check
terraform validate
terraform plan

# After apply:
terraform output lt_servicebus_namespace_name
terraform output lt_container_app_job_name
terraform output lt_runner_identity_client_id
```

Smoke checks:
1. Verify Service Bus namespace name starts with `sbns-apex-lt-` and is **not** the shared async namespace.
2. Confirm Container Apps Job `caj-apex-lt-dev` references the expected runner image.
3. Confirm KEDA scale rule `lt-servicebus-keda` is present on the job, binds to `lt-dispatch`, and authenticates via secret `lt-keda-sb-connection` (not metadata `clientId` alone).
4. Confirm `max_executions` is 1 or 2. Confirm system logs are free of `KEDAScalerFailed`.
5. Confirm `lt-artifacts` container exists on the shared storage account with the 90-day lifecycle rule.
6. **Negative check:** Attempt queue receive and blob write with a non-module identity; both must be denied by Azure RBAC (VT-04).

---

## AI Runs background worker module (FEAT-003)

Provisions the bounded, least-privilege Container Apps Job tier for flagged
background AI generation (`ai-runs-background` Feature Flag). Infrastructure is
additive and inert while the flag is disabled.

| Resource | Dev example | Prod example |
|----------|-------------|--------------|
| Service Bus namespace (shared AI lanes) | `sbns-apex-ai-dev` | `sbns-apex-ai-prd` |
| Background queue | `ai-runs-background` | `ai-runs-background` |
| Container Apps Environment | `cae-apex-ai-dev` | `cae-apex-ai-prd` |
| Container Apps Job | `caj-apex-ai-runs-dev` | `caj-apex-ai-runs-prd` |
| Runner MI | `mi-apex-ai-runs-runner-dev` | `mi-apex-ai-runs-runner-prd` |
| Azure Files share | `ai-pilot-data` on shared storage | same |
| Runner image ACR | Reuses `acrapexlt{env}` / repo `apex-ai-runs` | same |

### Files

| File | Owns |
|------|------|
| `ai-runs-worker.tf` | Namespace, queue, KEDA Job, MI, RBAC, Azure Files mount |
| `ai-runs-worker-entra.tf` | Optional `AiRun.Runner` Entra app role (`enable_ai_runs_entra_app`) |

### In-flight cap lockstep (BR-003)

`var.ai_runs_max_in_flight` (default **10**) drives:

1. KEDA `event_trigger_config.scale.max_executions`
2. Job env `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT`
3. App Service setting `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT` (wire via deploy pipeline from `terraform output ai_runs_max_in_flight`)

The DB admission governor (`admissionGovernorService.ts`) reads the same env var.
Do not change one without the other.

### App setting contract (Apex API)

| App setting | Terraform output |
|-------------|------------------|
| `AI_RUNS_SERVICEBUS_NAMESPACE` | `ai_runs_servicebus_namespace_name` |
| `AI_RUNS_BACKGROUND_QUEUE_NAME` | `ai_runs_background_queue_name` |
| `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT` | `ai_runs_max_in_flight` |
| Shared checkout mount | `ai_runs_workspace_mount_path` (`/home/data/ai-pilot/workspaces`) |

Dispatch messages must contain only `{ runId, dispatchMessageId }` (BR-006) —
enforced by `serviceBusPublisher.ts`, never by putting prompts on Service Bus.

The `dev` and `prd` GitHub environments hold these values as non-secret
`AI_RUNS_*` variables. Their deploy workflows write the queue/cap/audience
settings to App Service. No worker secret is stored in GitHub: the Job resolves
`CURSOR_API_KEY` from Key Vault using its managed identity.

`scripts/ci/publish-ai-runs-runner.sh` publishes `apex-ai-runs:<git-sha>` and
updates the Job after FEAT-004 adds `runners/ai-runs/Dockerfile` and the compiled
worker host. Until then the workflow step is skipped and the provisioned Job
remains inert behind the disabled feature flag.

### RBAC (least privilege)

| Principal | Role | Scope |
|-----------|------|-------|
| Runner MI | Azure Service Bus Data **Receiver** | `ai-runs-background` queue |
| Runner MI | Key Vault Secrets **User** | Dedicated `kv-apex-ai-{environment}` vault, or `var.ai_runs_key_vault_id` override |
| Runner MI | **AcrPull** | load-test ACR (`acrapexlt*`) |
| Apex API (system identity) | Azure Service Bus Data **Sender** | `ai-runs-background` queue (no receive) |
| Runner MI | `AiRun.Runner` app role | Entra app when `enable_ai_runs_entra_app=true` |

By default Terraform provisions the dedicated Key Vault and seeds its
`cursor-api-key` secret from the existing sensitive `cursor_api_key` variable.
To reuse an existing vault, set both `ai_runs_key_vault_id` and the versioned
`ai_runs_cursor_api_key_secret_id`; setting only one is rejected at plan time.

KEDA polls queue length with a **queue-scoped** Manage SAS secret
(`ai-runs-keda-sb-connection`). Message receive stays on the runner MI.
Prefer scale-rule `identity_id` after upgrading `azurerm` ≥ 4.73.

### Azure Files workspace

The App Service, background Job, and interactive host mount share
`ai-pilot-data` at `/home/data/ai-pilot/workspaces`. Mount only the workspace
subdirectory: the rest of `resolveDataRoot()` remains App Service-owned. This
gives each execution tier the same checkout tree without turning the complete
Apex data directory into a shared mutable filesystem. Blob staging remains out
of scope.

`AI_PILOT_DATA_DIR` stays at the parent (`/home/data/ai-pilot`) so
`resolveDataRoot()` → `…/workspaces/grounding/<digest>` matches the mount.
Never mount the Azure Files share at the data-root parent — that makes
`workspaceRef` paths resolve to a missing `workspaces/` folder on the share
and background runs fail immediately after bootstrap with
`Worker execution failed`.

### Smoke verification (after apply — S8 / VT-02, VT-04, VT-06)

```bash
terraform output ai_runs_servicebus_namespace_name
terraform output ai_runs_background_queue_name
terraform output ai_runs_max_in_flight
terraform output ai_runs_container_app_job_name
terraform output ai_runs_runner_identity_client_id
```

1. Confirm namespace is `sbns-apex-ai-*` (shared AI lanes) — **not** `sbns-apex-lt-*`.
2. Confirm Job KEDA rule `ai-runs-servicebus-keda`: `messageCount=1`,
   `parallelism=1`, `replica_completion_count=1`, `min_executions=0`,
   `max_executions == ai_runs_max_in_flight`.
3. Enqueue one admitted `{runId,dispatchMessageId}` message → exactly one Job
   execution starts and exits (requires runner image published).
4. Cap smoke: enqueue `N+3` messages with `ai_runs_max_in_flight=N` → active
   executions never exceed `N`.
5. Negative: identity without runner MI / `AiRun.Runner` must be denied receive
   and ingest; no `agent_runs` state change.
6. Cold-start failure: unpullable image → FEAT-001 reaper dispatched clock
   recovers the run without exceeding the cap (VT-03).

Infrastructure is safe to apply while `ai-runs-background` is disabled; the Job
scales from zero until the governor publishes admitted work.

---

## My Work Cursor worker Job (dev and production)

`cursor-cloud-workers.tf` provisions the Container Apps Job that My Work starts
for each cloud-agent run. Set `enable_cursor_pool_workers = true` in that
environment's tfvars file (`terraform.tfvars` for dev, `terraform.prd.tfvars`
for production). The job is created only when that flag is true. Resource
names still include the environment.

Apex starts one execution and overrides the command to
`/usr/local/bin/cursor-run-cli`. The Job does not register a Cursor Team Pool
and does not call the Cloud Agents SDK.

The stack reuses `cae-apex-ai-{environment}`, the existing ACR, Application
Insights, and the `cursor-api-key` secret in the AI-runs Key Vault. It does
not mount the shared Azure Files workspace: each run gets an isolated
ephemeral checkout.

| Resource | Dev name | Production name | Purpose |
|----------|----------|-----------------|---------|
| Worker Container Apps Job | `caj-apex-cursor-worker-dev` | `caj-apex-cursor-worker-prd` | Manual Job; one execution per Start cloud agent click |
| Worker identity | `mi-apex-cursor-worker-dev` | `mi-apex-cursor-worker-prd` | Pull image, read the Cursor API key, and read prompt blobs |
| Prompt container | `cursor-prompts` on the shared account | `cursor-prompts` on the shared account | Private text of the Apex-built prompt; deleted after one day |

### Image contract

Terraform provisions compute and identity but does not build the image:

- `cursor_pool_worker_image` must contain the Cursor `agent` CLI, `git`, and
  `/usr/local/bin/cursor-run-cli` from `runners/cursor-pool-worker/`.
- The Key Vault `cursor-api-key` is the key the CLI uses inside the container.
- `ADO_PAT` is passed on the execution only, for Azure DevOps remotes. It is
  not stored on the Job.
- The execution receives `AGENT_PROMPT_BLOB_URL`, not the prompt text. Apex
  uploads that text to the private `cursor-prompts` container before starting
  the job. The worker identity reads it. The container is deleted after one day.

### RBAC and networking

The worker identity can pull from ACR, read Key Vault secrets, and read the
`cursor-prompts` container. The Apex app identity can write that container.
The worker does not receive access to the AI-runs Service Bus queue or the
shared workspace.

Workers require outbound HTTPS to Cursor, the source-control host, and the
package registries used by the repository. No inbound port or public IP is
required.

### Activation

Use `backend/dev.hcl` and `terraform.tfvars`, or `backend/prd.hcl` and
`terraform.prd.tfvars`:

```hcl
enable_cursor_pool_workers = true
cursor_pool_worker_image   = "<acr>.azurecr.io/apex-cursor-worker:<tag>"
```

```bash
terraform output cursor_pool_worker_job_name
```

---

## AI Runs interactive transport (FEAT-007)

The optional interactive lane adds a warm Dapr-enabled Container App and a
Redis backplane for actor state and live WebSocket fan-out. Existing
environments can retain the legacy Azure Cache for Redis backend by setting
`ai_runs_interactive_redis_backend = "cache"`. New environments must use
`"managed"` because Azure no longer accepts new legacy cache instances.

Production uses Azure Managed Redis `Balanced_B1` with high availability
enabled in North Central US (Central US had no B0 or B1 allocation capacity
during initial provisioning). It is provisioned through AzAPI so the root
module can retain AzureRM 3.x without a major provider migration. The default
encrypted database listens on port `10000`; its access key is passed only to
the Dapr components and Container App secrets.

After apply, mirror `ai_runs_interactive_redis_hostname`,
`ai_runs_interactive_redis_ssl_port`, and the Redis access key into the App
Service live-bus settings, and set `AI_RUNS_INTERACTIVE_DISPATCH_URL` to the
`ai_runs_interactive_app_fqdn` HTTPS endpoint.

### Clustering policy (live-stream correctness)

`ai_runs_interactive_managed_redis_clustering_policy` controls how the Managed
Redis database presents itself to clients. **Use `EnterpriseCluster` in
production.** The default `OSSCluster` requires cluster-aware clients; the app's
standalone `ioredis` live bus and Dapr's non-cluster clients cannot fan out
pub/sub across an OSS-cluster proxy, so the interactive WebSocket token stream
silently degrades to the durable replay/poll path (chat "comes back" but not in
real time), and Dapr actor-state ops risk `MOVED`/`CROSSSLOT` if the cache is
scaled to multiple shards. `EnterpriseCluster` exposes a single logical endpoint
that standalone clients (and pub/sub) use correctly.

The clustering policy is **immutable on an existing database**, so changing it
replaces the Managed Redis. The backplane holds no durable data (durability is
in Postgres `agent_run_events`), and `create_before_destroy` provisions the
replacement before removing the old instance, so the cutover has no downtime.

**Cutover runbook (existing prod OSSCluster → EnterpriseCluster):**

1. In prod tfvars set a **distinct** name (create_before_destroy needs it), the
   new policy, and HA:
   ```hcl
   ai_runs_interactive_redis_name                      = "redis-apex-ai-prd-v2"
   ai_runs_interactive_managed_redis_clustering_policy = "EnterpriseCluster"
   ai_runs_interactive_managed_redis_high_availability = true
   ```
2. `terraform plan` and review: a new `redisEnterprise` + `default` database are
   created first; the ACA app and both Dapr components (`interactive-pubsub`,
   `interactive-actor-state`) repoint to the new host/key; the old instance is
   destroyed last.
3. `terraform apply` (only with explicit approval).
4. **Redeploy the App Service** so `deploy.yml` re-resolves `REDIS_*` to the new
   instance (it selects the `redis-apex-ai*` resource by name).
5. Validate: send an interactive chat turn and confirm live token streaming;
   check App Service logs for `InteractiveLiveBusSubscriberReady` and
   `InteractiveLiveBusSubscribed` with no `SubscriberError`.

> **Operational note — gitignored prod tfvars.** `terraform.prd.tfvars` is
> gitignored (holds secrets) and Terraform is applied manually, so the prod
> `ai_runs_interactive_redis_name` (`redis-apex-ai-prd-v2`) and
> `ai_runs_interactive_managed_redis_clustering_policy` live only in the
> operator's local/canonical tfvars. The tracked variable **defaults** are now
> the safe ones (`EnterpriseCluster`), so an apply that omits the policy line
> won't regress to OSSCluster. **But** the redis *name* default resolves to the
> old `redis-apex-ai-prd`; if the prod tfvars ever loses the `-v2` name line, a
> full apply would try to replace the live Redis. Keep both prod lines in
> whatever tfvars the next apply is run from.

---

## Repo read service

Optional Container App that serves repository file/list/search from a bare git
mirror on **ephemeral container disk** (no Azure Files mount). Durable restore
uses the existing `repo-grounding` Blob container. The module is inert while
`enable_repo_read_service` is false.

After apply:

1. Publish `runners/repo-read-service/Dockerfile` to ACR and point
   `repo_read_service_image` at it (Terraform ignores subsequent image drift).
2. Confirm `REPO_READ_SERVICE_URL` matches `repo_read_service_app_fqdn` on the
   App Service, the interactive actor Container App, **and** the background
   Container App Job (Terraform writes all three when the module is on). The
   actor host and background job have no working tree and cannot see the App
   Service mirror, so a missing URL there leaves turns/jobs reading a checkout
   that was never materialized — a silent hang rather than an error.
3. Confirm `REPO_READ_SERVICE_TOKEN` matches `ai_runs_runner_callback_token` on
   those hosts.
4. Confirm the Container App has `GITHUB_ORG` / `GITHUB_TOKEN` matching App
   Service (copy from the live web app settings into tfvars). Without them,
   Azure DevOps projects still clone; GitHub projects (Apex) fail on fetch
   unless that SHA was already restored from Blob. Fine-grained `github_pat_`
   tokens need Contents: Read and Metadata: Read on each GitHub skill repo.
5. Target the `repo-read-service` feature flag in Platform Admin. Until then
   Apex keeps in-process checkout reads even if the Container App exists.
6. Smoke: `GET https://<fqdn>/healthz` returns `{ ok: true }`. An unauthenticated
   `POST /v1/read` must return 401/503.

Do not `terraform apply` this module until the in-process `BareRepoReader` path
has been proven for a project behind the DB flag.

### Probes are deliberately slack

Reads are fast but a search legitimately pegs a core for several seconds, and a
cold replica spends ten to twenty restoring its mirror before it can answer at
all. Under the platform's default probes that reads as unhealthy, and the kill
costs more than the work did: the replacement re-materializes the mirror before
serving, so the caller sees a hang rather than an error. The declared probes
allow roughly five minutes of slowness. Readiness is as tolerant as liveness
because only one replica runs, so evicting it fails every caller instead of
shifting load elsewhere.

### Console log retention is not wired up, and enabling it has two traps

`cae-apex-ai-dev` streams logs only — nothing is retained, so a crash can only be
investigated live. Before changing that, know:

- The workspace backing `appi-app-scrum-dev` **cannot** be reused as the
  destination. It lives in an App Insights-managed resource group carrying a deny
  assignment on `sharedKeys/action`, which is the credential Container Apps needs.
  A separate workspace is required.
- Setting `log_analytics_workspace_id` on `azurerm_container_app_environment`
  historically forced replacement, and on provider 4.17+ its mere presence can
  block every later update to the environment. Replacing this environment would
  take both container apps, both Dapr components and the workspace storage mount
  with it. Treat it as a change to validate against a plan first, not a one-liner.

Because of that, repo-read reports its own exits instead: see
`installLifecycleDiagnostics` in `src/server/services/repoRead/entrypoint.ts`. A
`RepoReadServiceExit` event with reason `SIGTERM` means the platform stopped it
(probe or scale), `uncaughtException` means it died on its own, and a
`RepoReadServiceStarted` with no preceding exit means SIGKILL — OOM or an expired
shutdown grace period, neither of which a handler can catch.

---

## AI Platform V2 (additive onto existing host)

V2 does **not** create a parallel resource group, Service Bus namespace, storage
account, or Container Apps Environment. It adds queues, an artifact container,
and managed identities onto the environment you already run:

| Env | Region | Typical host |
|-----|--------|----------------|
| DEV | East US | `rg-scrum-dev` / `sbns-apex-ai-dev` / `stapexdevasync` / `cae-apex-ai-dev` |
| PROD | Central US | existing prod AI RG / `sbns-apex-ai-prd` / shared async / CAE |

### Enable checklist

1. Set `enable_ai_platform_v2 = true`.
2. Set existing host names: `ai_platform_v2_resource_group_name`,
   `ai_platform_v2_servicebus_namespace_name`,
   `ai_platform_v2_storage_account_name`,
   `ai_platform_v2_container_app_env_name`.
3. Optional: `ai_platform_v2_location` (defaults from contracts:
   `dev`→`eastus`, `prd`→`centralus`).
4. `terraform plan` / `apply` (requires permission to create role assignments
   for the new identities).
5. Keep `ai-runs-v2-transport` off until apps are wired.

**DEV runtime smoke test (after foundation apply):** from repo root, run
`./scripts/dev/complete-v2-dev-setup.sh` (uses `az acr build` — no local Docker).
It sets App Service V2 settings, blob + AcrPull RBAC, builds runner images, rolls
`ca-apex-ai-orchestrator-dev`, `ca-apex-ai-runs-documents-v2-dev`, and the split
interactive hosts (`ca-apex-ai-fast-interactive-dev`, `ca-apex-ai-agentic-dev`).
Orchestrator dispatch URLs come from those apps (not the legacy shared host).
Then enable `ai-runs-v2-transport` in Platform Admin for your user/project.

Optional Terraform: `enable_ai_platform_v2_runtime = true` **and**
`enable_ai_platform_v2_split_interactive = true` with image URLs,
`ai_platform_v2_database_url`, and the existing Redis/workspace/secret inputs
— see `ai-platform-v2-runtime.tf`, `ai-platform-v2-interactive-runtime.tf`, and
`terraform.tfvars.example`.

With `ai_platform_v2_grant_app_service_blob = true`, the App Service identity,
and a distinct staging-slot identity when enabled, receive `Storage Blob Data
Contributor` on the V2 artifact container. Staging shares production's database,
so its recovery sweep can harvest a finished V2 attempt and needs the same read.

**Document worker scaling:** `ca-apex-ai-runs-documents-v2-{env}` scales from
`min_replicas` to `ai_platform_v2_documents_max_replicas` on the documents queue
length (KEDA rule `documents-v2-servicebus-keda`, secret `documents-keda-sb-connection`
from the queue-scoped Manage SAS `ai-runs-v2-document-keda-manage`, which KEDA uses only
to poll queue length). Each replica runs one document run at a time. The worker
completes the queue message once the run starts, so KEDA can pick a busy replica to
remove. On SIGTERM the worker stops taking messages and lets the current run finish
for `AI_RUNS_V2_SHUTDOWN_DRAIN_MS` (grace period minus 30 s) before aborting it.
`azapi_resource_action.ai_platform_v2_documents_scale_timing` (a PATCH, re-run whenever
the app changes) sets the termination grace
period (`ai_platform_v2_documents_termination_grace_seconds`, at most 600) and the
cooldown (`ai_platform_v2_documents_scale_cooldown_seconds`), which azurerm 3.x cannot
set. After apply, check that the Container App system logs have no `KEDAScalerFailed` and
that `az containerapp show` reports both values.

**Split interactive cutover (DEV/PROD):**

1. Drain `ai-runs-v2-fast` and `ai-runs-v2-agentic` queues (must be empty active + DLQ).
2. `terraform plan` and confirm queue/RBAC deletions match contracts (only those two queues).
3. Apply — creates `ca-apex-ai-fast-interactive-{env}` and `ca-apex-ai-agentic-{env}` with
   internal ingress, `/health` probes, class UAMIs, and orchestrator env for distinct
   dispatch URLs + DEV caps (`interactiveCap=4`, lane floors `1+1`; PROD `16` / `2+2`).
4. Publish one `apex-ai-runs-interactive` SHA via `scripts/ci/publish-ai-runs-interactive.sh`
   (legacy + fast + agentic targets).
5. Soak with legacy `ca-apex-ai-interactive-{env}` still present for canonical-flag-off traffic.

Contracts: `infra/ai-platform-v2-contracts.json` (asserted by
`aiPlatformV2Infrastructure.test.ts`).

### Files

| File | Owns |
|------|------|
| `ai-platform-v2.tf` | Host data sources, V2 queues, artifact container |
| `ai-platform-v2-identities.tf` | UAMIs + entity-scoped RBAC |
| `ai-platform-v2-contracts.json` | Queue matrix + host-reuse cutover |
| `ai-platform-v2-networking.tf` | Stub (no new VNet/CAE) |
| `ai-platform-v2-monitoring.tf` | Stub (no dedicated LA) |
| `ai-platform-v2-runtime.tf` | Orchestrator + document worker Container Apps (optional) |
| `ai-platform-v2-interactive-runtime.tf` | Fast + agentic actor hosts, orchestrator dispatch URLs (optional) |

---

## Alerts

`alerts.tf` emails `alert_email_receivers` when something on the infrastructure side will break Apex for users. An empty list creates nothing.

| Alert | Fires when |
|-------|-----------|
| `http-5xx`, `health-check` | App Service returns server errors or an instance fails `/api/health` |
| `storage-health` | The availability test on `/api/health/storage` (one location, every 15 minutes) fails: the data root is not writable, the Azure Files workspace share is not mounted, or less than 10 GiB is free |
| `disk-warning`, `disk-critical` | App Service storage (shared by prod and staging) passes 70% / 85% of `app_service_storage_quota_gb`. Azure reports this every six hours, so treat it as an early warning |
| `postgres-down`, `-cpu`, `-storage` | PostgreSQL stops responding, or CPU or storage stays high |
| `<app>-down`, `<app>-restarts` | A Container App in `alert_container_app_names` has no replica, or keeps restarting |
| `interactive-turns-not-starting` | The reaper ends more than two interactive turns in 15 minutes because no worker ran them |
| `interactive-admission-failures` | V2 refuses a turn because a skill, grounding, or MaxView is unavailable |
| `interactive-worker-unhealthy` | An actor host reports a broken Dapr sidecar or crashes on start |
| `repo-storage` | A clone finds the disk nearly full or runs out of space, or the storage health check fails |
| `adr-generation-failed` | An ADR run ends without an ADR file or fails to start |
| `app-exceptions` | App Service logs more than 20 exceptions in 15 minutes |

The log alerts read App Insights `traces`, so they depend on the app sending every request's logs (`tracesPerSecond: 0` in `src/server/services/telemetry.ts`).

Container Apps are looked up by name, because some are managed outside this state. Prod sets:

```hcl
alert_email_receivers                   = ["anedunur@amergis.com"]
alert_container_app_names               = ["ca-apex-ai-agentic-prd", "ca-apex-ai-fast-interactive-prd", "..."]
alert_container_app_resource_group_name = "rg-apex-prd-app"
alert_email_hours                       = { start = "08:00:00", end = "18:00:00", time_zone = "Eastern Standard Time" }
```

`alert_email_hours` adds an alert processing rule that suppresses emails outside the window, every day. The rules still run and bill around the clock. An alert that fires overnight does not email at 08:00; check **Monitor → Alerts** in the morning.

---

## Deployment

After infrastructure is provisioned, deploy the application:

### Option 1: Using Azure CLI
```bash
cd ..
npm run build
az webapp up --name <app-service-name> --resource-group <resource-group-name>
```

### Option 2: Using Git Deployment
```bash
# Get deployment credentials
az webapp deployment list-publishing-credentials --name <app-service-name> --resource-group <resource-group-name>

# Configure git remote
git remote add azure https://<deployment-username>@<app-service-name>.scm.azurewebsites.net/<app-service-name>.git

# Deploy
git push azure main
```

### Option 3: Using GitHub Actions (Recommended)
See `.github/workflows/` for CI/CD pipeline configuration.

## Environment Variables

The following environment variables are automatically configured in App Service:

- `ADO_ORG` - Azure DevOps organization URL
- `ADO_PAT` - Azure DevOps Personal Access Token
- `ADO_PROJECT` - Azure DevOps project name
- `GITHUB_ORG` - GitHub organization for skill-repo checkout
- `GITHUB_TOKEN` - GitHub PAT (fine-grained `github_pat_…` or classic); same secret the repo-read Container App uses
- `NODE_ENV` - Set to `production`
- `VITE_ADO_ORG` - ADO org for client-side
- `VITE_ADO_PROJECT` - ADO project for client-side

Additional variables can be added in `main.tf` under `app_settings`.

## Scaling

To change the App Service tier, set `app_service_plan_sku` in the environment's tfvars file:

| SKU | Use case |
|-----|----------|
| `B1` | Dev (default) |
| `S1` | Deployment slots (minimum for blue-green swap) |
| `P1v3` | Deployment slots + zone redundancy (prod) |

```bash
# Dev
terraform init -reconfigure -backend-config=backend/dev.hcl
terraform apply

# Prod
terraform init -reconfigure -backend-config=backend/prd.hcl
terraform apply -var-file="terraform.prd.tfvars"
```

## Costs

Approximate monthly costs (East US):
- **B1 App Service Plan**: ~$13/month
- **Application Insights**: ~$2-5/month (based on usage)

## Cleanup

To destroy all resources in the environment this checkout is initialized against:

```bash
# Dev
az account set --subscription "MSS-DevTest"
terraform init -reconfigure -backend-config=backend/dev.hcl
terraform destroy

# Prod
terraform init -reconfigure -backend-config=backend/prd.hcl
az account set --subscription "MSS-Production"
terraform destroy -var-file="terraform.prd.tfvars"
```

## Security Notes

- `terraform.tfvars`, `terraform.prd.tfvars`, and local state files are excluded from git (see `.gitignore`)
- Never commit sensitive values (PATs, keys) to version control
- Rotate PAT tokens regularly
- Use Azure Key Vault for production secrets
- Enable managed identity for enhanced security

## Troubleshooting

**Issue**: App Service not starting
- Check logs: `az webapp log tail --name <app-service-name> --resource-group <resource-group-name>`
- Verify `package.json` has correct `start` script
- Ensure all environment variables are set

**Issue**: Terraform state conflicts or wrong environment targeted
- Check the backend (`.terraform/terraform.tfstate`) and `az account show` before every apply
- Dev and prod use separate state keys and backend configs — see [Environments and remote state](#environments-and-remote-state)
- A state lock error means another run holds the blob lease; wait for it, or `terraform force-unlock` only after confirming nobody is running

**Issue**: `Saved plan is stale`
- Re-run `terraform plan` (and `-var-file` for prod) after any state change; do not reuse old `.tfplan` files

**Issue**: Build fails on deployment
- Check Node.js version compatibility
- Verify all dependencies are in `package.json`
- Review build logs in Azure Portal
