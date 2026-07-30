---
name: adr-finalize
description: Project adapter for adr-finalize. Customize for your project.
---

# adr-finalize — Project Adapter

<!-- Managed loader: loads .apex/foundation/adr-finalize/SKILL.md -->

- Project: {{slot:projectName}}
- Template: see `adr-template.md` in this adapter — follow exactly
- Output: `{{slot:aiPilotDir}}output/{slug}.adr.md`
- When the decision adopts or rejects shared Blob/Service Bus topology: cite `{{slot:skillsDir}}azure-async-infra/SKILL.md` (if present) in References
