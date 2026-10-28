---
name: ui-standards
description: Rules for building or changing a screen so it uses theme tokens, catalog components, required states, accessible forms, the shared query client, and stable test ids. Use when adding a screen, changing layout or forms, or reviewing a screen against the checklist.
---

# UI standards

Follow this skill before building or changing a screen. The profile screen is the worked example. Do not invent a one-off pattern when the catalog already has one.

## When to use

Use this skill when a task adds or changes a screen, a form, or how a screen loads data. When the screen needs a new endpoint, follow the API contract skill first, then return here.

## Required references

Read these before editing. Stop if any path is missing.

- Design system: [docs/design-system.md](../../../docs/design-system.md)
- Component catalog: [docs/component-catalog.md](../../../docs/component-catalog.md)
- UI package guide, including the selector convention: [packages/ui/README.md](../../../packages/ui/README.md)
- Tokens: `packages/ui/src/tokens/` and `packages/ui/src/theme/createAppTheme.ts`
- Test ids: `packages/ui/src/testing/testId.ts`
- State components: `packages/ui/src/states/LoadingState.tsx`, `packages/ui/src/states/EmptyState.tsx`, and `packages/ui/src/states/ErrorState.tsx`
- Profile screen: `apps/web/src/features/profile/ProfileForm.tsx`, `apps/web/src/features/profile/useProfileQuery.ts`, `apps/web/src/features/profile/useUpdateProfileMutation.ts`, `apps/web/src/features/profile/profileKeys.ts`, and `apps/web/src/features/profile/profileTestIds.ts`
- Query client: `apps/web/src/app/queryClient.ts`
- API client: `apps/web/src/api/apiClient.ts`
- Colour lint rule: `packages/config/eslint/no-hardcoded-color.mjs`
- Branding overrides: `apps/web/src/theme/overrides.ts`

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                          | Enforced by   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| UI-R01 | Take colour from MUI theme tokens such as `theme.vars.palette.primary.main`. Take spacing from `theme.spacing` and type from the typography tokens. Never hard-code a colour or size in a component. The `design-tokens/no-hardcoded-color` lint rule reports hex, `rgb()`, `rgba()`, `hsl()`, and `hsla()` in `apps/web/src/` and `packages/ui/src/`. Named colours such as red are not detected; review catches those and hard-coded sizes. | lint          |
| UI-R02 | Build screens from the UI package and the component catalog. If the catalog lacks a component, propose a catalog addition. Do not create a one-off styled component. A component outside the catalog is flagged for catalog addition or replacement.                                                                                                                                                                                          | Review        |
| UI-R03 | Rebrand by overriding tokens in `apps/web/src/theme/overrides.ts` only. An override must keep WCAG 2.1 AA contrast. `checkThemeContrast` checks both schemes.                                                                                                                                                                                                                                                                                 | unit          |
| UI-R04 | Lay out for phone (below 600 px), tablet (600 px up to 900 px), and desktop (900 px and up) with `AppShell` and the theme breakpoints in `packages/ui/src/tokens/breakpoints.ts`. No horizontal scrolling at the narrowest width. Confirm layout at both the narrowest and the widest widths in review.                                                                                                                                       | component     |
| UI-R05 | A screen that loads data renders loading, empty, error, and loaded states from `LoadingState`, `EmptyState`, and `ErrorState`. The error state offers retry and shows no technical detail. Skipping the empty state or the error state is a failure.                                                                                                                                                                                          | component     |
| UI-R06 | Meet WCAG 2.1 AA: semantic landmarks and headings, a visible label on every control, keyboard operation with visible focus, and state changes announced to assistive technology. `LoadingState` and `EmptyState` use `role="status"`. `ErrorState` uses `role="alert"`. An unlabeled field fails the accessibility check and the output names the field.                                                                                      | accessibility |
| UI-R07 | Build forms with React Hook Form and the shared Zod schema from the contracts package, as `ProfileForm` does with `zodResolver` and `updateProfileBodySchema`. Show field errors on their fields, move focus to the first invalid field (`shouldFocusError`), send no request while invalid, and keep entered values after a failed save.                                                                                                     | component     |
| UI-R08 | Send only the fields the contract defines. Never display or send another person's identifier. The profile form sends `displayName` and `email` only.                                                                                                                                                                                                                                                                                          | api           |
| UI-R09 | Read server data through `createAppQueryClient` and the typed API client. `useProfileQuery` calls `useQuery` with `profileKeys.me`. Never fetch inside an effect. After a mutation, invalidate the queries it affects, as `useUpdateProfileMutation` does with `profileKeys.me`. The screen shows the saved value without a reload.                                                                                                           | component     |
| UI-R10 | Show Problem Details failures through the API client's single error path (`ApiError`). The screen shows a message and never the raw body, a stack trace, or a Problem Details `detail` field.                                                                                                                                                                                                                                                 | unit          |
| UI-R11 | Select elements in tests with the UI package convention. Query by role and accessible name first, then by `data-testid`. Build ids with `testId(scope, ...parts)` so they match `TEST_ID_PATTERN`: lower-case kebab-case `{scope}-{element}[-{qualifier}]`. Use stable ids, never array indexes or display text. The profile screen's ids live in `profileTestIds`.                                                                           | component     |
| UI-R12 | Use the documented colour-mode mechanism. `AppThemeProvider` follows the operating system on the first visit. `useColorMode` reads and sets the mode and stores it under `COLOR_MODE_STORAGE_KEY`. Do not branch on the active theme inside a component.                                                                                                                                                                                      | Review        |

