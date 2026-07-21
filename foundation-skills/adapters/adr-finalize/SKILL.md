---
name: adr-finalize
description: APEX adapter for adr-finalize. Supplies the APEX MADR template and infra citation rules.
---

# adr-finalize — APEX Adapter

<!-- Managed loader: loads .apex/foundation/adr-finalize/SKILL.md -->

- Project: {{slot:projectName}}
- Template: see `adr-template.md` in this adapter — follow exactly
- Output: `.ai-pilot/output/{slug}.adr.md`
- When the decision adopts or rejects shared Blob/Service Bus topology: cite `.cursor/skills/azure-async-infra/SKILL.md` and `infra/shared-async.tf` in References
