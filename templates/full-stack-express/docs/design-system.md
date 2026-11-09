# Design-system reference

The design system is the `@project-scope/ui` package in `packages/ui/`. It is a neutral MUI theme: semantic tokens, a light and a dark scheme, component defaults, and a contrast check. Screens use its components and the theme. They never write colour or spacing literals. Screens may also use MUI components that read this theme, such as `Button` and `TextField`. Every export, and that MUI rule, is listed in the [component catalog](component-catalog.md). Usage examples are in the [UI package guide](../packages/ui/README.md).

## Tokens

The tokens live in `packages/ui/src/tokens/` and are exported as `tokens`. Read them through the MUI theme in components, for example `theme.vars.palette.primary.main` or `theme.spacing(2)`.

| Group       | Source file                             | Values                                                                                                                                                                                                                    |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colours     | `packages/ui/src/tokens/colors.ts`      | Per scheme: `primary`, `secondary`, `error`, `warning`, `info`, `success` (each `main` and `contrastText`), `text.primary`, `text.secondary`, `background.default`, `background.paper`, `divider`, `focus`, `inputBorder` |
| Spacing     | `packages/ui/src/tokens/spacing.ts`     | Base unit 8 px, so `theme.spacing(n)` is `n * 8` px. Named steps `xxs` 4, `xs` 8, `sm` 12, `md` 16, `lg` 24, `xl` 32                                                                                                      |
| Typography  | `packages/ui/src/tokens/typography.ts`  | System font stack, no web font. Body size 14 px on a 16 px root. Weights 400, 500, 600. Scale `h1` 2.25rem to `caption` 0.75rem                                                                                           |
| Breakpoints | `packages/ui/src/tokens/breakpoints.ts` | `xs` 0, `sm` 600, `md` 900, `lg` 1200, `xl` 1536 px. Phone is below `sm`, tablet is `sm` to below `md`, desktop is `md` and up                                                                                            |

Light and dark use one `ColorSchemeTokens` shape, so a key missing from either scheme is a compile error.

## Themes and colour mode

`createAppTheme` in `packages/ui/src/theme/createAppTheme.ts` builds one MUI theme with both colour schemes as CSS variables. Component defaults, focus rings, and reduced-motion rules are in `packages/ui/src/theme/components.ts`.

Wrap the app once in `AppThemeProvider`. The first visit follows the operating system setting. `useColorMode` reads and sets the mode, and the choice is stored in `localStorage` under `COLOR_MODE_STORAGE_KEY` (`app-color-mode`). The application shell's "Dark mode" switch calls it.

## Branding

Branding is a token override, not a component edit.

1. Edit `apps/web/src/theme/overrides.ts`. It exports a `TokenOverrides` object. Each scheme merges on its own, so a light-only override leaves dark at its defaults. When a scheme overrides `primary.main` and not `focus`, the focus ring follows the new primary colour.
2. Use opaque hex, `rgb()`, or `hsl()` values. Named colours and alpha cannot be checked for contrast.
3. Build the UI package, then run the contrast check with your overrides. The exact commands are in the [UI package guide](../packages/ui/README.md#override-tokens).

`mergeTokens` returns the default tokens with overrides applied when you need the values outside the theme.

## Contrast and accessibility

`checkThemeContrast` checks every pairing in `CONTRAST_PAIRINGS` in both schemes against WCAG 2.1 AA: 4.5:1 for text, 3:1 for focus rings and input borders. The `check:contrast` script of the UI package prints one line per failure and exits 1.

The `design-tokens/no-hardcoded-color` lint rule, in `packages/config/eslint/no-hardcoded-color.mjs`, reports hex, `rgb()`, `rgba()`, `hsl()`, and `hsla()` literals in `apps/web/src/` and `packages/ui/src/`. It allows `packages/ui/src/tokens/` and `apps/web/src/theme/`. Named colours such as `red` are not detected; catch them in review.

Every shared component is keyboard reachable, has a visible focus ring, and announces its state: `LoadingState` and `EmptyState` use `role="status"`, and `ErrorState` uses `role="alert"`.

## Layout

`AppShell` frames every route. Below 600 px and up to 899 px the navigation is a temporary drawer opened by the menu button. From 900 px it is a permanent 240 px drawer beside the content. Content padding is 16, 24, and 32 px across the three layouts, and content width stops at 1200 px on desktop.
