---
name: terraform-infra
description: Terraform development standards for Azure infrastructure (azurerm provider). Use when creating or editing Terraform, reviewing infra PRs, or discussing how infrastructure is provisioned with Terraform.
---

# Terraform Infrastructure — Foundation

How to write and maintain Terraform for Azure infrastructure.

## Module layout principles

- Keep a **single root module** unless reuse across repos is proven.
- Split by **workload concern**, not by resource type.
- Common files: `provider.tf`, `main.tf`, `variables.tf`, `outputs.tf`, `terraform.tfvars.example`, `README.md`.
- Add a new `*.tf` file when a workload needs its own compute/identity surface. Extend maps for simpler additions.

## Azure / provider conventions

- Use the `hashicorp/azurerm` provider.
- Prefer **system-assigned managed identity** on compute resources; grant data-plane roles with `azurerm_role_assignment`.
- Prefer **entity-scoped** RBAC over resource-wide roles.
- Disable public/anonymous blob access by default.
- Tag resources with environment and workload labels.

## Variables and outputs

- Every variable has `type`, `description`, and a safe `default` when optional.
- Mark secrets `sensitive = true`.
- Prefer **maps + `for_each`** for homogeneous entities.
- Outputs expose **names/IDs and app-setting contracts**, not shared keys.

## State safety

- Prefer `for_each` over `count` for named entities (stable keys).
- Avoid in-place renames of globally unique Azure names without a migration plan.
- Do not run `terraform apply` or destroy unless explicitly asked.
- After substantive edits, run: `terraform fmt -recursive && terraform validate`

## Secrets and app settings

- Never commit real `terraform.tfvars` or secrets.
- Wire runtime config through compute app settings and documented output contracts.
- Prefer non-secret names + managed identity over connection strings.

## Documentation contract

When adding or changing provisioned resources:
1. Update `README.md` (or project equivalent) with Resources / variables / smoke sections.
2. Update `terraform.tfvars.example` with extension comments.
3. Add outputs for anything consuming applications must use.

## Anti-patterns

- New Storage Account per feature without an isolation driver
- Hard-coding resource names that must vary by environment
- Duplicating near-identical resources instead of `for_each`
- Account-wide Blob Contributor "for convenience"
- Shipping infra without README/output updates
