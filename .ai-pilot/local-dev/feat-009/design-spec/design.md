# Design — Neutral MUI Design System and App Shell

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Design System and Reference Web Client | **Affected personas:** UI/UX, Authenticated User
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (3 unresolved)

---

## Feature Summary

**Description:** Generated applications need an interface that agents can extend without inventing styles. This Feature gives UI/UX a neutral MUI theme with replaceable tokens, light and dark themes, and a contrast check, so a project rebrands by overriding tokens and nothing else. It gives Authenticated Users a responsive application shell with consistent loading, empty, and error states, and a recoverable error screen in place of a blank page. The end state is a `ui` package inside `templates/full-stack-express/` that the reference profile screen (FEAT-010) renders in. The Feature depends on FEAT-001 (workspace and shared configuration).

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-017 | PBI | Rebrand the application by overriding theme tokens | Should Have |
| PBI-018 | PBI | Use the application on any screen size | Must Have |
| TBI-020 | TBI | Create the UI package theme tokens and light and dark themes | Must Have |
| TBI-021 | TBI | Create the app shell, error boundary, state components, and test selector convention | Must Have |

**Business rule:** BR-015 — UI work follows the `ui-standards` skill (authored in FEAT-015; this Feature supplies the components and conventions it describes).

---

## Scope and Out-of-Scope

**In scope:**
- Semantic tokens for colour, spacing, typography, and breakpoints, plus component defaults (TBI-020).
- Light and dark themes that share one token set, and a token-override entry point (TBI-020, PBI-017).
- A contrast check that covers both themes, reports the failing token and pairing, and exits non-zero (TBI-020, PBI-017).
- A lint rule that flags hard-coded colours in the web app and UI package (PBI-017).
- A responsive application shell with phone, tablet, and desktop layouts, landmarks, a skip link, keyboard-operable navigation, and a light/dark switch (TBI-021, PBI-018).
- An error boundary with a recoverable error state (TBI-021, PBI-018).
- Reusable loading, empty, and error state components with documented usage (TBI-021, PBI-018).
- A stable `data-testid` convention and a helper that applies it (TBI-021).