## Adding a screen

1. Read Required references. Stop if any path is missing.
2. List the catalog components and tokens the screen reuses. If one is missing, propose a catalog addition and stop that element.
3. Define the screen's data needs. Use an existing route definition, or add one with the API contract skill first.
4. Fetch through the typed API client and `createAppQueryClient`. Invalidate affected queries after each mutation. Do not fetch inside an effect.
5. Build loading, empty, error, and loaded states with `LoadingState`, `EmptyState`, and `ErrorState`.
6. Build forms from the shared Zod schema with React Hook Form, following `apps/web/src/features/profile/ProfileForm.tsx`.
7. Add selectors to interactive and key content elements with `testId`. Follow `apps/web/src/features/profile/profileTestIds.ts`.
8. Add a component test for each state. Run the accessibility check on each state.
9. Run `pnpm test:component` and `pnpm test:a11y`, then complete the review checklist with evidence for each item.

## Review checklist

A UI reviewer marks every item yes, no, or not applicable. A no is a failure. Evidence is the design-system reference, the component catalog, a component test, or an accessibility result. A skipped empty state or error state is a failure, not a warning.

| Item                                                                                                                                           | Evidence source                                           | Met? (yes, no, not applicable) |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| Colour, spacing, and type come from theme tokens. A hard-coded colour or size is a violation of UI-R01.                                        | `pnpm lint` and the design-system reference               |                                |
| Every component is in the catalog. A component outside the catalog is flagged for catalog addition or replacement.                             | Component catalog                                         |                                |
| Loading, empty, error, and loaded states exist. A missing empty or error state is a failure.                                                   | Component tests, one per state                            |                                |
| Confirm layout at the narrowest supported width (below 600 px) and the widest (1536 px).                                                       | Review at both widths                                     |                                |
| Confirm focus order at the narrowest supported width (below 600 px) and the widest (1536 px).                                                  | Review at both widths, keyboard only                      |                                |
| Keyboard operation works and focus is visible.                                                                                                 | Accessibility result                                      |                                |
| Every control has a visible label. An unlabeled field is a failure and the accessibility output names the field.                               | `pnpm test:a11y`                                          |                                |
| Text contrast and non-text contrast meet WCAG 2.1 AA in both colour schemes.                                                                   | `pnpm test:unit` (`checkThemeContrast`)                   |                                |
| Loading and empty states announce with status, and the error state announces with alert. The error offers retry and hides technical detail.    | Component tests and the accessibility result              |                                |
| The form uses the shared Zod schema, shows field errors, moves focus to the first invalid field, and keeps entered values after a failed save. | `ProfileForm` and its component test                      |                                |
| The screen reads through the shared query client and invalidates affected queries after a change. No fetch runs inside an effect.              | `useProfileQuery`, `useUpdateProfileMutation`, and a test |                                |
| Interactive and key content elements use `testId` values that match `TEST_ID_PATTERN`.                                                         | Component test                                            |                                |

## Stop conditions

Stop and report the missing piece. Do not guess.

- A required reference path or command does not exist.
- The catalog has no component for an element. Propose a catalog addition instead of styling a one-off.
- The screen needs a route the contracts package does not define. Use the API contract skill first.
- The task asks for brand-specific styling that is not a token override.
- The task asks for a new visual component design or for automated visual regression.
- The task asks to send or display an identifier the contract does not define.
