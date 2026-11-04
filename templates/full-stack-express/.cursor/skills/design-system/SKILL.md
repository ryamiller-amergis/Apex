---
name: design-system
description: Design system reference for this React + MUI + Express monorepo (@project-scope/ui). Read before building or changing any screen, component, or style.
---

# Design System (`@project-scope/ui`)

Always read this skill alongside `.cursor/skills/ui-standards/SKILL.md`, `docs/design-system.md`, and `docs/component-catalog.md` before building or changing any screen or component.

## Component Library (`@project-scope/ui` & `@mui/material`)

- Import shared layout, request-state components, tokens, and `testId` from `@project-scope/ui` (`packages/ui/src/index.ts`):
  - **Layout**: `AppShell` (`appName`, `navItems`, `headerActions`, `children`), `NavItem` (`id`, `label`, `to`, optional MUI `icon`), `PageHeader`, `ContentSurface`.
  - **Request states**:
    - `LoadingState` (`label`, `variant`: `'page' | 'inline'`, `testId`) — announces with `role="status"`.
    - `EmptyState` (`title`, `description`, `action`: `{ label, onClick }`) — announces with `role="status"`.
    - `ErrorState` (`title`, `message`, `onRetry`, `retryLabel`, `testId`, `retryTestId`) — announces with `role="alert"`. Always pass fixed, safe strings; never pass raw `Error.message` or Problem Details `detail`.
    - `AppErrorBoundary` (`children`, `onError`, `resetKeys`).
  - **Theme & colour mode**: `AppThemeProvider`, `useColorMode`, `createAppTheme`, `COLOR_MODE_STORAGE_KEY`.
  - **Test IDs**: `testId(scope, ...parts)` and `TEST_ID_PATTERN` (`{scope}-{element}[-{qualifier}]`).
- Use theme-styled `@mui/material` primitives (`Button`, `TextField`, `Alert`, `Box`, `Stack`, `Typography`, `Paper`, `Container`) for form controls and layout. Prefer `@mui/icons-material` for navigation and actions when it improves scanability. Use `@mui/x-date-pickers` with `dayjs` for calendar or date-range inputs instead of hand-rolling grids. Do not add a second component library or create one-off styled components with hard-coded colours or spacing.

## Tokens (`packages/ui/src/tokens/`)

All colours, spacing, typography, and breakpoints come from the MUI theme (`createAppTheme` in `packages/ui/src/theme/createAppTheme.ts`). Never hard-code hex, `rgb()`, `rgba()`, `hsl()`, `hsla()`, or named colours in `apps/web/src/` or `packages/ui/src/` (enforced by the `design-tokens/no-hardcoded-color` ESLint rule).

| Token group | Theme path / helper | Values |
|-------------|---------------------|--------|
| Primary / Secondary / Status | `theme.vars.palette.primary.main`, `secondary.main`, `error.main`, `warning.main`, `info.main`, `success.main` (plus `.contrastText`) | Light & dark CSS variables from `packages/ui/src/tokens/colors.ts` |
| Text | `theme.vars.palette.text.primary`, `theme.vars.palette.text.secondary` | WCAG 2.1 AA contrast (>= 4.5:1) |
| Surfaces & borders | `theme.vars.palette.background.default`, `background.paper`, `divider` | Semantic surface tokens |
| Spacing | `theme.spacing(n)` (base unit `8px`) | `xxs` (4px), `xs` (8px), `sm` (12px), `md` (16px), `lg` (24px), `xl` (32px) |
| Typography | `typography.h1`–`h6`, `body1`, `body2`, `caption` | System font stack (`14px` body on `16px` root; weights 400, 500, 600) |
| Breakpoints | `theme.breakpoints` (`xs`: 0, `sm`: 600, `md`: 900, `lg`: 1200, `xl`: 1536) | Phone `< 600px`, tablet `600–899px`, desktop `>= 900px` |

Brand token overrides belong only in `apps/web/src/theme/overrides.ts` (`TokenOverrides`) and must pass `checkThemeContrast`.

## Page Layout & Navigation

- `AppShell` frames every route with a skip link (`app-shell-skip-link`), header (`app-shell-header`), responsive navigation drawer (`app-shell-nav`), and `main` landmark (`app-shell-main`).
- Register every new screen as:
  1. A lazy route in `apps/web/src/app/routes.tsx`.
  2. A `NavItem` in `navItems` in `apps/web/src/app/App.tsx`.
- Every screen that loads data must render all four states: `LoadingState`, `EmptyState`, `ErrorState` (with retry), and the loaded state.

## Forms & Accessibility Baseline (WCAG 2.1 AA)

- Build forms with `react-hook-form` (`shouldFocusError: true`) and `zodResolver` using the shared Zod schema from `@project-scope/contracts` (see `apps/web/src/features/profile/ProfileForm.tsx`).
- Every form control must have a visible `label`, keyboard operation with visible focus, field-level validation errors, and preserved input values when a save fails.
- Query elements in tests by accessible role and name first, then by `data-testid` built with `testId(scope, ...parts)`.
