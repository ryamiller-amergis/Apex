# Terraform: shared remote state and pipeline

Handoff file. A fresh chat should be able to continue from this alone.

## Goal

Move Apex Terraform (`infra/`, one root module) off laptop state and laptop
applies:

1. Shared remote state in Azure Storage, one account per subscription.
2. A GitHub Actions workflow: `plan` on pull requests, `apply` dev on merge to
   `main`, `apply` prd behind the existing `prd-production` GitHub environment,
   authenticated with GitHub OIDC (no stored Azure secrets).

Before this effort: Aneesh ran prod from the local `prd` workspace
(`infra/terraform.tfstate.d/prd/terraform.tfstate`, `terraform.prd.tfvars`,
`MSS-Production`). Ryan ran dev from the local `default` workspace
(`infra/terraform.tfstate`, `terraform.tfvars`, `MSS-DevTest`). Prod is one
apply ahead of dev; that is expected, not drift.

## Phases

- **0 — Prep.** Collect Ryan's open items (below). Agree on Terraform version.
- **1 — Remote state (branch `infra/terraform-remote-state`, draft PR).**
  - `infra/provider.tf`: empty partial `backend "azurerm" {}`.
  - `infra/backend/dev.hcl`, `infra/backend/prd.hcl`: keys `dev.tfstate` /
    `prd.tfstate`, Azure AD auth, placeholder subscription and tenant IDs.
  - `infra/scripts/bootstrap-tfstate.sh`: creates the state RG, storage account
    (no public blob access, TLS 1.2, shared keys off, versioning, 30-day blob and
    container soft delete), private `tfstate` container, and grants the caller
    `Storage Blob Data Contributor`.
  - `infra/.terraform.lock.hcl` committed (removed from `.gitignore`): azapi
    2.12.0, azuread 3.9.0, azurerm 3.117.1, random 3.9.0, hashes for
    linux_amd64, windows_amd64, darwin_amd64, darwin_arm64.
  - `infra/README.md`: "Environments and remote state" replaces the workspaces
    section; contains the bootstrap steps, migration runbook, and team rules.
- **2 — Environment tfvars.** Commit non-secret per-environment tfvars (for
  example `infra/env/dev.tfvars`, `infra/env/prd.tfvars`; needs a `.gitignore`
  exception). Secrets move to GitHub environment secrets (`dev`,
  `prd-production`) and reach Terraform as `TF_VAR_*`. Requires the full list
  of variable names per environment and which are `sensitive`.
- **3 — Pipeline identity, one per environment.** Entra app registration or
  user-assigned managed identity with GitHub OIDC federated credentials
  (subjects for `pull_request` and for `environment:dev` /
  `environment:prd-production`). Roles on the subscription (or the Apex RGs):
  `Contributor` + `User Access Administrator` (the module creates role
  assignments). `Storage Blob Data Contributor` on that environment's state
  account. Microsoft Graph application permission, for example
  `Application.ReadWrite.OwnedBy`, with tenant admin consent, because
  `infra/ai-runs-worker-entra.tf` and `infra/load-test-entra.tf` manage Entra
  objects through `azuread`. Plan-only PR identity may get Reader + state read
  instead.
- **4 — GitHub Actions Terraform workflow.** New file under
  `.github/workflows/` (needs explicit approval per scope-discipline): fmt
  check, `init -backend-config=backend/<env>.hcl`, validate, plan on PR with the
  plan posted to the PR, apply dev on merge, apply prd gated by
  `prd-production`. One concurrency group per environment.
- **5 — Cleanup.** Pin `required_version` in `infra/provider.tf` to the agreed
  version (and `setup-terraform` in the workflow). Delete local state files on
  laptops. Move `scripts/dev-aiv2-tf.sh` off the `dev-aiv2` workspace (own
  state key or retire). Remove leftover workspace references in
  `docs/superpowers/plans/*` if they are still used as runbooks.

## Current status

- Phase 1 implemented on `infra/terraform-remote-state`, draft PR open.
  `terraform fmt -check -recursive`, `terraform init -backend=false`,
  `terraform validate`, and `node scripts/ci/check-codemap-paths.mjs` pass
  (Terraform 1.17.0).
- Nothing has been created in Azure. The bootstrap script has not been run.
  No state has been migrated.

## Open items (waiting on Ryan)

- His unmerged `.tf` changes: merge or rebase them before dev state migrates,
  so the dev plan after migration is meaningful.
- Dev tfvars: variable names in his `terraform.tfvars` and which are secret.
- His Terraform version (decides `required_version`).
- Dev subscription ID (for `backend/dev.hcl` and the bootstrap run).
- Any hand-made portal changes in dev that Terraform does not know about.
- Whether `dev-aiv2` workspace state (used by `infra/scripts/dev-aiv2-tf.sh`,
  `rg-scrum-dev`) is still live, and who owns it.

## Next steps

1. Run `infra/scripts/bootstrap-tfstate.sh prd <prd-subscription-id> <location>`
   (Aneesh) and the dev equivalent (Ryan, once the subscription ID is known).
   Copy the printed values into `infra/backend/prd.hcl` / `dev.hcl`, replacing
   every `<...>` placeholder, and push to the branch.
2. Grant `Storage Blob Data Contributor` on each state account to everyone who
   runs `plan`.
3. Prod migration (Aneesh), following `infra/README.md` → "One-time migration
   from local state": `terraform workspace select prd`, `terraform state pull >
   backup` **before** pulling the branch; then `init -reconfigure
   -backend-config=backend/prd.hcl`, `terraform state push backup`, `plan
   -var-file=terraform.prd.tfvars` must show no changes.
4. Dev migration (Ryan): back up `terraform.tfstate`, `init -migrate-state
   -backend-config=backend/dev.hcl`, `plan -var-file=terraform.tfvars`; expect
   only the resources from prod's latest apply.
5. Merge the PR after both plans are confirmed. Then delete local state files
   and stop using workspaces.
6. Start phase 2.
