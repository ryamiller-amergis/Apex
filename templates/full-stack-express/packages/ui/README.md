# @project-scope/ui

The neutral MUI design system for the web client: semantic tokens, light and dark themes, component defaults, a contrast check, the application shell, the error boundary, and the loading, empty, and error states.

Import everything from `@project-scope/ui`. Do not import from `src/` or `dist/` paths. The package lists `react`, `react-dom`, `@mui/material`, `@emotion/react`, `@emotion/styled`, and `react-router` as peer dependencies, so the host app installs them.

## Usage

| Export                                                             | Use it to                                                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AppThemeProvider`                                                 | Wrap the app once. Applies both themes, baseline styles, focus rings, and reduced-motion rules. Takes optional `overrides`.                                                                   |
| `useColorMode`                                                     | Read `mode` (`'light'` or `'dark'`) and call `setMode`. The first visit follows the operating system; a choice is stored in `localStorage` under `COLOR_MODE_STORAGE_KEY` (`app-color-mode`). |
| `createAppTheme`                                                   | Build the MUI theme from tokens and overrides when you need the theme object outside the provider.                                                                                            |
| `tokens`, `mergeTokens`                                            | Read the default tokens, or the tokens with overrides applied.                                                                                                                                |
| `checkThemeContrast`, `CONTRAST_PAIRINGS`, `formatContrastFailure` | Check every required colour pairing in both schemes and print failures.                                                                                                                       |
| `AppShell`                                                         | Frame every route: skip link, header with the "Dark mode" switch, primary navigation, and the `main` landmark.                                                                                |
| `AppErrorBoundary`, `APP_ERROR_MESSAGE`                            | Catch render errors and show a recoverable error state with a retry button.                                                                                                                   |
| `LoadingState`                                                     | Replace a blank area while data loads. Announced as `role="status"`.                                                                                                                          |
| `EmptyState`                                                       | Show that no content exists, with an optional action. Announced as `role="status"`.                                                                                                           |
| `ErrorState`                                                       | Show a safe message with an optional retry button. Announced as `role="alert"`.                                                                                                               |
| `testId`, `TEST_ID_PATTERN`                                        | Build `data-testid` values that follow the selector convention.                                                                                                                               |

### Compose the app

```tsx
import { BrowserRouter, useLocation } from 'react-router';
import {
  AppErrorBoundary,
  AppShell,
  AppThemeProvider,
  type NavItem,
} from '@project-scope/ui';

const navItems: NavItem[] = [
  { id: 'profile', label: 'Profile', to: '/profile/details/edit' },
];

const Frame: React.FC = () => {
  const location = useLocation();
  return (
    <AppShell appName="project-name" navItems={navItems}>
      <AppErrorBoundary resetKeys={[location.pathname]}>
        <Routes />
      </AppErrorBoundary>
    </AppShell>
  );
};

<AppThemeProvider overrides={overrides}>
  <BrowserRouter>
    <Frame />
  </BrowserRouter>
</AppThemeProvider>;
```

`AppShell` takes `appName`, `navItems` (each with a unique, stable `id`, a `label`, and a `to` path), optional `headerActions`, and `children`. An empty `navItems` list renders no navigation landmark and no menu button. A duplicate `id` throws.

| Width         | Layout  | Navigation                                 | Content padding | Content max width |
| ------------- | ------- | ------------------------------------------ | --------------- | ----------------- |
| below 600 px  | Phone   | Temporary drawer opened by the menu button | 16 px           | Full width        |
| 600 to 899 px | Tablet  | Temporary drawer opened by the menu button | 24 px           | Full width        |
| 900 px and up | Desktop | Permanent 240 px drawer beside the content | 32 px           | 1200 px           |

### Map request states to components

The state components fetch nothing. Map query states onto them in the page:

```tsx
if (query.isPending) return <LoadingState label="Loading profile" />;
if (query.isError)
  return (
    <ErrorState
      message="We could not load your profile."
      onRetry={() => query.refetch()}
    />
  );
if (!query.data) return <EmptyState title="No profile yet" />;
```

- `LoadingState({ label = 'Loading', variant = 'page' | 'inline' })`
- `EmptyState({ title, description?, action?: { label, onClick } })`
- `ErrorState({ title = 'Something went wrong', message?, onRetry?, retryLabel = 'Try again' })`

Pass fixed strings to `ErrorState`. Never pass an `Error` message, a stack trace, or a Problem Details `detail` field; they can hold identity values. `AppErrorBoundary` never renders the thrown message. It passes the error to `onError`, and the host must redact identity values before logging it.

## Override tokens

Branding is a token override. Do not edit components, and do not write colour literals: the `design-tokens/no-hardcoded-color` lint rule reports hex, `rgb()`, `rgba()`, `hsl()`, and `hsla()` literals in `apps/web/src` and `packages/ui/src`. It allows `packages/ui/src/tokens/` and the web override module `apps/web/src/theme/`. Named colours such as `red` are not detected; catch them in review.

1. Edit `apps/web/src/theme/overrides.ts`. Each scheme merges on its own, so a light-only override leaves dark at its defaults. When a scheme overrides `primary.main` and not `focus`, the focus ring follows the new primary colour.

   ```ts
   import type { TokenOverrides } from '@project-scope/ui';

   const overrides: TokenOverrides = {
     colors: {
       light: { primary: { main: '#7A1FA2' } },
       dark: { primary: { main: '#D7AEFB', contrastText: '#1E0533' } },
     },
   };

   export default overrides;
   ```

2. Use opaque hex, `rgb()`, or `hsl()` values. The contrast check cannot parse named colours or alpha, and reports them as failures.

3. Build the package, then run the contrast check against your overrides.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm --filter @project-scope/ui build
   pnpm --filter @project-scope/ui check:contrast --overrides ../../apps/web/src/theme/overrides.ts
   ```

   `check:contrast` prints one line per failing pairing, for example `dark: text.secondary on background.paper = 2.36, needs 4.5`, and exits 1. It exits 0 when both themes pass WCAG 2.1 AA: 4.5:1 for text, 3:1 for focus rings and input borders.

Colour tokens per scheme: `primary`, `secondary`, `error`, `warning`, `info`, and `success` (each `main` and `contrastText`), `text.primary`, `text.secondary`, `background.default`, `background.paper`, `divider`, `focus`, and `inputBorder`. Spacing uses an 8 px base; call `theme.spacing()` and never write pixel spacing. Breakpoints are `xs` 0, `sm` 600, `md` 900, `lg` 1200, and `xl` 1536.

## Test selector convention

- Interactive elements and key content elements carry a `data-testid`.
- Values are lower-case kebab-case in the form `{scope}-{element}[-{qualifier}]`, matching `TEST_ID_PATTERN`.
- Build dynamic values with `testId(scope, ...parts)`, which lower-cases and joins the parts and throws when the result is not kebab-case. Use stable ids, never array indexes or display text: `testId('app-shell', 'nav-item', item.id)`.
- In component tests, query by role and accessible name first, and by `data-testid` when no role fits.

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

## Scripts

Working directory: `templates/full-stack-express/`.

| Command                                          | Purpose                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `pnpm --filter @project-scope/ui build`          | Compile to `dist/`                              |
| `pnpm --filter @project-scope/ui typecheck`      | Type-check sources and tests                    |
| `pnpm --filter @project-scope/ui test`           | Run component and unit tests (Vitest and jsdom) |
| `pnpm --filter @project-scope/ui check:contrast` | Check both themes; add `--overrides <path>`     |
