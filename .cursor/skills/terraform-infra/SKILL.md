---
name: terraform-infra
description: >-
  Apex Terraform development standards for the infra/ module (Azure/azurerm):
  file layout, variables/outputs, for_each maps, naming, tags, secrets, managed
  identity, least-privilege RBAC, fmt/validate, and README contracts. Use when
  creating or editing Terraform under infra/, reviewing infra PRs, ADR or
  grill-design work that will change cloud resources, or any conversation about
  how Apex provisions Azure with Terraform.
---

# Terraform Infrastructure (Apex)

How and why Apex Terraform is written. Canonical code lives in `infra/`.
For Blob / async topology decisions, also load
`.cursor/skills/azure-async-infra/SKILL.md`.

## When this skill applies

Load immediately when any of the following are true:

- Editing or reviewing files under `infra/`
- Adding Azure resources, app settings, role assignments, or worker hosts
- An ADR / grill-design concludes that Terraform must change
- The user asks how Apex does infra-as-code

Respect `.cursor/rules/scope-discipline.mdc`: do not touch `infra/` unless the
user asked for infrastructure work (or an explicit feature delivery includes it).

## Module layout (why)

Keep a **single root module** in `infra/` (not nested modules) unless reuse
across repos is proven. Split by **workload concern**, not by resource type:

| File | Owns |
|------|------|
| `provider.tf` | Terraform/required_providers, azurerm provider flags |
| `main.tf` | Core app stack (RG, App Service, Insights, autoscale, common wiring) |
| `shared-async.tf` | Shared Blob account + containers |
| `pdf-processing.tf` | Apex App Service RBAC for PDF container (no separate PDF host) |
| `variables.tf` | All inputs |
| `outputs.tf` | All outputs (including app-setting contracts) |
| `terraform.tfvars.example` | Documented non-secret defaults and extension examples |
| `README.md` | Operator apply/plan/smoke documentation |

**Add a new `*.tf` file** when a workload needs its own compute/identity surface
beyond the Apex app. **Extend maps** in `shared-async.tf` when the change is
only another container. PDF assembly uses the Apex App Service plus RBAC in
`pdf-processing.tf` — do not invent a second PDF Web App for Blob alone.
Do not scatter the same concern across many tiny files. Do not dump new
platform resources into `main.tf` when they belong on the shared async platform.

## Azure / provider conventions

- Provider: `hashicorp/azurerm` `~> 3.0` (see `provider.tf`).
- Keep `skip_provider_registration = true` unless the user explicitly changes
  subscription registration posture.
- Prefer **system-assigned managed identity** on Web Apps; grant data-plane
  roles with `azurerm_role_assignment`.
- Prefer **entity-scoped** RBAC (container; future queue/subscription if broker
  is added) over account- or namespace-wide roles.
- Disable public/anonymous blob access by default
  (`allow_nested_items_to_be_public = false`, `container_access_type = "private"`).
- Do **not** provision Service Bus by default (PDF uses Postgres + Blob).
- Tag resources with `merge(var.tags, { Environment = var.environment, ... })`.
  Add a `Workload` tag for non-core stacks (`shared-async`, `pdf-processing`).

## Variables and outputs

- Every variable has `type`, `description`, and a safe `default` when optional.
- Mark secrets `sensitive = true` (PATs, passwords, client secrets).
- Prefer **maps + `for_each`** for homogeneous entities (containers) so new
  modules extend tfvars instead of copying resources.
- Derived names: `coalesce(var.x, "pattern-${var.environment}-...")` in `locals`.
- Outputs expose **names/IDs/FQDNs and app-setting key contracts**, not shared
  keys. Mark connection strings `sensitive = true`.
- Keep workload aliases when helpful (e.g. `pdf_storage_account_name` → shared
  account) so feature app settings stay stable.

## Resources and state safety

- Prefer `for_each` over `count` for named entities (stable keys).
- Use `count` only for simple on/off resources (e.g. optional RG/slot/autoscale).
- Avoid in-place renames of globally unique Azure names without a migration
  plan (Storage Account, Web App).
- Do not run `terraform apply` or destroy unless the user explicitly asks.
- After substantive edits, run from `infra/`:

  ```bash
  terraform fmt -recursive
  terraform validate
  ```

  Use `terraform init -backend=false` when only validating locally.

## Secrets and app settings

- Never commit real `terraform.tfvars` or secrets. Update
  `terraform.tfvars.example` with placeholders and comments only.
- Wire runtime config through Web App `app_settings` and documented output
  contracts. Prefer non-secret names (account, container) plus managed identity
  over connection strings when the SDK supports it.
- Do not print secrets, PATs, or signed URLs in README smoke instructions.

## Documentation contract

When adding or changing provisioned resources:

1. Update `infra/README.md` Resources / variables / smoke sections.
2. Update `terraform.tfvars.example` with extension comments when adding maps.
3. Add outputs for anything application Features must consume.
4. State **why** a new account/plan was created if it breaks the shared-platform
   default (isolation driver in comments + README).

## Decision defaults (coding)

| Situation | Do this |
|-----------|---------|
| New async artifacts | Container on shared storage (`blob_containers`) |
| New background jobs at current scale | Postgres job queue (app) — not Service Bus by default |
| Heavy isolated compute | Dedicated plan + Web App only when evidence requires it |
| API needs blob access | Role assignment scoped to that container on `azurerm_linux_web_app.main` |
| Unsure about topology | Load `azure-async-infra` skill; do not invent a parallel stack |

## Anti-patterns

- New Storage Account per feature without an isolation driver
- Provisioning Service Bus “for PDF” without an accepted scale-up ADR
- Hard-coding resource names that must vary by environment
- Duplicating near-identical container resources instead of `for_each`
- Account-wide Blob Contributor “for convenience”
- Editing CI/CD or `package.json` to “make Terraform work” without permission
- Shipping infra without README/output updates the next Feature needs

## Related

- Topology: `.cursor/skills/azure-async-infra/SKILL.md`
- Rule (auto on `infra/**`): `.cursor/rules/terraform-infra.mdc`
- Operators: `infra/README.md`
- Scope: `.cursor/rules/scope-discipline.mdc`
