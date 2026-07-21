---
name: adr-assistant
description: APEX adapter for adr-assistant. Binds to APEX's ADR catalog location and links to the interview/finalize skills.
---

# adr-assistant — APEX Adapter

<!-- Managed loader: loads .apex/foundation/adr-assistant/SKILL.md -->

- Project: {{slot:projectName}}
- ADR catalog: `.ai-pilot/output/*.adr.md` and `design-docs/` for historical ADRs
- For new decisions: use `adr-interview` then `adr-finalize`
