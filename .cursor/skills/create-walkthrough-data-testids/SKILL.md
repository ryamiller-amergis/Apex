---
name: create-walkthrough-data-testids
description: >-
  Adds selective, coachable data-testid markers on UI elements for a curated
  walkthrough route so Sync/coachmarks can target a user journey — not every
  control on the page. Uses the mandatory spread syntax
  `{...{ 'data-testid': '…' }}`. Use when the user says
  /create-walkthrough-data-testids {path}, asks to add walkthrough test ids
  for a page, or wants coachmark-ready anchors on a screen.
disable-model-invocation: true
---

# Create Walkthrough data-testids

Selectively mark **coachable** UI on a curated walkthrough route so Anchor
Management Sync can discover them for coachmarks. Prefer journey landmarks
over exhaustive interactive coverage.

**Not** the same as [`resolve-pre-commit-data-testid`](../resolve-pre-commit-data-testid/SKILL.md)
(which satisfies the pre-commit policy for *all* interactive elements). This
skill only tags surfaces a walkthrough would teach.

## Trigger

```
/create-walkthrough-data-testids {path}
```

Pass the path **without a leading slash** so Cursor does not treat it as
another `/` command:

| Input | Normalized route |
|-------|------------------|
| `profile` | `/profile` |
| `backlog?tab=prds` | `/backlog?tab=prds` |
| `standup` | `/standup` |
| `planning/dev-stats` | `/planning/dev-stats` |

Also accept pasted browser URLs — strip origin, hash, and trailing slash noise:

| Pasted input | Normalized route |
|--------------|------------------|
| `https://localhost:5173/profile` | `/profile` |
| `http://localhost:3000/backlog?tab=prds` | `/backlog?tab=prds` |
| `https://app.example.com/standup#section` | `/standup` |
| `/profile` (leading slash typed anyway) | `/profile` |

**Normalize before matching:**

1. If the arg looks like an absolute URL (`http://` / `https://`), parse
   pathname + search (`URL`), drop hash.
2. Else take the raw arg; strip a single leading `/` if present.
3. Ensure the result starts with `/` for catalog matching
   (e.g. `profile` → `/profile`).
4. Drop a trailing `/` unless the route is exactly `/`.
5. Match the normalized string against `ROUTE_ENTRIES` (exact match only).

If `{path}` is missing, ask for a path like `profile` (or paste a full URL)
from `src/shared/walkthroughRoutes.ts` `ROUTE_ENTRIES` before editing.

## Required syntax (mandatory)

Always use the **object spread** form. Never write a kebab-case JSX attribute.

```tsx
// ✅ REQUIRED
<button type="button" {...{ 'data-testid': 'profile-save-btn' }}>Save</button>
<section {...{ 'data-testid': 'profile-identity-section' }}>…</section>

// ✅ OK — curated DOM marker (only if already registered / intentionally adding
//    WalkthroughAnchorKeys + DOM_MARKER_ENTRIES in walkthroughAnchors.ts)
<button type="button" {...anchorTestIdProps(WalkthroughAnchorKeys.USER_MENU_TRIGGER)}>…</button>

// ❌ FORBIDDEN
<button type="button" data-testid="profile-save-btn">Save</button>
```

Id **values** stay lowercase kebab-case. Prefer plain spread for new Sync
candidates; reserve `anchorTestIdProps` for explicit registry keys.

## Preconditions

1. Normalize `{path}` (or pasted URL) per Trigger rules, then confirm it is an
   **exact** entry in `src/shared/walkthroughRoutes.ts` `ROUTE_ENTRIES`. Do not
   invent routes or entity IDs (`/backlog/prd/123` is out of scope).
2. Map route → page components via `src/client/App.tsx` (and nested dashboards /
   tab panels). Include child components that render the route's primary UI.
3. **Also include the sidebar entry** that navigates to this route in
   `src/client/components/AppSidebar.tsx` (see Sidebar nav entry below).
4. Skip Platform Admin / walkthrough chrome (see Exclusions).

## Sidebar nav entry (required)

A typical walkthrough journey starts from the left nav. For the target route,
ensure `AppSidebar.tsx` lists a module item with a string-literal `view` that
matches the page (and uses the shared `navItemTestIdProps` convention).

**Convention (do not maintain a static id map):**

```tsx
{ label: 'Design Module', view: 'design-module', /* … */ }

// Shared helper — Sync resolves every literal view: → nav-item-${view}
function navItemTestIdProps(item: NavItem): { 'data-testid': string } {
  return { 'data-testid': item.testId ?? `nav-item-${item.view}` };
}
```

