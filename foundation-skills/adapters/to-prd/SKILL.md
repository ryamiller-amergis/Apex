---
name: to-prd
description: Project adapter for to-prd. Customize for your project.
---

# to-prd — Project Adapter

<!-- Managed loader: loads .apex/foundation/to-prd/SKILL.md -->

**Invocation:** `/to-prd`

- Project: {{slot:projectName}}
- Input: `{{slot:aiPilotDir}}kickoff-transcript.md` (sole requirements input — treat as authoritative)
- Reference: `{{slot:contextFile}}`, `{{slot:agentsFile}}`, `{{slot:skillsDir}}to-prd/backlog-schema.json`, `{{slot:skillsDir}}to-prd/SKILL.md`
- PRD template: `{{slot:skillsDir}}to-prd/prd-template.md`
- Backlog example: `{{slot:skillsDir}}to-prd/backlog-example.json`
- Output: `{{slot:aiPilotDir}}output/{kebab-slug}.prd.md` and `{{slot:aiPilotDir}}output/{kebab-slug}.backlog.json`

## Personas and enums

Use the project's own persona, priority, and target-surface vocabulary where defined
(see {{slot:agentsFile}} Key Terminology section). Fall back to generic values when
the project does not define them:
- Priority: `"Must Have"`, `"Should Have"`, `"Could Have"`, `"Won't Have"`

## Terminology

Use this project's canonical terms consistently. See {{slot:agentsFile}} Key
Terminology section for the authoritative glossary.

## Backlog constraints

- `acceptanceCriteria` must include all four scenarios: (a) happy path, (b) error/failure, (c) edge case, (d) negative
- `schema additionalProperties: false` — include only schema-defined properties
- Dependency-locality: item-level `dependsOn` must reference only items within the same Feature
- `implementationPhases` express epic execution order (foundational epics first)
