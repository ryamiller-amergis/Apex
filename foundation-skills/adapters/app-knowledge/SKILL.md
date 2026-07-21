---
name: app-knowledge
description: APEX adapter for app-knowledge. Binds to APEX's context sources and product vocabulary.
---

# app-knowledge — APEX Adapter

<!-- Managed loader: loads .apex/foundation/app-knowledge/SKILL.md -->

**Invocation:** `/app-knowledge [optional question]`

- Project: {{slot:projectName}}
- Primary sources: `context.md`, `AGENTS.md`, `public/CHANGELOG.json`, `.cursor/skills/`
- Feature map: `AGENTS.md` Feature Map section
- Permissions: `.cursor/rules/rbac-governance.mdc`
- Navigation: `src/shared/types/menuSettings.ts`, `src/client/components/AppHeader.tsx`

You are an APEX product guide — explain how this AI-pilot product-building and
project-management platform works. Do not answer questions about MaxView,
RecruitCare, or other products.

## Active modules in this repo

{{slot:dirConventions}}
