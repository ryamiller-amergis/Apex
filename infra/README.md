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
- **App Service autoscale** (optional): CPU-based scale-out on the API plan, minimum held at 3 for zone redundancy
- **Shared async Blob storage**: One private Storage Account per environment; modules isolate via containers (PDF starts with `pdf-artifacts`, keyed per `{userId}/{sessionId}/...`)
- **Managed-identity access**: The Apex App Service identity is scoped to the PDF container. PDF assembly stays in the Apex application; job delivery uses the Postgres queue (Service Bus deferred).

## Shared async platform conventions

Prefer extending the shared storage account over provisioning one-offs:

| Need | Add | Do not |
|------|-----|--------|
| Binary/session artifacts for a module | A private container in `blob_containers` | A second storage account (unless hard isolation is required) |
| Background jobs at current PDF scale | Postgres job queue (app-owned) | Service Bus "because async" |
| Worker compute | Prefer in-app on the Apex App Service unless isolation/scale requires a dedicated host | New App Service “because the feature is async” |

RBAC stays least-privilege per container: grant Blob Data Contributor on the specific container. Service Bus remains an optional future platform (revised ADR scale-up path) — do not provision it by default.
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

### App Service autoscale

Autoscale is optional and off by default (`enable_autoscale = false`), so non-prod plans run at the static `app_service_worker_count`. Production enables it (`terraform.prd.tfvars`) to scale the API plan out on sustained CPU while keeping the minimum at 3 for zone redundancy.

| Terraform variable | Purpose | Default |
|--------------------|---------|---------|
| `enable_autoscale` | Create the CPU autoscale setting for the API plan | `false` |
| `autoscale_min_capacity` | Instance floor (keep >= 3 when zone-redundant) | `3` |
| `autoscale_max_capacity` | Scale-out ceiling | `6` |
| `autoscale_default_capacity` | Fallback when metrics are unavailable | `3` |
| `autoscale_cpu_scale_out_threshold` | Avg CPU % (10-min window) that adds an instance | `70` |
| `autoscale_cpu_scale_in_threshold` | Avg CPU % below which an instance is removed | `30` |

When autoscale is enabled it owns the live instance count, so the plan's `worker_count` is intentionally ignored by Terraform (`ignore_changes`) to avoid drift. Scale-out cooldown is 5 min; scale-in cooldown is 10 min.

### Shared async + PDF processing settings

The shared Blob account is created in every Terraform workspace. PDF is the first consumer (`pdf-artifacts` container) and runs **inside the Apex App Service**. Job delivery uses the **Postgres queue** (revised ADR) — Terraform does **not** provision Service Bus or a separate PDF worker host.

**Artifact layout:** PDF session/job files live in the private `pdf-artifacts` container keyed per user and session (`{userId}/{sessionId}/...`) rather than on the App Service local disk (`PDF_TEMP_DIR`). This is required because the API runs multiple instances — any instance (or autoscaled instance) must be able to read/write a session's artifacts. The Apex managed identity has container-scoped access; clients receive short-lived user-scoped URLs after authorization.

| Terraform variable | Purpose | Default |
|--------------------|---------|---------|
| `shared_storage_account_name` | Globally unique shared artifact account; set explicitly if the derived name is unavailable | derived |
| `blob_containers` | Map of private containers on the shared account | `{ pdf-artifacts = {} }` |
| `pdf_blob_container_name` | PDF container key inside `blob_containers` | `pdf-artifacts` |

App setting contract for the Apex application (wire via deploy pipeline / App Service config — `main.tf` ignores `app_settings` drift):

| App setting | Value source | Consumer |
|-------------|--------------|----------|
| `PDF_BLOB_ACCOUNT_NAME` | `shared_storage_account_name` / `pdf_storage_account_name` output | Apex app |
| `PDF_BLOB_CONTAINER_NAME` | `pdf_blob_container_name` output | Apex app |

The Apex managed identity receives container-scoped Blob contributor. No connection strings or shared keys are emitted.

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
