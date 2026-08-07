---
name: adr-interview
description: Project adapter for adr-interview. Customize for your project.
---

# adr-interview — Project Adapter


- Project: {{slot:projectName}}
- Context: `{{slot:contextFile}}`, `{{slot:agentsFile}}`, existing `{{slot:designDocsDir}}`, `{{slot:skillsDir}}`
- Infra references (when decision involves async/storage): `{{slot:skillsDir}}azure-async-infra/SKILL.md` (if present)
- Terraform references: `{{slot:skillsDir}}terraform-infra/SKILL.md` (if present)
- Output transcript: `{{slot:aiPilotDir}}kickoff-transcript.md`

## Active glossary

{{slot:glossary}}
