# Terraform: rebuild dev state by import

Handoff file. Continues `.cursor/plans/terraform-shared-pipeline.md` (on branch
`infra/terraform-remote-state`).

## Goal

Dev (`MSS-DevTest`, `rg-scrum-dev`) has no usable Terraform state. Rebuild it
by importing the live resources so `plan` shows only the intended changes,
without modifying or deleting anything in Azure. Prod is untouched.

## Done

- Branch `infra/terraform-remote-state` checked out; `origin/main` merged in
  (merge commit `1e6996da`, local only, not pushed).
- Prod state backed up: `~/tfstate-backups/prd-20261108-120953.tfstate`
  (sha256 `21d16054…`, identical to `infra/terraform.tfstate.d/prd/terraform.tfstate`).
- Rebuild workspace (outside the repo): `C:\Users\anedunur\source\repos\tf-dev-rebuild\`
  - `work/` — copy of `infra/*.tf`, `ai-platform-v2-contracts.json`,
    `.terraform.lock.hcl`, plus `zz_dev_rebuild_override.tf` (local backend →
    `tf-dev-rebuild/dev.tfstate`). Re-copy `.tf` files if `infra/` changes.
  - `dev.tfvars` — non-secret dev inputs from live Azure. Includes Aneesh's
    `ai_platform_v2_interactive_mount_workspace_share = false` and
    `ai_runs_interactive_reserved = 0`.
  - `env.sh` — `source ../env.sh` from `work/`. Sets `TF_DATA_DIR` (Windows path),
    `TF_WORKSPACE=default`, `ARM_SUBSCRIPTION_ID` (dev), and reads secrets from
    live dev apps into `TF_VAR_*` (memory only).
- Empty-state plan: 97 resources planned, names match dev. Stopped on
  `repo_read_workspace` count (resolves after import).

## Gotchas found

- Running `terraform init` in `infra/` offers to migrate the old local
  workspaces (incl. prd) into the configured backend. Never answer it / never
  `-force-copy`. That is why the rebuild runs from `work/`.
- With `MSYS_NO_PATHCONV=1`, `/c/...` paths in env vars reach terraform.exe as
  `C:\c\...`. Use `C:/...` paths. Group policy blocks provider .exe outside
  allowed folders; `source\repos\...` works.
- Shell env does not persist between agent commands: source `env.sh` in the
  same command as every terraform call.

## Acceptance (Aneesh)

Final dev plan must show only:
- old chat app `ca-apex-ai-interactive-dev` min 4 → 0, max 16 → 12;
- storage cleanup rule (`azurerm_storage_management_policy.lt_artifacts_lifecycle`) updated;
- no share re-added to agentic / fast chat apps.
Anything else (especially repo-read losing its GitHub token) → stop and review.

## Import results (plan only, nothing applied, dev.tfstate still empty)

- `work/imports.tf` (57) + `work/imports-ra.tf` (37 role assignments) → pass3 plan:
  94 import, 15 add, 30 change, 2 destroy. Plans/JSON in `tf-dev-rebuild/pass3*`.
- Tags: dev is mixed (V2 resources `Application=Apex`, rest `Scrum`). Default
  tags kept → 7 tag-only updates on V2 resources.
- azapi actions (5): bodies equal live values (grace 600, cooldown 900, logs azure-monitor).
- Awaiting Aneesh's decisions:
  - `azurerm_servicebus_queue.ai_runs_background` REPLACE (dup detection false→true,
    PT10M→PT30M; code hardcodes in `infra/ai-runs-worker.tf:97`) + KEDA auth rule replace.
  - `repo_read_service` hand-built in dev: container name, probes, tags differ.
  - Web app: adds `/api/health` health check + 8 sticky settings (from code).
  - Postgres `log_min_duration_statement` -1→5000, `pg_stat_statements.track` none→top.
  - `cursor_pool_worker` job secret: plain value → Key Vault reference.
  - Documents app gains `AZURE_INSIGHTS_CLIENT_ID` (from main).
  - New: `cursor-prompts` container + 2 grants; web app blob grant on `ai-run-artifacts`;
    deployer KV Secrets Officer for whoever runs (dev's existing one is Ryan's).
  - `azurerm_key_vault_secret.ai_runs_cursor_api_key`: exists in dev, needs import
    with versioned ID; Aneesh lacks secret read on `kv-apex-ai-dev`.
- Plan for writing state: apply only the no-op imports (`-target`), CLI
  `terraform import` the drifted ones (state-only), then decide each change.

## State written (2026-11-08 13:43)

- `tf-dev-rebuild/dev.tfstate`: 94 resources imported, no Azure changes
  (import-only plan verified 94 import / 0 add / 0 change / 0 destroy).
  Backup in `~/tfstate-backups/dev-rebuilt-*.tfstate`. Prod hash unchanged.
- Method: `make-import-copy.js` builds `work-import/` (scratch: `ignore_changes = all`
  on every resource, no `depends_on`, KV secret ref = live versioned ID), then a
  targeted plan of the 94 import addresses (`import-addrs.txt`). `work/` itself
  is identical to `infra/` (import blocks parked in `import-hold/`).
- Real-code plan from `work/` (`real-plan.txt`): 15 add, 24 change, 2 replace —
  exactly the reviewed list. NOT applied. Aneesh: apply only once dev matches
  prod's shape with dev-sized settings.
- Aneesh approved converging: repo-read shape, web app health check + sticky
  settings, Postgres logging, cursor worker KV ref, documents insights client
  ID, new cursor-prompts container + grants. KV: let Terraform create the
  deployer Secrets Officer grant, then import
  `https://kv-apex-ai-dev.vault.azure.net/secrets/cursor-api-key/6781c277d6684faab5c63984aa738530`.
- Open: `ai-runs-background` queue. Aneesh first chose `ignore_changes`, but
  the code comment (`infra/ai-runs-worker.tf`) says duplicate detection was
  added after the 2026-09-10 incident; ignoring it leaves dev unprotected and
  stops enforcing it anywhere. DECIDED: no code change; drain dev's queue and
  let Terraform recreate it at apply time.
  `ai_runs_api_sb_sender` / `ai_runs_runner_sb_receiver` show as create only
  because of that replacement.

## Update 2026-11-08 15:30 (pushed as 190b1139 on PR #249)

- Committed `infra/env/dev.tfvars` and `infra/scripts/dev-tf-secrets.sh`; README dev runbook updated.
- `ai_runs_deployer_kv_secrets_officer` is now `for_each` over
  `ai_runs_key_vault_secrets_officer_ids`. Dev lists Ryan (`110b196f…`, imported
  into dev state) and Aneesh (`1ceaafde…`, create at apply). Dev state: 100 entries.
- Prod migration must: add `ai_runs_key_vault_secrets_officer_ids = ["1ceaafde-4871-4411-9ef7-5432c7b4e080"]`
  to local `terraform.prd.tfvars` (back it up first) and
  `terraform state mv 'azurerm_role_assignment.ai_runs_deployer_kv_secrets_officer[0]' 'azurerm_role_assignment.ai_runs_deployer_kv_secrets_officer["1ceaafde-4871-4411-9ef7-5432c7b4e080"]'`.
- Do the prod push from a clean folder (like tf-dev-rebuild): `init` in `infra/`
  prompts to migrate local workspaces. After prod plan shows no changes, move
  `infra/terraform.tfstate.d/` out of the repo (keep a backup).
- Blocked on access (Aneesh asking admins):
  - Dev: RBAC Administrator on `rg-scrum-dev`; Key Vault Secrets Officer on `kv-apex-ai-dev`;
    `rg-apex-tfstate-dev` created with Aneesh as Owner.
  - Prod: `rg-apex-tfstate-prd` created with Aneesh as Owner (he has only Reader
    on the subscription; do not bootstrap into `rg-apex-prd-data` — the script's
    `az group create` would overwrite that group's tags).

## Next steps

1. Pass 1: generate import blocks for non-role-assignment resources, verify IDs
   exist, plan, apply only import-only (no-op) items via `-target`;
   use CLI `terraform import` for drifted ones.
2. Pass 2: role assignments (match scope + role + principal from `az role assignment list`).
3. Special cases: `azapi_resource_action.*` (cannot import; compare live values),
   `azurerm_key_vault_secret.ai_runs_cursor_api_key` (Aneesh lacks secret read on
   `kv-apex-ai-dev`), `ai_runs_deployer_kv_secrets_officer` (principal = whoever runs).
4. Push finished state to remote backend once bootstrapped.
