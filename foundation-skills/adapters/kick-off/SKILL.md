---
name: kick-off
description: APEX adapter for kick-off. Supplies APEX layer names, model preference, design doc template path, and coding standards.
---

# kick-off — APEX Adapter

<!-- Managed loader: loads .apex/foundation/kick-off/SKILL.md -->
Use model `claude-4.6-opus-high-thinking` for all reasoning.
Switch to plan mode before Phase 3.

- Project: {{slot:projectName}}
- Design doc template: `.cursor/skills/kick-off/design-doc-template.md`
- Context: `context.md`, `AGENTS.md`

## APEX layers

- Services: `src/server/services/`
- Routes: `src/server/routes/`
- Components: `src/client/components/`
- Shared types: `src/shared/types/`
- DB migrations: `migrations/`

## Coding standards

`.cursor/rules/react-coding-standards.mdc`, `.cursor/rules/ui-design-standards.mdc`,
`.cursor/rules/postgresql-db.mdc`

## Stack signals

{{slot:stack}}
