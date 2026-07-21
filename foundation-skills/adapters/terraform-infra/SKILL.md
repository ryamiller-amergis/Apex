---
name: terraform-infra
description: APEX adapter for terraform-infra. Supplies APEX's infra/ module structure, state config, and provider versions.
---

# terraform-infra — APEX Adapter

<!-- Managed loader: loads .apex/foundation/terraform-infra/SKILL.md -->

- Project: {{slot:projectName}}
- Infra root: `infra/`
- Modules: `infra/` contains per-concern .tf files (see `infra/README.md` for layout)
- State: remote Azure backend (config in `infra/backend.tf`)
- Provider: `hashicorp/azurerm` — pin version in `providers.tf`
- Environment distinction: use `var.environment` and locals to vary names

Read `infra/README.md` before creating new resources. Follow the existing
`locals.tf` naming pattern in the module.
