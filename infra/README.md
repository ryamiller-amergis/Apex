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
- **Shared async Blob storage**: One private Storage Account per environment; modules isolate via containers (PDF starts with `pdf-artifacts`, load-test adds `lt-artifacts`)
- **Managed-identity access**: The cross-cutting Apex App Service identity is scoped to the shared Storage Account. PDF assembly stays in the Apex application; job delivery uses the Postgres queue (Service Bus deferred).
- **Load Test infrastructure** (FEAT-002): Dedicated Service Bus namespace, Container Apps Job, and managed identities — see [Load Test module](#load-test-module-feat-002) below.

## Shared async platform conventions

Prefer extending the shared storage account over provisioning one-offs:

| Need | Add | Do not |
|------|-----|--------|
| Binary/session artifacts for a module | A private container in `blob_containers` | A second storage account (unless hard isolation is required) |
| Background jobs at current PDF scale | Postgres job queue (app-owned) | Service Bus "because async" |
| Worker compute | Prefer in-app on the Apex App Service unless isolation/scale requires a dedicated host | New App Service “because the feature is async” |

RBAC defaults to least-privilege per container. The shared Apex App Service identity is the documented exception because it hosts multiple in-process workloads and receives Blob Data Contributor at the shared account scope. Service Bus remains an optional future platform (revised ADR scale-up path) — do not provision it by default.
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
| `blob_containers` | Map of private containers on the shared account | `{ pdf-artifacts = {} }` |
| `pdf_blob_container_name` | PDF container key inside `blob_containers` | `pdf-artifacts` |

App setting contract for the Apex application (wire via deploy pipeline / App Service config — `main.tf` ignores `app_settings` drift):

| App setting | Value source | Consumer |
|-------------|--------------|----------|
| `PDF_BLOB_ACCOUNT_NAME` | `shared_storage_account_name` / `pdf_storage_account_name` output | Apex app |
| `PDF_BLOB_CONTAINER_NAME` | `pdf_blob_container_name` output | Apex app |

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
```

Complete the following smoke checks before marking the infrastructure ready:

1. From the Apex App Service identity, upload/read/delete a test blob under a `{userId}/{sessionId}/` prefix in `pdf-artifacts`.
2. Attempt anonymous Blob access from an unassigned principal; access must fail.

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
| `azurerm_storage_container.lt_artifacts` | Blob container on the shared storage account; holds summary + time-series artifacts |
| `azurerm_storage_management_policy.lt_artifacts_lifecycle` | ~90-day deletion policy scoped to the `lt-artifacts/` prefix |
| `azurerm_container_app_environment.load_test` | VNet-integrated CAE for non-prod target reachability |
| `azurerm_container_app_job.load_test_runner` | KEDA-scaled k6 runner; max-executions enforces platform concurrency cap |
| `azurerm_user_assigned_identity.lt_runner` | Runner MI: queue receive + blob contribute + Key Vault Secrets User |

### Identity and RBAC

| Identity | Roles | Scope |
|----------|-------|-------|
| Runner MI (`mi-apex-lt-runner-*`) | Azure Service Bus Data **Receiver** | `lt-dispatch` queue |
| Runner MI | Storage Blob Data **Contributor** | `lt-artifacts` container |
| Runner MI | Key Vault Secrets **User** | `var.lt_key_vault_id` (when set) |
| Apex API (App Service system identity) | Azure Service Bus Data **Sender** | `lt-dispatch` queue |
| Apex API | Storage Blob Data **Reader** | `lt-artifacts` container |
| Apex staging slot (when enabled) | Azure Service Bus Data **Sender** | `lt-dispatch` queue |
| Apex staging slot (when enabled) | Storage Blob Data **Reader** | `lt-artifacts` container |

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

The Container Apps Job references `var.lt_runner_image` (default
`grafana/k6:latest` as a placeholder). After building the Apex runner image
(see `runner/Dockerfile`), update this variable to the pinned ACR digest:

```hcl
lt_runner_image = "<acr>.azurecr.io/apex-lt-runner:<tag>@sha256:<digest>"
```

Always pin by **digest** (not `:latest`) in production to guarantee supply-chain
reproducibility (TBI-002 D4).

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
3. Confirm KEDA scale rule `lt-servicebus-keda` is present on the job and binds to `lt-dispatch`.
4. Confirm `max_executions` is 1 or 2.
5. Confirm `lt-artifacts` container exists on the shared storage account with the 90-day lifecycle rule.
6. **Negative check:** Attempt queue receive and blob write with a non-module identity; both must be denied by Azure RBAC (VT-04).

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