Sync (`extractAppSidebarPrefixedViewOccurrences` in
`walkthroughAnchorSyncExtraction.ts`) discovers `nav-item-design-module` from
`view: 'design-module'`. Teams only add/edit the nav item — no parallel
`NAV_ITEM_TEST_ID_PROPS` map.

**Rules:**

1. `view` must be a **string literal** (e.g. `'design-module'`), never a
   variable — Sync reads those literals.
2. Default id is `nav-item-${view}` (e.g. `design-module` →
   `nav-item-design-module`).
3. Rare override only when the shipped id cannot follow the convention:
   `testId: 'nav-load-tests'` on that same item object.
4. Keep using spread / `navItemTestIdProps` — never legacy `data-testid=`.
5. Do **not** invent a static Record of test ids for Sync.

Home / Admin (non-module buttons) may keep literal spreads
(`nav-item-home`, `nav-item-admin`) when needed.

## Coachable selection (smart tagging logic)

**Goal:** enough anchors to teach a typical user journey on this page — not
every button, icon, or row action.

### Include (prefer)

Surfaces a coachmark would point at while teaching a workflow:

| Kind | Examples |
|------|----------|
| Primary CTAs | Create, Save, Submit, Approve, Start, Open |
| Navigation | Tabs, **AppSidebar nav item for this route**, section jump links on the page |
| Landmark sections | Page header, filter/toolbar, main panel, empty state, key form sections |
| Teaching signals | Error/success banners, empty states, onboarding entry points |
| Durable menus | User menu trigger, profile entry, help entry |

Prefer clear kebab-case ids (`design-module-add-btn`, `profile-save-btn`).
Sync no longer requires a special “coachable token” allowlist — any
non-excluded `data-testid` can enter catalog review. Still avoid admin /
walkthrough chrome ids (see excludes below and
`walkthroughAnchorCoachableFilter.ts`).

### Exclude (do not tag for walkthroughs)

| Kind | Examples |
|------|----------|
| Fine-grained chrome | pagination page numbers, icon-only affordances, spinners, skeletons, tooltips |
| Row/cell minutiae | every table row action, every checkbox in a multi-select grid |
| Decorative / layout | pure wrappers, SVG primitives, spacer divs |
| Admin / authoring chrome | Platform Admin, Walkthrough catalog/editor/sync UI |
| Dynamic template ids | Arbitrary `` `${…}` `` ids Sync cannot resolve (AppSidebar `nav-item-${view}` is the supported exception) |

Mirror exclude intent from `EXCLUDED_TEST_ID_RE` /
`EXCLUDED_PATH_RE` in `walkthroughAnchorCoachableFilter.ts`.

### Budget guidance

For one route, aim for roughly **5–15 new coachable ids** (fewer on simple
pages, more on dense dashboards). Prefer one id on a **section/panel** over
tagging every control inside it unless the control itself is the teaching
target (e.g. Save).

Use the smart-tagging dimensions as a mental filter (do not write a JSON
artifact unless asked):

- **domain** — does this belong to the route's product area?
- **action** — would a step say "click/open/save …"?
- **UI element** — button / tab / section / modal / …
- **workflow** — onboarding, settings, review, navigation, …
- **intent** — discover, configure, complete-task, …

If an element fails most dimensions, skip it.

## Naming

