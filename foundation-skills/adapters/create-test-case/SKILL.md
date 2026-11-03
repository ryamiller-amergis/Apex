---
name: create-test-case
description: Project adapter for create-test-case. Customize for your project.
---

# create-test-case — Project Adapter


**Invocation:** `/create-test-case {slug}`

- Project: {{slot:projectName}}
- Backlog input: `{{slot:aiPilotDir}}output/{slug}.backlog.json`
- PRD input: `{{slot:aiPilotDir}}output/{slug}.prd.md` (skip with `--no-prd`)
- Backlog schema: `../to-prd/backlog-schema.json`
- Test case schema: `test-case-schema.json`
- Test case example: `test-case-example.json`
- Outputs: `{{slot:aiPilotDir}}output/{slug}-test-cases.json` and `{{slot:aiPilotDir}}output/{slug}-test-cases.md`

## Scope flags

- `--pbi PBI-NNN` — scope to one PBI
- `--feature "Title"` — scope to all PBIs under a Feature
- `--no-prd` — backlog only (skip PRD enrichment)

## Azure DevOps placement

Where Apex files this project's published Test Cases. Leave this section empty to link each case to its requirement with Tested By.

Write the rule in plain words and list the exact paths and tags to use. For example:

- Link each case to its parent Feature with Tested By (`linkTo: parent`, `linkType: tested-by`).
- Area path by module: Payments → `Project\Billing\Payments`; Onboarding → `Project\Core\Onboarding`.
- Tag every case `qa-lab`; tag E2E candidates `e2e`.
- File every case in its module's Test Plan, in the matching feature suite; a suite is required.
