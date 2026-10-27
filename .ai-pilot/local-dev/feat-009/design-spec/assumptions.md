# Assumptions & Unresolved Items — Neutral MUI Design System and App Shell

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Light/dark selection mechanism**: The Design System epic assumes the mechanism "is chosen at implementation and documented in the ui-standards skill", so the PRD gives no rule. The spec proposes: first visit follows the operating system setting (`prefers-color-scheme`), a header switch labelled "Dark mode" toggles between light and dark, and the choice persists in `localStorage` under `app-color-mode`. A three-way choice (system, light, dark) would add UI and a storage state. The team must confirm the proposal before step S4 (theme provider) and S9 (shell header) start. The `ui-standards` skill (FEAT-015) documents the final choice.
- ⚠ **Quality-manifest gate for the contrast check and the hard-coded-colour lint rule**: PBI-017 requires a contrast check and a lint or review control, but FEAT-012 owns the quality manifest and the PRD lists no gate named "contrast" or "design tokens". The spec ships `pnpm --filter @your-scope/ui check:contrast` and the lint rule `no-hardcoded-color`, and proposes that the manifest attaches the contrast script to the `accessibility` gate and the lint rule to the `lint` gate. Platform Engineering and the FEAT-012 owner must confirm the mapping before step S11 (handoff to the manifest) completes. Until then the unit test VT-04 is the only automated enforcement.
- ⚠ **Reach of the "Existing Code Protection Rules"**: The generation instructions say "DO NOT generate code for the sidebar, header, navigation, or page shell". This Feature's deliverables are a sidebar, a header, navigation, and a page shell, inside the template folder `templates/full-stack-express/`. The spec reads the rule as protecting Apex's own `AppHeader.tsx` and `App.tsx` shell, which this Feature never touches. If the rule applies to the template as well, TBI-021 and PBI-018 cannot be implemented as written. The team must confirm the reading before step S9 (shell implementation) starts.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

**Layout and packaging**

- **Workspace paths**: The UI package lives at `templates/full-stack-express/packages/ui/`, the web client at `templates/full-stack-express/apps/web/`, and the shared lint configuration at `templates/full-stack-express/packages/config/`. The PRD names the five workspace members but no folder layout, so `apps/` and `packages/` follows the usual pnpm convention. If TBI-001 picks other paths, only the paths in this spec change.
- **Package scope placeholder**: Documents refer to the package as `@your-scope/ui`. TBI-001 lists the real placeholder in the template README. Risk: a mismatch breaks only copy-pasted commands.
- **Apex UI rules do not apply inside the template**: `ui-design-standards.mdc` mandates CSS variables from `App.css`, CSS Modules, and the Neon, Light, Dark, and Amergis themes. The template is MUI-based and contains no Apex code or Amergis branding (BR-008). The spec keeps the principles (tokens only, no hard-coded colours, the 4–32 px spacing scale, the system font stack, `data-testid` on interactive elements) and drops the mechanisms. Risk: a reviewer expects Apex CSS Modules in the template.
- **Apex prior art is followed in shape, not copied**: `ViewErrorFallback` (`src/client/components/ViewErrorFallback.tsx`) wraps views with `react-error-boundary` and shows a retry button. The template follows that shape. It does not copy two behaviours: it does not render `error.message`, and it does not call Apex telemetry. Messages can carry identity values, which BR-007 and the PRD security section forbid in user-visible output.

**Dependencies**

- **MUI version supports CSS variables and `colorSchemes`**: The compatibility table (TBI-002) pins MUI v6 or later, so `createTheme({ cssVariables: true, colorSchemes })` is available. That API switches themes without a page reload or a React remount. Risk: an older pin lacks that API, so the theme switch would re-render and remount more of the tree, and the "no full page reload" requirement needs a different implementation.
- **`react-error-boundary` is on the organization-approved list**: Apex uses it, and a class-based boundary would otherwise be hand-written. The package is recorded in the compatibility table. Risk: if it is not approved, the boundary becomes a 30-line class component with the same public props.
- **React Router is a peer dependency of the UI package**: TBI-021 lists it as a technical dependency of the shell. The shell uses `NavLink` for `aria-current="page"`. Risk: a router-agnostic shell would need a link-component prop.
- **No icon package**: The UI package ships two inline `SvgIcon` glyphs (menu and close) from `@mui/material`. Risk: designers expect a full icon set. A full set is outside "a component library beyond the documented reference components".
- **Component test tools**: `@testing-library/react`, `@testing-library/jest-dom`, and `@testing-library/user-event` run on Vitest with jsdom, and the PRD fixes only the RTL and Vitest pairing. The Playwright and axe tools come from FEAT-011.
- **Contrast maths reuses `getContrastRatio` from `@mui/material/styles`**: It already ships with MUI and parses hex, `rgb()`, and `hsl()`. It ignores alpha, so tokens must be opaque colours. Named colours (`red`) are rejected as unparseable by the check.