**Out of scope:**
- Brand-specific theming and any shipped branded theme.
- A component library beyond the documented reference components.
- A visual theme editor.
- Native mobile applications and offline support.
- Running the full test suite and the container image build (PBI-001 exclusions that bound this Feature's checks).
- The profile screen, the API client, and routing composition (FEAT-010, TBI-022).
- The `ui-standards` skill, the design-system reference, and the component catalog (FEAT-014, FEAT-015).
- Playwright and axe journeys (FEAT-011). This Feature supplies the selectors and the states they exercise.
- Any change to Apex's own header, navigation, pages, or theme system.

---

## Target Surface

**Primary surface:** Frontend only (React client). The code lives in the template's UI package and is built into the template's web client. It adds no Express route, service, or database change.

**Experience notes:** The shell is the frame of the template's reference experience. It is not an Apex screen and has no Apex navigation entry. The shell has no route of its own. It wraps every route, and the reference profile route `/profile/details/edit` (FEAT-010) renders inside it.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| See the application shell and state components | Authenticated principal from the identity-provider adapter; the shell defines no roles | No restriction (the shell holds no data) |
| Switch between light and dark theme | Any person using the application; the choice stays in that browser | User-scoped (browser storage) |
| Override theme tokens | UI/UX or Developer, by editing the generated project's source | Not applicable (build-time change, no runtime authorization) |
| Review the template in Apex and move it to the bootstrap source | Platform Admin (Platform Engineering) | Global |

**Feature flag:** `None` — rollout: Not applicable (a reviewable sample that does not change Apex runtime behavior)
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-017 — Rebrand the application by overriding theme tokens

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I override the primary color token | I run the web client | Buttons, links, and focus indicators use the new color with no component changes |
| (b) Error/failure | I override a token with a value that fails contrast | I run the contrast check | The check reports the failing token and pairing |
| (c) Edge case/boundary | I override only light-theme tokens | I view the dark theme | The dark theme still renders with its defaults and remains legible |
| (d) Negative scenario | A component sets a hard-coded color | I run lint or review against the UI standards | The hard-coded value is flagged as a violation |

### PBI-018 — Use the application on any screen size

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I open the application on a desktop-width screen | The shell renders | Navigation and content are laid out for wide screens with landmarks and visible focus |
| (b) Error/failure | A page fails to render because of an error | The error boundary catches it | I see a recoverable error state with a way to retry, not a blank page |
| (c) Edge case/boundary | I resize the window to the narrowest supported width (320 px) | The shell re-renders | Content stays readable with no horizontal scrolling and controls remain reachable |
| (d) Negative scenario | Data for a page is loading or empty | The page renders | A loading or empty state is shown instead of a blank area, and it is announced to assistive technology |

### Technical items — definition of done

| Item | Done when |
|------|-----------|
| TBI-020 | Tokens exist for color, spacing, typography, and breakpoints. Light and dark themes share one token set. Overriding tokens changes the rendered theme with no component edits. A contrast check covers both themes, and both meet WCAG 2.1 AA. |
| TBI-021 | The shell adapts at phone, tablet, and desktop widths. The error boundary shows a recoverable state instead of a blank page. Loading, empty, and error components exist with documented usage. Component tests cover each state and the selector convention. Shell and state components are keyboard operable and expose accessible names. |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| All routes (wrapper) | `AppShell` | Navigate between destinations, switch theme, skip to content | New (template only; Apex's own shell is untouched) |
| `/profile/details/edit` (FEAT-010) | Profile screen inside the shell | Shows loading, empty, and error states from this Feature | New (owned by FEAT-010) |

**Responsive layout:**

| Width | Name | Navigation | Content padding | Content max width |
|-------|------|-----------|-----------------|-------------------|
| 320–599 px | Phone | Temporary drawer opened by a menu button in the header | 16 px | Full width |
| 600–899 px | Tablet | Temporary drawer opened by a menu button in the header | 24 px | Full width |
| 900 px and up | Desktop | Permanent drawer, 240 px wide, beside the content | 32 px | 1200 px, left aligned |

Layout switches at the breakpoint without a page reload and without visible layout shift. Content never needs horizontal scrolling at 320 px.

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `AppThemeProvider` | Applies the light and dark themes and global baseline styles | None | None | Not applicable |
| `ColorModeToggle` | Header switch labelled "Dark mode" that toggles light and dark | None | None | Not applicable |
| `AppShell` | Header, navigation, skip link, and main content region | None (children own loading) | Children wrapped by the host in `AppErrorBoundary` | Hides the navigation landmark and menu button when `navItems` is empty |
| `AppErrorBoundary` | Catches render errors below it and offers a retry | None | Renders `ErrorState` with a retry action | Not applicable |
| `LoadingState` | Tells the person that content is loading | Spinner with the visible text "Loading" (page and inline variants) | Not applicable | Not applicable |
| `EmptyState` | Tells the person that no content exists, with an optional action | None | Not applicable | Title, optional description, and optional action button |
| `ErrorState` | Shows a safe message and a retry action | None | Message from the caller, with a retry button when `onRetry` is set | Not applicable |

**Validation rules:**
- Navigation items: each needs a unique `id`, a `label`, and a `to` path. Duplicate `id` values throw during development.
- `EmptyState`: `title` is required. `description` and `action` are optional.
- `ErrorState`: shows only the `message` prop. Default text is "Something went wrong." The component never shows raw error text, stack traces, or Problem Details `detail` fields.
- Token overrides: every color must be an opaque hex, `rgb()`, or `hsl()` value. The contrast check rejects any value it cannot parse, and names the token.

**Accessibility:**
- Landmarks: `banner` (header), `navigation` labelled "Primary", and `main` with `id="main-content"`.
- A "Skip to main content" link is the first tab stop. Activating it moves focus to `main`.
- The menu button has the accessible name "Open navigation", reports `aria-expanded`, and controls the drawer. Opening the drawer moves focus to the first navigation item. Escape closes it and returns focus to the menu button.
- The current navigation item carries `aria-current="page"`.
- `LoadingState` and `EmptyState` use `role="status"` so assistive technology announces them politely. `ErrorState` uses `role="alert"`.
- Focus indicators: a 2 px outline from the `focus` token on every focusable element, never removed. The focus color meets 3:1 against both surfaces.
- Both themes meet WCAG 2.1 AA: 4.5:1 for text, 3:1 for focus rings and input borders.
- Transitions turn off when the system requests reduced motion.
- All controls work by keyboard alone.

**data-testid attributes:**

Convention: lower-case kebab-case, `{scope}-{element}[-{qualifier}]`, produced by the `testId()` helper.

- `data-testid="app-shell"` — shell root
- `data-testid="app-shell-header"` — header
- `data-testid="app-shell-skip-link"` — skip link
- `data-testid="app-shell-menu-button"` — menu button (phone and tablet)
- `data-testid="app-shell-nav"` — navigation list
- `data-testid="app-shell-nav-item-{id}"` — one navigation link per item
- `data-testid="app-shell-color-mode-toggle"` — light/dark switch
- `data-testid="app-shell-main"` — main region
- `data-testid="loading-state"` — loading component
- `data-testid="empty-state"` and `data-testid="empty-state-action"` — empty component and its action
- `data-testid="error-state"` and `data-testid="error-state-retry"` — error component and its retry button

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
