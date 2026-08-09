---
name: create-test-case
description: Project adapter for create-test-case. Customize for your project.
---

# create-test-case — Project Adapter


**Invocation:** `/create-test-case {slug}`

- Project: {{slot:projectName}}
- Backlog input: `{{slot:aiPilotDir}}output/{slug}.backlog.json`
- PRD input: `{{slot:aiPilotDir}}output/{slug}.prd.md` (skip with `--no-prd`)
- Backlog schema: `{{slot:skillsDir}}to-prd/backlog-schema.json`
- Test case schema: `{{slot:skillsDir}}create-test-case/test-case-schema.json`
- Test case example: `{{slot:skillsDir}}create-test-case/test-case-example.json`
- Outputs: `{{slot:aiPilotDir}}output/{slug}-test-cases.json` and `{{slot:aiPilotDir}}output/{slug}-test-cases.md`

## Scope flags

- `--pbi PBI-NNN` — scope to one PBI
- `--feature "Title"` — scope to all PBIs under a Feature
- `--no-prd` — backlog only (skip PRD enrichment)
