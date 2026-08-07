---
name: adr-assistant
description: Project adapter for adr-assistant. Customize for your project.
---

# adr-assistant — Project Adapter


- Project: {{slot:projectName}}
- ADR catalog: `{{slot:aiPilotDir}}output/*.adr.md` and `{{slot:designDocsDir}}` for historical ADRs
- For new decisions: use `adr-interview` then `adr-finalize`
