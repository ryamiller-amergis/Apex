# Component catalog

Every public export of `@project-scope/ui`, grouped by purpose. The entry file is `packages/ui/src/index.ts`. Import from the package name only. The [design-system reference](design-system.md) explains the tokens and themes these components read, and the [UI package guide](../packages/ui/README.md) has longer examples.

## Layout

| Export                     | Kind      | Source                                           | Use it to                                                                                                                                                                                                                                 |
| -------------------------- | --------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppShell`                 | Component | `packages/ui/src/shell/AppShell.tsx`             | Frame every route: skip link, header with the app name, optional `logo`, `subtitle`, `brandBadge`, and "Dark mode" switch, primary navigation, and the centered `main` landmark (`maxWidth` defaults to `960` with `alignSelf: 'center'`) |
| `DEFAULT_MAIN_MAX_WIDTH`   | Constant  | `packages/ui/src/shell/AppShell.tsx`             | Default desktop maximum width (`960`) for `AppShell` main content                                                                                                                                                                         |
| `AppShellProps`            | Type      | `packages/ui/src/shell/AppShell.tsx`             | Props of `AppShell`                                                                                                                                                                                                                       |
| `NavItem`                  | Type      | `packages/ui/src/shell/NavDrawer.tsx`            | One navigation entry: a unique, stable `id`, a `label`, a `to` path, and optional MUI `icon` for the drawer. A duplicate `id` throws                                                                                                      |
| `PageHeader`               | Component | `packages/ui/src/layout/PageHeader.tsx`          | Title, optional subtitle, and right-aligned actions for a route body                                                                                                                                                                      |
| `PageHeaderProps`          | Type      | `packages/ui/src/layout/PageHeader.tsx`          | Props of `PageHeader`                                                                                                                                                                                                                     |
| `ContentSurface`           | Component | `packages/ui/src/layout/ContentSurface.tsx`      | Padded card-like surface for page content using theme tokens                                                                                                                                                                              |
| `ContentSurfaceProps`      | Type      | `packages/ui/src/layout/ContentSurface.tsx`      | Props of `ContentSurface`                                                                                                                                                                                                                 |
| `FilteredListSurface`      | Component | `packages/ui/src/layout/FilteredListSurface.tsx` | Toolbar with filter buttons on the left and search/actions on the right above a list surface                                                                                                                                              |
| `FilteredListSurfaceProps` | Type      | `packages/ui/src/layout/FilteredListSurface.tsx` | Props of `FilteredListSurface`                                                                                                                                                                                                            |
| `FilteredListFilterOption` | Type      | `packages/ui/src/layout/FilteredListSurface.tsx` | One filter option (`id` and `label`) for `FilteredListSurface`                                                                                                                                                                            |
| `DetailPanel`              | Component | `packages/ui/src/layout/FilteredListSurface.tsx` | Inline card surface for inspecting a selected record with optional close and action buttons                                                                                                                                               |
| `DetailPanelProps`         | Type      | `packages/ui/src/layout/FilteredListSurface.tsx` | Props of `DetailPanel`                                                                                                                                                                                                                    |
| `DetailDrawer`             | Component | `packages/ui/src/layout/FilteredListSurface.tsx` | Slide-over right drawer for record details or secondary forms                                                                                                                                                                             |
| `DetailDrawerProps`        | Type      | `packages/ui/src/layout/FilteredListSurface.tsx` | Props of `DetailDrawer`                                                                                                                                                                                                                   |

## Data display, charts, and notifications

| Export                    | Kind      | Source                                        | Use it to                                                                                                                              |
| ------------------------- | --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `MetricCard`              | Component | `packages/ui/src/data/MetricCard.tsx`         | Display a single KPI metric with label, value, optional delta chip, trend direction, and helper text                                   |
| `MetricCardProps`         | Type      | `packages/ui/src/data/MetricCard.tsx`         | Props of `MetricCard`                                                                                                                  |
| `MetricTrendDirection`    | Type      | `packages/ui/src/data/MetricCard.tsx`         | `'up'`, `'down'`, or `'neutral'`                                                                                                       |
| `StatGrid`                | Component | `packages/ui/src/data/MetricCard.tsx`         | Responsive 1/2/3-column grid of `MetricCard` items                                                                                     |
| `StatGridProps`           | Type      | `packages/ui/src/data/MetricCard.tsx`         | Props of `StatGrid`                                                                                                                    |
| `DataChartCard`           | Component | `packages/ui/src/data/DataChartCard.tsx`      | Accessible SVG bar or line chart card using theme tokens (`theme.vars.palette.*`), optional timeframe filter buttons, and summary list |
| `DataChartCardProps`      | Type      | `packages/ui/src/data/DataChartCard.tsx`      | Props of `DataChartCard`                                                                                                               |
| `DataChartPoint`          | Type      | `packages/ui/src/data/DataChartCard.tsx`      | One chart data point (`id`, `label`, `value`)                                                                                          |
| `DataChartFilterOption`   | Type      | `packages/ui/src/data/DataChartCard.tsx`      | One chart filter option (`id`, `label`)                                                                                                |
| `NotificationCenter`      | Component | `packages/ui/src/data/NotificationCenter.tsx` | Filterable notification center with unread count badge, category filters, mark-as-read actions, and loading/empty/error states         |
| `NotificationCenterProps` | Type      | `packages/ui/src/data/NotificationCenter.tsx` | Props of `NotificationCenter`                                                                                                          |
| `NotificationList`        | Component | `packages/ui/src/data/NotificationCenter.tsx` | Renders a list of notifications or an `EmptyState` when none match                                                                     |
| `NotificationListProps`   | Type      | `packages/ui/src/data/NotificationCenter.tsx` | Props of `NotificationList`                                                                                                            |
| `NotificationItemData`    | Type      | `packages/ui/src/data/NotificationCenter.tsx` | Shape of one notification item (`id`, `title`, `message`, `category`, `read`, `createdAt`)                                             |
| `NotificationCategory`    | Type      | `packages/ui/src/data/NotificationCenter.tsx` | `'system'`, `'workflow'`, `'insight'`, or `'alert'`                                                                                    |

Optional dependencies for richer UI (install only when a feature needs them): `@mui/icons-material`, `@mui/x-date-pickers`, and `dayjs` in `apps/web`.

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
| `app-shell-logo`              | Optional logo slot in header                |
| `app-shell-subtitle`          | Optional subtitle in header                 |
| `app-shell-brand-badge`       | Optional brand badge in header              |
| `app-shell-skip-link`         | "Skip to main content" link                 |
| `app-shell-menu-button`       | "Open navigation" button, phone and tablet  |
| `app-shell-close-button`      | "Close navigation" button inside the drawer |
| `app-shell-nav`               | Navigation list                             |
| `app-shell-nav-item-{id}`     | One navigation link per item                |
| `app-shell-color-mode-toggle` | "Dark mode" switch input                    |
| `app-shell-main`              | `main` landmark                             |
| `stat-grid`                   | `StatGrid` container                        |
| `metric-card-{id}`            | `MetricCard` root                           |
| `data-chart-card-{id}`        | `DataChartCard` root                        |
| `notification-center`         | `NotificationCenter` root                   |
| `notification-list`           | `NotificationList` container                |
| `filtered-list-surface-{id}`  | `FilteredListSurface` root                  |
| `detail-panel-{id}`           | `DetailPanel` root                          |
| `detail-drawer-{id}`          | `DetailDrawer` root                         |
| `loading-state`               | `LoadingState`                              |
| `empty-state`                 | `EmptyState`                                |
| `empty-state-action`          | `EmptyState` action button                  |
| `error-state`                 | `ErrorState`                                |
| `error-state-retry`           | `ErrorState` retry button                   |

## Pull request checklist

- [ ] When `packages/ui/src/index.ts` gains, renames, or drops an export, this catalog lists every export it now has, and the [design-system reference](design-system.md) still matches the tokens.
