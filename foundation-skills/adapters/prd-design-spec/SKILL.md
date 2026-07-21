---
name: prd-design-spec
description: APEX adapter for prd-design-spec. Supplies APEX layer names, file paths, coding-standard references, and design artifact templates.
---

# prd-design-spec — APEX Adapter

<!-- Managed loader: loads .apex/foundation/prd-design-spec/SKILL.md -->

**Invocation:** `/prd-design-spec {slug}`

- Project: {{slot:projectName}}
- Inputs: `.ai-pilot/output/{slug}.prd.md`, `.ai-pilot/output/{slug}.backlog.json`, `context.md`, `AGENTS.md`
- Templates: `.cursor/skills/prd-design-spec/design-template.md`, `tech-spec-template.md`, `assumptions-template.md`
- Output dir: `.ai-pilot/output/{slug}-design-spec/`

## APEX layers and ownership

- Services: `src/server/services/`
- Routes: `src/server/routes/`
- Components: `src/client/components/`
- Shared types: `src/shared/types/`
- DB migrations: `migrations/`

## APEX coding-standard references

When a Feature touches the database: `.cursor/rules/postgresql-db.mdc`
When a Feature touches the frontend: `.cursor/rules/react-coding-standards.mdc`, `.cursor/rules/ui-design-standards.mdc`

## APEX enums

- Persona: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`
- Target surface: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`
- Canonical terms: Interview, PRD, Design Doc, Design Prototype, PBI, TBI, Feature Flag, Skill, Backlog, Epic, Feature, RBAC, SSE, Facilitator

APEX is a product-building platform, NOT a timeclock, staffing, or healthcare app.