**Design decisions**

- **Neutral palette values are starting points**: The hex values in the tech spec (graphite text, slate surfaces, one blue accent) are indicative. VT-04 decides whether they pass WCAG 2.1 AA. Any value that fails is adjusted, and the test is not relaxed.
- **Breakpoints keep MUI defaults**: `xs` 0, `sm` 600, `md` 900, `lg` 1200, `xl` 1536 px. Phone is below 600, tablet is 600–899, desktop is 900 and up. The PRD names three layouts but no widths.
- **Narrowest supported width is 320 CSS px**: This is the WCAG 2.1 reflow width (1.4.10). PBI-018 (c) says "narrowest supported width" without a number. Risk: a product that needs 280 px has to change the E2E viewport.
- **Tablet and phone use a temporary drawer; desktop uses a permanent drawer**: The three layouts differ in drawer mode, content padding (16, 24, 32 px), and content maximum width. A tablet icon rail was rejected because it needs an icon per item and the template has no icon set.
- **JS media queries with `noSsr: true`**: The web client is a Vite single-page app with no server rendering, so `useMediaQuery` reads the real viewport on the first render and causes no layout shift. If a project adds server rendering, it must switch to CSS-only responsive props.
- **Shell is identity-agnostic**: The shell renders no display name, email, or subject. The profile screen (FEAT-010) can supply header content through the `headerActions` slot. This keeps identity values out of the UI package.
- **Navigation items come from `apps/web`**: The shell takes a `navItems` array. TBI-022 supplies the reference list (one "Profile" entry). A one-entry drawer looks heavy, but a drawer proves the pattern that generated applications extend.
- **State components take caller-supplied safe text**: `ErrorState` shows only the `message` prop. The documentation tells callers to pass fixed strings, never raw `Error` objects or Problem Details `detail` fields.
- **Hard-coded-colour lint covers hex, `rgb()`, `rgba()`, `hsl()`, and `hsla()` literals**: Named colours such as `red` are not detected by the lint rule. They are caught in review and by the UI skill. Risk: a named colour passes lint.
- **English strings only**: Accessible names and default messages are hard-coded English. The PRD defines no internationalization.
- **Test selector convention**: `data-testid` values are lower-case kebab-case in the form `{scope}-{element}[-{qualifier}]`, generated by the `testId()` helper. React Testing Library tests use role and label queries first and `data-testid` when no role exists. Apex enforces `data-testid` conventions on its own screens, and the template follows the same idea with its own scheme.

**Delivery and ownership**

- **Documentation split**: This Feature ships usage documentation as TSDoc and `packages/ui/README.md`. The design-system reference, component catalog, and `ui-standards` skill belong to FEAT-014 and FEAT-015 and consume these files.
- **E2E checks wait for other Features**: VT-20 and VT-21 need the profile route (FEAT-010) and the Playwright and axe harness (FEAT-011). Until those exist, the component tests VT-09 through VT-18 carry the shell acceptance criteria.
- **Persona mapping**: "UI/UX" is the designer who overrides tokens (PBI-017). "Authenticated User" is the person who uses the shell (PBI-018). "Platform Admin" appears only in the review row of the access table. The PRD introduces no new persona.
- **No feature flag**: The PRD sets "Flag required: No". The template ships with the design system on, and it has no Apex runtime effect.
- **Apex formatting check**: Template files must pass Apex's root formatting check or receive the minimal approved ignore entry from FEAT-001. This Feature adds files under the template folder only and adds no further exception.
