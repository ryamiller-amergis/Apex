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
- **Managed-identity access**: The cross-cutting Apex App Service identity is scoped to the shared Storage Account. PDF assembly stays in the Apex application; job delivery uses the Postgres queue (Service Bus deferred).
- **Load Test infrastructure** (FEAT-002): Dedicated Service Bus namespace, Container Apps Job, and managed identities — see [Load Test module](#load-test-module-feat-002) below.
- **AI Runs background worker** (FEAT-003): Shared AI-runs Service Bus namespace (`sbns-apex-ai-*`), `ai-runs-background` queue, KEDA Container Apps Job, runner MI, Azure Files workspace mount — see [AI Runs worker module](#ai-runs-background-worker-module-feat-003) below.
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
   - Customize resource names if needed

4. **Initialize Terraform**:
   ```bash
   terraform init
   ```

5. **Review the plan**:
   ```bash
   terraform plan
   ```

6. **Apply the configuration**:
   ```bash
   terraform apply
   ```

## Workspaces and environments

Dev and prod share the same `main.tf` and `variables.tf`, but use **separate Terraform workspaces**, **tfvars files**, **Azure subscriptions**, and **state files**. Always confirm all three before running `plan` or `apply`.

| | Dev (lower) | Production |
|---|-------------|------------|
| **Terraform workspace** | `default` | `prd` |
| **Variables file** | `terraform.tfvars` (auto-loaded) | `terraform.prd.tfvars` (pass with `-var-file`) |
| **Azure subscription** | `MSS-DevTest` | `MSS-Production` |
| **State file** | `terraform.tfstate.d/default/terraform.tfstate` | `terraform.tfstate.d/prd/terraform.tfstate` |

`variables.tf` only defines variable names and defaults — it does not select an environment. Unset variables in `terraform.tfvars` use defaults (e.g. `B1` plan, no staging slot). Prod-only settings (P1v3, zone redundancy, staging slot, separate app resource group) belong in `terraform.prd.tfvars` only.

### Check where you are

```bash
terraform workspace show
az account show --query "{subscription:name}" -o table
```

### Dev (lower environment)

```bash
az account set --subscription "MSS-DevTest"
cd infra
terraform workspace select default
terraform plan    # loads terraform.tfvars automatically
terraform apply
```

### Production

```bash
az account set --subscription "MSS-Production"
cd infra
terraform workspace select prd
terraform plan  -var-file="terraform.prd.tfvars"
terraform apply -var-file="terraform.prd.tfvars"
```

Create the `prd` workspace once:

```bash
terraform workspace new prd
```

List all workspaces:

```bash
terraform workspace list
#   default
# * prd
```

The `*` marks the active workspace.

### Switch back to dev after prod work

```bash
terraform workspace select default
az account set --subscription "MSS-DevTest"
```

### Rules of thumb

- **Never** run `terraform apply -var-file="terraform.prd.tfvars"` on the `default` workspace — it will plan to destroy dev and recreate prod resources in dev state.
- **Never** reuse a saved plan file (`terraform.prd.tfplan`) after state changes — run `plan` again first.
- **Always** run `terraform plan` before `apply` and confirm the workspace, subscription, and destroy count.
- After changing only `variables.tf`, dev is unaffected until you apply on `default` with `terraform.tfvars`.

## Production (first-time stand-up)

Dev and prod **must not share state**. See [Workspaces and environments](#workspaces-and-environments) for day-to-day navigation.

1. **Create `terraform.prd.tfvars`** (copy from `terraform.tfvars` and update resource names, `environment = "prd"`, redirect URL, and prod-specific secrets). This file is gitignored.

2. **Switch to prod** (subscription + workspace):
   ```bash
   az account set --subscription "MSS-Production"
   terraform workspace select prd   # or: terraform workspace new prd
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

The App Service plan uses the fixed `app_service_worker_count`. Production
autoscaling is intentionally deferred until Interview and other long-running AI
flows have a multi-instance ownership, cleanup, and scale-in recovery design.

### Shared async + PDF processing settings

The shared Blob account is created in every Terraform workspace. PDF is the first consumer (`pdf-artifacts` container) and runs **inside the Apex App Service**. Job delivery uses the **Postgres queue** (revised ADR) — Terraform does **not** provision Service Bus or a separate PDF worker host.

**Artifact layout:** PDF session/job files live in the private `pdf-artifacts` container keyed per user and session (`{userId}/{sessionId}/...`) rather than on the App Service local disk (`PDF_TEMP_DIR`). This is required because the production API is zone-redundant across multiple fixed instances — any instance must be able to read/write a session's artifacts. The cross-cutting Apex managed identity has shared-account access; clients receive artifacts only through the authenticated API.

| Terraform variable | Purpose | Default |
|--------------------|---------|---------|
| `shared_storage_account_name` | Globally unique shared artifact account; null derives `stapex<environment>async` (for example, `stapexdevasync`) | derived |
| `blob_containers` | Map of private containers on the shared account | `{ pdf-artifacts = {}, repo-grounding = {} }` |
| `pdf_blob_container_name` | PDF container key inside `blob_containers` | `pdf-artifacts` |

App setting contract for the Apex application (wire via deploy pipeline / App Service config — `main.tf` ignores `app_settings` drift):

| App setting | Value source | Consumer |
|-------------|--------------|----------|
| `PDF_BLOB_ACCOUNT_NAME` | `shared_storage_account_name` / `pdf_storage_account_name` output | Apex app |
| `PDF_BLOB_CONTAINER_NAME` | `pdf_blob_container_name` output | Apex app |
| `GROUNDING_BLOB_ACCOUNT_NAME` | `grounding_storage_account_name` output | Grounding bundle store |
| `GROUNDING_BLOB_CONTAINER_NAME` | `grounding_blob_container_name` output | Grounding bundle store |

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
contributor so narrow pre-swap PDF smoke tests use the same production Blob
boundary without connection strings or shared keys. Slot identities do not
move during swaps; Terraform must retain the staging identity and its RBAC grant.

When adding the system identity to an existing App Service with AzureRM 3.x,
provisioning is intentionally two-stage:

1. The first `terraform apply` adds the identity, Storage Account, and container.
2. Run `terraform plan` again after Azure returns the principal ID, then apply
   the Storage Account-scoped Blob role assignment.

Do not deploy the Blob-backed application settings until the second plan shows
`azurerm_role_assignment.api_pdf_blob_contributor` will be created.
When enabling the production staging slot, the plan must also retain the slot's
system identity and manage
`azurerm_role_assignment.staging_pdf_blob_contributor`; removing the identity
would cause staging PDF requests to fail with Blob authorization errors.

#### Extending for another module

1. Add a container key to `blob_containers`.
2. Add a container-scoped role assignment for that module's identity.
3. Wire module-specific app settings to the shared account/container outputs.

#### Non-prod verification

After confirming the `default` workspace and `MSS-DevTest` subscription:

```bash
terraform fmt -check
terraform validate
terraform plan
terraform output shared_storage_account_name
terraform output pdf_blob_container_name
terraform output grounding_blob_container_name
```

Complete the following smoke checks before marking the infrastructure ready:

1. From the Apex App Service identity, upload/read/delete a test blob under a `{userId}/{sessionId}/` prefix in `pdf-artifacts`.
2. Attempt anonymous Blob access from an unassigned principal; access must fail.
3. Confirm `repo-grounding` is private, last-access tracking is enabled, its
   lifecycle rule uses 14 days since last access, and the Apex identity role is
   scoped to that container.

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

After confirming `default` workspace and `MSS-DevTest` subscription:

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
2. Confirm `REPO_READ_SERVICE_URL` matches `repo_read_service_app_fqdn` on **both**
   the App Service and the interactive actor Container App (Terraform writes both
   when the module is on). The actor host has no working tree and cannot see the
   App Service mirror, so a missing URL there leaves interactive turns reading a
   checkout that was never materialized — a silent hang rather than an error.
3. Confirm `REPO_READ_SERVICE_TOKEN` matches `ai_runs_runner_callback_token` on
   both hosts.
4. Target the `repo-read-service` feature flag in Platform Admin. Until then
   Apex keeps in-process checkout reads even if the Container App exists.
5. Smoke: `GET https://<fqdn>/healthz` returns `{ ok: true }`. An unauthenticated
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
terraform workspace select default
terraform apply

# Prod
terraform workspace select prd
terraform apply -var-file="terraform.prd.tfvars"
```

## Costs

Approximate monthly costs (East US):
- **B1 App Service Plan**: ~$13/month
- **Application Insights**: ~$2-5/month (based on usage)

## Cleanup

To destroy all resources in the **active** workspace:

```bash
# Dev
terraform workspace select default
az account set --subscription "MSS-DevTest"
terraform destroy

# Prod
terraform workspace select prd
az account set --subscription "MSS-Production"
terraform destroy -var-file="terraform.prd.tfvars"
```

## Security Notes

- `terraform.tfvars` and `terraform.prd.tfvars` are excluded from git (see `.gitignore`)
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
- Run `terraform workspace show` and `az account show` before every apply
- Dev and prod use separate workspaces — see [Workspaces and environments](#workspaces-and-environments)
- Use remote state (Azure Storage) for team collaboration
- Lock state during operations

**Issue**: `Saved plan is stale`
- Re-run `terraform plan` (and `-var-file` for prod) after any state change; do not reuse old `.tfplan` files

**Issue**: Build fails on deployment
- Check Node.js version compatibility
- Verify all dependencies are in `package.json`
- Review build logs in Azure Portal
