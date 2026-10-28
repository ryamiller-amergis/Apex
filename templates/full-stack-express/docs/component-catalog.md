# Component catalog

Every public export of `@project-scope/ui`, grouped by purpose. The entry file is `packages/ui/src/index.ts`. Import from the package name only. The [design-system reference](design-system.md) explains the tokens and themes these components read, and the [UI package guide](../packages/ui/README.md) has longer examples.

## Layout

| Export          | Kind      | Source                                | Use it to                                                                                                                                                                                      |
| --------------- | --------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppShell`      | Component | `packages/ui/src/shell/AppShell.tsx`  | Frame every route: skip link, header with the app name and "Dark mode" switch, primary navigation, and the `main` landmark. Props: `appName`, `navItems`, optional `headerActions`, `children` |
| `AppShellProps` | Type      | `packages/ui/src/shell/AppShell.tsx`  | Props of `AppShell`                                                                                                                                                                            |
| `NavItem`       | Type      | `packages/ui/src/shell/NavDrawer.tsx` | One navigation entry: a unique, stable `id`, a `label`, and a `to` path. A duplicate `id` throws                                                                                               |

## Request states

| Export                  | Kind      | Source                                        | Use it to                                                                                                                                           |
| ----------------------- | --------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoadingState`          | Component | `packages/ui/src/states/LoadingState.tsx`     | Replace a blank area while data loads. Props: `label` (default `Loading`), `variant` (`page` or `inline`), `testId`. Uses `role="status"`           |
| `LoadingStateProps`     | Type      | `packages/ui/src/states/LoadingState.tsx`     | Props of `LoadingState`                                                                                                                             |
| `EmptyState`            | Component | `packages/ui/src/states/EmptyState.tsx`       | Show that no content exists. Props: `title`, optional `description` and `action`. Uses `role="status"`                                              |
| `EmptyStateProps`       | Type      | `packages/ui/src/states/EmptyState.tsx`       | Props of `EmptyState`                                                                                                                               |
| `EmptyStateAction`      | Type      | `packages/ui/src/states/EmptyState.tsx`       | The optional action: `label` and `onClick`                                                                                                          |
| `ErrorState`            | Component | `packages/ui/src/states/ErrorState.tsx`       | Show a safe message with an optional retry button. Props: `title`, `message`, `onRetry`, `retryLabel`, `testId`, `retryTestId`. Uses `role="alert"` |
| `ErrorStateProps`       | Type      | `packages/ui/src/states/ErrorState.tsx`       | Props of `ErrorState`                                                                                                                               |
| `AppErrorBoundary`      | Component | `packages/ui/src/states/AppErrorBoundary.tsx` | Catch render errors and show `ErrorState` with a retry button. Props: `children`, `onError`, `resetKeys`. Never renders the thrown message          |
| `AppErrorBoundaryProps` | Type      | `packages/ui/src/states/AppErrorBoundary.tsx` | Props of `AppErrorBoundary`                                                                                                                         |
| `APP_ERROR_MESSAGE`     | Constant  | `packages/ui/src/states/AppErrorBoundary.tsx` | The fixed text the boundary shows                                                                                                                   |

Pass fixed strings to `ErrorState`. Never pass an `Error` message, a stack trace, or a Problem Details `detail` field.

## Theme-styled MUI primitives

Screens may use MUI components that take their colour, type, and spacing from the theme. The profile form uses `Button`, `TextField`, `Alert`, and `Box` from `@mui/material`. Those components are not exports of `@project-scope/ui`. Import them from `@mui/material`.

A shared pattern this catalog does not list, such as a new shell or a new state, is proposed as a catalog addition. A component that sets its own colour or spacing is a one-off styled component. Do not add one.

## Theme and colour mode

| Export                   | Kind      | Source                                       | Use it to                                                                         |
| ------------------------ | --------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| `AppThemeProvider`       | Component | `packages/ui/src/theme/AppThemeProvider.tsx` | Wrap the app once. Applies both schemes and baseline styles. Optional `overrides` |
| `AppThemeProviderProps`  | Type      | `packages/ui/src/theme/AppThemeProvider.tsx` | Props of `AppThemeProvider`                                                       |
| `COLOR_MODE_STORAGE_KEY` | Constant  | `packages/ui/src/theme/AppThemeProvider.tsx` | The `localStorage` key for the chosen mode, `app-color-mode`                      |
| `useColorMode`           | Hook      | `packages/ui/src/theme/useColorMode.ts`      | Read `mode` and call `setMode`                                                    |
| `ColorMode`              | Type      | `packages/ui/src/theme/useColorMode.ts`      | `'light'` or `'dark'`                                                             |
| `UseColorModeResult`     | Type      | `packages/ui/src/theme/useColorMode.ts`      | Return value of `useColorMode`                                                    |
| `createAppTheme`         | Function  | `packages/ui/src/theme/createAppTheme.ts`    | Build the MUI theme from tokens and overrides outside the provider                |

