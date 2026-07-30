---
name: design-spec-review
description: Project adapter for design-spec-review. Customize for your project.
---

# design-spec-review — Project Adapter

<!-- Managed loader: loads .apex/foundation/prd-spec-review/SKILL.md -->

**Invocation:** `/design-spec-review {slug}`

- Project: {{slot:projectName}}
- Inputs: all `*-design.md`, `*-tech-spec.md`, `*-assumptions.md` under `{{slot:aiPilotDir}}output/{slug}-design-spec/`; also `{{slot:contextFile}}`, the three prd-design-spec templates, and `{{slot:aiPilotDir}}output/{slug}.backlog.json`
- Outputs: `{{slot:aiPilotDir}}output/{slug}-design-spec/review-scorecard.json` and `review-scorecard.md`
- Formula: per-Feature score = design 35% + tech-spec 45% + assumptions 20%; overall = unweighted average across Features

## Personas and canonical terms

Use this project's own persona, surface, and term vocabulary where defined (see
{{slot:agentsFile}} Key Terminology section). Ownership questions should reference
the project's own source layer locations (see {{slot:agentsFile}} Directory
Structure section) — never external project names.

## Section rubrics and cross-cutting checks

See `rubric.md` for the full design/tech-spec/assumptions section weight tables
and cross-cutting check table. Follow `scorecard-template.md` for output format.