1. Lowercase kebab-case: `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
2. Prefix with route/domain context: `profile-theme-section`,
   `standup-submit-btn`, `admin-tab-roles`.
3. Suffix by role: `-btn`, `-tab`, `-section`, `-panel`, `-modal`, `-banner`,
   `-empty`, `-trigger`, `-input`, `-toolbar`.
4. Reuse an existing id if the element already has a spread (or convert legacy
   `data-testid="…"` → spread without renaming unless the id is non-coachable).
5. Do not encode ephemeral layout (`left-column-2`).
6. Dynamic lists: only when the list *itself* is the coaching target; use a
   stable suffix (`work-item-${id}`). Prefer a list/grid container id for
   journey steps.

## Procedure

```
Task Progress:
- [ ] 1. Normalize path/URL + validate against walkthroughRoutes.ts
- [ ] 2. Resolve page component tree from App.tsx + AppSidebar nav entry
- [ ] 3. Inventory existing data-testid / anchorTestIdProps on that tree
- [ ] 4. Propose coachable targets (budget + include/exclude + sidebar)
- [ ] 5. Apply spread markers in source (page + ensure sidebar view: literal)
- [ ] 6. Convert any legacy data-testid= on touched elements to spread
- [ ] 7. Report what was added / skipped
```

### Step 1 — Normalize + validate route

Normalize `{path}` / pasted URL (see Trigger). Read `ROUTE_ENTRIES` in
`src/shared/walkthroughRoutes.ts`. Hard-stop if the normalized route is not an
exact match.

### Step 2 — Resolve components

From `src/client/App.tsx`, find which view/components render for that route
(including query tabs like `?tab=prds`). Open those files under
`src/client/components/` (and shared children they own for that page).

**Always also open** `src/client/components/AppSidebar.tsx` and locate the
nav item whose `view` / navigate handler targets this route. That sidebar
control is in scope for this skill.

### Step 3 — Inventory

Search the component tree **and AppSidebar** for existing markers:

```bash
rg -n "data-testid|anchorTestIdProps|view:|navItemTestIdProps" --glob "*.tsx" <page-files> src/client/components/AppSidebar.tsx
```

Do not duplicate ids. Convert legacy `data-testid="…"` to spread when you
touch that element. For the sidebar: confirm a string-literal `view: '…'`
exists for this route and `navItemTestIdProps` (or equivalent
`` `nav-item-${item.view}` ``) is used — Sync resolves those views. Do **not**
add a static id map.

### Step 4 — Select targets

List candidate elements against Include / Exclude / Budget. Ensure the
**sidebar nav item** for this route exists with a literal `view` (add the nav
item only if the module is missing from the sidebar entirely). Skip anything
else already adequately marked.

### Step 5 — Apply

Add markers on the **stable DOM host** the coachmark should highlight
(section root, button, tab), using spread syntax only.

For the sidebar: add/update the module row with `view: '<view>'` (and optional
rare `testId` override). Sync discovers `nav-item-<view>` and refreshes an
existing catalog row with the same `testId` (clears **missing**, updates
`lastSeenAt` / source). Matching is by `testId` — Sync will not create a
duplicate for an already-cataloged id.

Do **not** edit:

- `vite.config.ts`, `src/server/index.ts`, auth, package.json, or other
  scope-discipline protected files
- Walkthrough admin / sync UI unless the route is explicitly those pages
  (normally excluded)

Do **not** expand `DOM_MARKER_ENTRIES` / `WalkthroughAnchorKeys` unless the
user asks for an explicit registry opt-in — Sync discovers plain test ids.

### Step 6 — Verify syntax

In files you edited, ensure no leftover kebab-case attributes on those
elements:

```bash
rg -n "\bdata-testid\s*=" --glob "*.tsx" <edited-files>
```

Only `'data-testid':` inside spreads (or `anchorTestIdProps`) should remain.

### Step 7 — Report

```
## Walkthrough data-testids — {normalized-route}

### Added (spread)
- path:line — <Tag> → {...{ 'data-testid': '…' }} — why coachable

### Converted (legacy → spread)
- path:line — data-testid="…" → spread

### Skipped (intentionally)
- control — reason (fine-grained / already marked / non-coachable)

### Next step
Run **Sync** in Platform Admin → Walkthroughs → Anchor Management so new ids
enter the catalog for smart-tagging / approval. Existing catalog rows with the
**same `testId`** are refreshed (presence cleared / `missingSince` nulled) —
not duplicated.
```

## Constraints (MUST follow)

1. **Selective, not exhaustive** — journey landmarks only.
2. **Spread syntax only** for new/fixed markers.
3. **Curated routes only** — exact `walkthroughRoutes.ts` match.
4. **Stable kebab-case ids** — Sync accepts any non-excluded discovery (no
   token allowlist).
5. **Sidebar via convention** — literal `view:` + `nav-item-${view}` (or rare
   `testId` override); never a hand-maintained static id map.
6. **No invented UI** — only mark controls that exist in source.
7. **No commit/push** unless the user explicitly asks.
8. Do not ask clarifying questions mid-flight when the route is valid; if
   ownership is ambiguous, mark the closest durable landmark and note it in
   the report.

## Related

- Pre-commit exhaustive policy → [`resolve-pre-commit-data-testid`](../resolve-pre-commit-data-testid/SKILL.md)
- Sync coachable filter → `src/server/services/walkthroughAnchorCoachableFilter.ts`
- Sync extraction → `src/server/services/walkthroughAnchorSyncExtraction.ts`
- Smart tagging (catalog suggestions) → [`walkthrough-anchor-smart-tagging`](../walkthrough-anchor-smart-tagging/SKILL.md)
- Routes → `src/shared/walkthroughRoutes.ts`
- DOM markers helper → `src/shared/walkthroughAnchors.ts` (`anchorTestIdProps`)
