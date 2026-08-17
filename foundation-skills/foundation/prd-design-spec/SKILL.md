---
name: prd-design-spec
description: Reads to-prd output (.prd.md + .backlog.json), surfaces unresolved questions, then synthesizes three design artifact files per Feature in the backlog. Use when the user says /prd-design-spec {slug} or wants architecture and design decisions documented before implementation.
---

# PRD Design Spec — Foundation

Reads `to-prd` output and produces three design artifact files per Feature: design doc, technical spec, and shared assumptions.

## Linked context pre-read

If `.ai-pilot/linked-context.md` is present in the workspace, read it before proceeding. Treat its provenance-labeled sections as authoritative project grounding. If it is absent, proceed normally.

## Inputs

1. Read `.ai-pilot/output/{slug}.prd.md`
2. Read `.ai-pilot/output/{slug}.backlog.json`
3. Load the project adapter for project-specific architecture patterns, tech stack, and design templates

## Unresolved questions phase

Before generating artifacts, surface any ambiguities or gaps. For each open question, ask the user one at a time. Do not generate artifacts until all blocking questions are resolved.

## Output per Feature

For each Feature in the backlog, produce:

1. `.ai-pilot/output/{slug}-design-spec/{feature-slug}-design.md` — design document
2. `.ai-pilot/output/{slug}-design-spec/{feature-slug}-tech-spec.md` — technical specification  
3. `.ai-pilot/output/{slug}-design-spec/{feature-slug}-assumptions.md` — shared assumptions

### Design document (`-design.md`)

Use the project's `design-template.md`. Must include:
- Feature purpose and user impact
- UX/UI decisions (screens, flows, edge cases)
- Component and data ownership
- Integration points

### Technical specification (`-tech-spec.md`)

Use the project's `tech-spec-template.md`. Must include:
- Backend API changes (endpoints, data models)
- Database changes (new tables, columns, indexes)
- Frontend changes (components, hooks, routing)
- Security and authorization
- Testing strategy per layer

### Shared assumptions (`-assumptions.md`)

Use the project's `assumptions-template.md`. Must include:
- What is assumed to be true about the system state
- What is assumed about user behavior
- What is explicitly out of scope
- Risks if assumptions prove wrong

## Quality gates

- [ ] Every Feature in the backlog has all three artifact files
- [ ] Every artifact references real project file paths (no invented paths)
- [ ] Technical spec includes at least one test strategy section
- [ ] Assumptions are testable/verifiable, not vague
