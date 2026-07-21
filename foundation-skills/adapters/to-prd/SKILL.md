---
name: to-prd
description: APEX adapter for to-prd. Binds the generic PRD synthesis workflow to APEX's file paths, templates, persona enums, and backlog schema.
---

# to-prd — APEX Adapter

<!-- Managed loader: loads .apex/foundation/to-prd/SKILL.md -->

**Invocation:** `/to-prd`

- Project: {{slot:projectName}}
- Input: `.ai-pilot/kickoff-transcript.md` (sole requirements input — treat as authoritative)
- Reference: `context.md`, `AGENTS.md`, `.cursor/skills/to-prd/backlog-schema.json`, `.cursor/skills/to-prd/SKILL.md`
- PRD template: `.cursor/skills/to-prd/prd-template.md`
- Backlog example: `.cursor/skills/to-prd/backlog-example.json`
- Output: `.ai-pilot/output/{kebab-slug}.prd.md` and `.ai-pilot/output/{kebab-slug}.backlog.json`

## APEX enums

- Persona: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`
- Persona type: `"Internal"`, `"Admin"`, `"Technical"` (exact values only)
- Priority: `"Must Have"`, `"Should Have"`, `"Could Have"`, `"Won't Have"`
- Target surface: `Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`

## Terminology

Use Apex terms consistently: Interview, PRD, Design Doc, Design Prototype, PBI, TBI,
Feature Flag, Skill, Backlog, Epic, Feature, RBAC, SSE, Facilitator.

## Backlog constraints

- `acceptanceCriteria` must include all four scenarios: (a) happy path, (b) error/failure, (c) edge case, (d) negative
- `schema additionalProperties: false` — include only schema-defined properties
- Dependency-locality: item-level `dependsOn` must reference only items within the same Feature
- `implementationPhases` express epic execution order (foundational epics first)
