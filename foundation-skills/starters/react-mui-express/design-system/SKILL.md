---
name: design-system
description: Design system for this React + MUI + Express app. Read before building or changing any screen, component or style.
---

# Design system

Copy this file to `.cursor/skills/design-system/SKILL.md` in the target repository, then replace every `TODO` with the app's own values.

## Component library — MUI

- Build every screen from MUI (`@mui/material`) components. Do not add a second component library.
- Wrap the app once in `ThemeProvider` with the theme from `src/client/theme.ts` and include `CssBaseline`.
- Style with the `sx` prop or `styled()` using theme values. Do not write inline hex colours or pixel font sizes.
- Forms use MUI inputs with `react-hook-form`; every field has a visible `label`.

## Tokens

All colours, spacing, radii and type come from the MUI theme. Change the theme, not the component.

| Token | Theme path | Value |
|-------|-----------|-------|
| Primary | `palette.primary.main` | TODO |
| Secondary | `palette.secondary.main` | TODO |
| Error | `palette.error.main` | TODO |
| Background | `palette.background.default` | TODO |
| Surface | `palette.background.paper` | TODO |
| Text | `palette.text.primary` | TODO |
| Spacing unit | `spacing(1)` | 8px |
| Corner radius | `shape.borderRadius` | TODO |
| Font family | `typography.fontFamily` | TODO |

Use `theme.spacing(n)` for every gap and padding. Use the `typography` variants (`h1`–`h6`, `body1`, `body2`, `caption`) for text.

## Icon set

- Use `@mui/icons-material` only, in the Outlined style.
- An icon that acts alone (an icon button) has an `aria-label`. A decorative icon has `aria-hidden`.

## Page layout

- Every page renders inside the shared `AppLayout`: a top `AppBar`, an optional left navigation `Drawer`, and a `main` region.
- Page content sits in a `Container maxWidth="lg"` with a page title (`Typography variant="h4" component="h1"`) first.
- Lists of records use a table or data grid with a toolbar above it for search and primary actions.
- Each page shows a loading state, an empty state and an error state; never a blank screen.

## Accessibility baseline

- Meet WCAG 2.2 AA. Text contrast is at least 4.5:1, and 3:1 for large text and controls.
- Every control is reachable and usable by keyboard, with a visible focus ring.
- Form errors use `helperText` tied to the field and are announced (`role="alert"` on a summary).
- Never show status by colour alone; pair it with text or an icon with a label.
- Dialogs trap focus and return it to the control that opened them.
