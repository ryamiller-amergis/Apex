---
name: ui-lab
description: APEX UI Lab generation. Loads the @apex/skills ui-lab foundation and applies APEX's own design system (tokens, components, and app modules). Use when generating or editing UI screens in the APEX UI Lab.
foundation: ui-lab
foundationVersion: ">=1.0.0"
---

# UI Lab — APEX Design System Adapter

This adapter extends the UI Lab foundation with APEX's own design system.

Load the foundation first:

```
Read: .apex/foundation/ui-lab/SKILL.md
```

Then apply the APEX-specific context below.

---

## APEX Design Tokens

Design tokens are loaded at runtime from `src/server/assets/apex-colors.md` via `designTokensService`.
The design token file is auto-generated from APEX's own CSS custom properties in `src/client/`.

For offline reference, key structural tokens:

| Token | Role |
|-------|------|
| `--color-primary` | Primary brand/interactive color |
| `--color-surface` | Page/panel background |
| `--color-text-primary` | Primary text |
| `--color-text-secondary` | Secondary/muted text |
| `--color-border` | Standard border color |
| `--color-error` | Error / destructive state |
| `--shadow-md` | Standard card/panel shadow |

Full token catalog: `src/server/assets/apex-colors.md`

---

## APEX Component Library

APEX is a React + Vite single-page application. Components live in `src/client/components/`.

UI generation should use APEX's existing components (e.g. cards, modals, tables, notifications, review sidebars) and CSS custom properties from the token catalog rather than MUI or other framework components.

Component patterns are documented in `src/client/components/` and `src/client/*.module.css` files.

---

## APEX App Modules and Routes

APEX's main feature areas (for UI Lab context):

| Module | Route | Description |
|--------|-------|-------------|
| Agent Home | `/home` | AI chat, quick skill pills, thread history |
| Interviews / Backlog | `/backlog` | Design interviews, PRDs, epics, features |
| Planning | `/planning` | Dev analytics, roadmap, release planning |
| Calendar | `/calendar` | Scrum calendar and sprint management |
| Cloud Cost | `/cloud-cost` | Azure cost analytics |
| AI Cost | `/ai-cost` | AI usage and cost analytics |
| Platform Admin | `/platform-admin` | Super-admin: access, feature flags, foundation skills |
| Project Admin | `/admin` | Per-project: roles, users, skill settings |
| Standup | `/standup` | Daily standup ceremony |
| UI Lab | (modal/overlay) | AI-powered UI prototype generation |
| Feature Requests | `/feature-requests` | Feature request triage and analysis |

---

## APEX-Specific UI Rules

- Use APEX CSS custom properties (`var(--token-name)`) for all colors, shadows, and borders.
- Never hardcode hex values — use tokens from `src/server/assets/apex-colors.md`.
- APEX does not use MUI, Bootstrap, Roboto, or any third-party component library.
- Spacing: use the scale from `src/client/**/*.module.css` patterns (4 / 8 / 12 / 16 / 24 / 32px).
- Dark mode is handled by a `[data-theme="dark"]` CSS selector.
- Responsive breakpoints follow APEX's own CSS media queries.
- All generated screens must satisfy the foundation's invariant contract: four UI states and WCAG AA accessibility.
