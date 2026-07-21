---
name: create-test-case
description: APEX adapter for create-test-case. Binds to APEX file paths, backlog schema, and test case output schema.
---

# create-test-case — APEX Adapter

<!-- Managed loader: loads .apex/foundation/create-test-case/SKILL.md -->

**Invocation:** `/create-test-case {slug}`

- Project: {{slot:projectName}}
- Backlog input: `.ai-pilot/output/{slug}.backlog.json`
- PRD input: `.ai-pilot/output/{slug}.prd.md` (skip with `--no-prd`)
- Backlog schema: `.cursor/skills/to-prd/backlog-schema.json`
- Test case schema: `.cursor/skills/create-test-case/test-case-schema.json`
- Test case example: `.cursor/skills/create-test-case/test-case-example.json`
- Outputs: `.ai-pilot/output/{slug}-test-cases.json` and `.ai-pilot/output/{slug}-test-cases.md`

## Scope flags

- `--pbi PBI-NNN` — scope to one PBI
- `--feature "Title"` — scope to all PBIs under a Feature
- `--no-prd` — backlog only (skip PRD enrichment)
