---
name: product-quality
description: Product craft and visual hierarchy standards for full-stack applications: centered AppShell layout geometry (<= 960px with alignSelf center), tailored domain sample data, accessible chart and notification ergonomics, AI-skill grounding over database and third-party feeds, and rendered verification.
---

# Product quality

Follow this skill alongside [ui-standards](../ui-standards/SKILL.md) whenever building or revising a user-facing screen or full-stack slice.

## When to use

Use this skill when adding or revising a screen, dashboard, chart, notification center, or AI-grounded workflow so the result reads as a finished product rather than a starter scaffold.

## Required references

Read these before editing. Stop if any path is missing.

- UI standards: [.cursor/skills/ui-standards/SKILL.md](../ui-standards/SKILL.md)
- Component catalog: [docs/component-catalog.md](../../../docs/component-catalog.md)
- Design system: [docs/design-system.md](../../../docs/design-system.md)
- Brand overrides: `apps/web/src/theme/overrides.ts`
- Application shell: `packages/ui/src/shell/AppShell.tsx`

## Rules

| ID     | Rule                                                                                                                                                                                                                    | Enforced by   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| PQ-R01 | Keep the `AppShell` main content area centered at desktop widths (`maxWidth <= 960` px and `alignSelf: 'center'` on the flex child) so pages do not hug the left edge beside the navigation drawer.                     | component     |
| PQ-R02 | Establish clear visual hierarchy on every landing and feature screen: `PageHeader` with title and primary action, a KPI `StatGrid` or summary surface, and structured detail cards (`ContentSurface` or `DetailPanel`). | component     |
| PQ-R03 | Seed realistic domain sample data for the requested industry (named stations, realistic metrics, concrete workflow notifications). Never ship `Item 1`, `Todo 1`, `project-name`, `My App`, or lorem ipsum.             | unit          |
| PQ-R04 | Use `DataChartCard` for metrics and trends with accessible SVG titles/labels, timeframe filters, and theme tokens (`theme.vars.palette.*`). Never write hard-coded hex colours inside components.                       | lint          |
| PQ-R05 | Use `NotificationCenter` and `NotificationList` for in-app alerts with an unread count badge, category filter buttons, mark-as-read actions, and loading/empty/error states.                                            | component     |
| PQ-R06 | Ground AI skill insights (`POST /api/v1/insights/analyze`) in both database records and configurable third-party connector feeds, returning structured findings, explicit source citations, and recommended actions.    | api           |
| PQ-R07 | Verify rendered layout geometry and interactive states at both phone (`375px`) and desktop (`1280px`) widths with zero console, page, or 5xx errors.                                                                    | accessibility |

## Review checklist

| Item                                                                                                                     | Evidence source                           | Met? (yes, no, not applicable) |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------ |
| `AppShell` main container is capped (`<= 960px`) and centered (`alignSelf: 'center'`) on desktop widths.                 | `AppShell.tsx` and component/browser test |                                |
| Brand identity in `apps/web/src/theme/overrides.ts` has a domain-appropriate name, tagline, and WCAG AA token overrides. | `overrides.test.ts`                       |                                |
| Seeded data uses realistic domain terminology and never uses `Item 1` or `Todo 1`.                                       | Feature fixtures and component tests      |                                |
| Charts (`DataChartCard`) and notifications (`NotificationCenter`) use theme tokens and support interactive filtering.    | `pnpm lint` and component tests           |                                |
| AI insights (`InsightsPage`) cite both database records and connector feed items and provide recommended actions.        | API and component tests                   |                                |

## Stop conditions

- A required reference path does not exist.
- A proposed colour override fails `checkThemeContrast`.