## Tokens

| Export               | Kind     | Source                                  | Use it to                                                           |
| -------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------- |
| `tokens`             | Constant | `packages/ui/src/tokens/index.ts`       | Read the default colour, spacing, typography, and breakpoint tokens |
| `mergeTokens`        | Function | `packages/ui/src/tokens/index.ts`       | Get the tokens with `TokenOverrides` applied                        |
| `Tokens`             | Type     | `packages/ui/src/tokens/index.ts`       | Shape of `tokens`                                                   |
| `TokenOverrides`     | Type     | `packages/ui/src/tokens/index.ts`       | Brand overrides for colours per scheme and typography               |
| `DeepPartial`        | Type     | `packages/ui/src/tokens/index.ts`       | Helper type used by `TokenOverrides`                                |
| `ColorSchemeName`    | Type     | `packages/ui/src/tokens/colors.ts`      | `'light'` or `'dark'`                                               |
| `ColorSchemeTokens`  | Type     | `packages/ui/src/tokens/colors.ts`      | Semantic colours of one scheme                                      |
| `PaletteColorTokens` | Type     | `packages/ui/src/tokens/colors.ts`      | A `main` colour and its `contrastText`                              |
| `SpacingTokens`      | Type     | `packages/ui/src/tokens/spacing.ts`     | Spacing base and named steps                                        |
| `TypographyTokens`   | Type     | `packages/ui/src/tokens/typography.ts`  | Font stack, sizes, weights, and type scale                          |
| `BreakpointTokens`   | Type     | `packages/ui/src/tokens/breakpoints.ts` | Breakpoint widths in px                                             |

## Contrast

| Export                  | Kind     | Source                              | Use it to                                               |
| ----------------------- | -------- | ----------------------------------- | ------------------------------------------------------- |
| `checkThemeContrast`    | Function | `packages/ui/src/theme/contrast.ts` | Check every required pairing in both schemes            |
| `CONTRAST_PAIRINGS`     | Constant | `packages/ui/src/theme/contrast.ts` | The pairings and the minimum ratio each must reach      |
| `formatContrastFailure` | Function | `packages/ui/src/theme/contrast.ts` | Print one failure as a line                             |
| `ContrastPairing`       | Type     | `packages/ui/src/theme/contrast.ts` | One pairing                                             |
| `ContrastFailure`       | Type     | `packages/ui/src/theme/contrast.ts` | One failed pairing with its measured ratio              |
| `ColorTokenPath`        | Type     | `packages/ui/src/theme/contrast.ts` | A dotted path to a colour token, such as `text.primary` |

## Test ids

| Export            | Kind     | Source                              | Use it to                                                                              |
| ----------------- | -------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `testId`          | Function | `packages/ui/src/testing/testId.ts` | Build a `data-testid` from a scope and parts. Throws when the result is not kebab-case |
| `TEST_ID_PATTERN` | Constant | `packages/ui/src/testing/testId.ts` | The kebab-case pattern every test id matches                                           |

Test ids follow `{scope}-{element}[-{qualifier}]`. Build dynamic ids from stable values, never array indexes or display text. The shared components render these ids:

| `data-testid`                 | Element                                     |
| ----------------------------- | ------------------------------------------- |
| `app-shell`                   | Shell root                                  |
| `app-shell-header`            | Header (`banner` landmark)                  |
| `app-shell-skip-link`         | "Skip to main content" link                 |
| `app-shell-menu-button`       | "Open navigation" button, phone and tablet  |
| `app-shell-close-button`      | "Close navigation" button inside the drawer |
| `app-shell-nav`               | Navigation list                             |
| `app-shell-nav-item-{id}`     | One navigation link per item                |
| `app-shell-color-mode-toggle` | "Dark mode" switch input                    |
| `app-shell-main`              | `main` landmark                             |
| `loading-state`               | `LoadingState`                              |
| `empty-state`                 | `EmptyState`                                |
| `empty-state-action`          | `EmptyState` action button                  |
| `error-state`                 | `ErrorState`                                |
| `error-state-retry`           | `ErrorState` retry button                   |

## Pull request checklist

- [ ] When `packages/ui/src/index.ts` gains, renames, or drops an export, this catalog lists every export it now has, and the [design-system reference](design-system.md) still matches the tokens.
