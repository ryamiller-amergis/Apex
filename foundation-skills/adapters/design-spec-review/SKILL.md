---
name: design-spec-review
description: APEX adapter for design-spec-review. Supplies APEX rubric tables for design/tech-spec/assumptions artifacts, terminology enums, and file paths.
---

# design-spec-review — APEX Adapter

<!-- Managed loader: loads .apex/foundation/prd-spec-review/SKILL.md -->

**Invocation:** `/design-spec-review {slug}`

- Project: {{slot:projectName}}
- Inputs: all `*-design.md`, `*-tech-spec.md`, `*-assumptions.md` under `.ai-pilot/output/{slug}-design-spec/`; also `context.md`, the three prd-design-spec templates, and `.ai-pilot/output/{slug}.backlog.json`
- Outputs: `.ai-pilot/output/{slug}-design-spec/review-scorecard.json` and `review-scorecard.md`
- Formula: per-Feature score = design 35% + tech-spec 45% + assumptions 20%; overall = unweighted average across Features

## APEX enums (use ONLY these)

- Persona: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`
- Target surface: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`
- Canonical terms: `Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`

APEX is a product-building platform — NOT a timeclock, staffing, or healthcare app.
The 5 Apex ownership questions are about Express services, routes, React components,
shared types, and DB migrations — never about external project names.

## Section rubrics and cross-cutting checks

See `rubric.md` for the full design/tech-spec/assumptions section weight tables
and cross-cutting check table. Follow `scorecard-template.md` for output format.
