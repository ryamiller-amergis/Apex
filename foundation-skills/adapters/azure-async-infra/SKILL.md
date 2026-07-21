---
name: azure-async-infra
description: APEX adapter for azure-async-infra. Supplies APEX's infra file paths, Terraform module names, and scale-up trigger definitions.
---

# azure-async-infra — APEX Adapter

<!-- Managed loader: loads .apex/foundation/azure-async-infra/SKILL.md -->

Inspect these files before proposing any infrastructure change:
- `infra/shared-async.tf` — shared Blob and Service Bus baseline
- `infra/pdf-processing.tf` — current first-consumer pattern
- `infra/README.md` — environment and module naming conventions

PDF is the first consumer of shared Blob (`pdf-artifacts`) and runs inside APEX.

## APEX-specific scale-up triggers (require ADR before deviating from defaults)

- > 50 concurrent PDF jobs sustained for > 1 week → evaluate dedicated queue
- Fan-out to > 3 downstream consumers → evaluate topic + subscriptions
- Blast-radius or compliance isolation required → evaluate separate namespace/account

## Terraform conventions

See `.cursor/skills/terraform-infra/SKILL.md` for APEX Terraform file layout,
naming, and tagging rules.
