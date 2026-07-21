---
name: prd-spec-review
description: APEX adapter for prd-spec-review. Supplies APEX rubric tables, terminology enums, persona enums, and file paths.
---

# prd-spec-review — APEX Adapter

<!-- Managed loader: loads .apex/foundation/prd-spec-review/SKILL.md -->

**Invocation:** `/prd-spec-review {slug}`

- Project: {{slot:projectName}}
- Inputs: `.ai-pilot/output/{slug}.prd.md`, `.ai-pilot/output/{slug}.backlog.json`,
  `context.md`, `.cursor/skills/to-prd/backlog-schema.json`, `.cursor/skills/to-prd/SKILL.md`
- Outputs: `.ai-pilot/output/{slug}-prd-review-scorecard.json` and `{slug}-prd-review-scorecard.md`
- Overall formula: `(prd_score × 0.50) + (backlog_score × 0.50)`

## APEX enums (use ONLY these)

- Persona: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`
- Target surface: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`
- Canonical terms: `Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`, `RBAC`, `SSE`, `Facilitator`

APEX is a product-building platform — NOT a timeclock, staffing, or healthcare app.

## Section rubrics and cross-cutting checks

See `rubric.md` for the full PRD-markdown section weights, backlog JSON section
weights, and cross-cutting check table. Score and output must follow `rubric.md`
and `scorecard-template.md` exactly.
