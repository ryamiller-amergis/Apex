---
name: prd-spec-review
description: Project adapter for prd-spec-review. Customize for your project.
---

# prd-spec-review — Project Adapter


**Invocation:** `/prd-spec-review {slug}`

- Project: {{slot:projectName}}
- Inputs: `{{slot:aiPilotDir}}output/{slug}.prd.md`, `{{slot:aiPilotDir}}output/{slug}.backlog.json`,
  `{{slot:contextFile}}`, `../to-prd/backlog-schema.json`, `../to-prd/SKILL.md`
- Outputs: `{{slot:aiPilotDir}}output/{slug}-prd-review-scorecard.json` and `{slug}-prd-review-scorecard.md`
- Overall formula: `(prd_score × 0.50) + (backlog_score × 0.50)`

## Personas and canonical terms

Use this project's own persona and surface vocabulary where defined (see
{{slot:agentsFile}} Key Terminology section).

## Section rubrics and cross-cutting checks

See `rubric.md` for the full PRD-markdown section weights, backlog JSON section
weights, and cross-cutting check table. Score and output must follow `rubric.md`
and `scorecard-template.md` exactly.
