---
name: resolve-pre-commit-data-testid
description: >-
  Fixes pre-commit data-testid policy failures on staged client TSX. Adds
  stable kebab-case ids via spread `{...{ 'data-testid': '…' }}` (or
  anchorTestIdProps) to interactive UI in touched files so
  scripts/check-data-testid.mjs passes. Converts legacy kebab-case
  `data-testid="…"` attributes to spread. Use when the user says
  /resolve-pre-commit-data-testid, the data-testid policy blocked a commit,
  or interactive elements in a touched screen lack data-testid.
disable-model-invocation: true
---

# Resolve Pre-commit data-testid

Clear failures from `scripts/check-data-testid.mjs` (Husky pre-commit, after
lint-staged). When any `src/client/**/*.tsx` file is staged (non-test), the
script scans the **entire staged file** for interactive UI missing
`data-testid`.

Do **not** commit or push unless the user explicitly asks.

## Required syntax (mandatory)

Always use the **object spread** form. Never write a kebab-case JSX attribute.

```tsx
// ✅ REQUIRED
<button type="button" {...{ 'data-testid': 'test-id-example' }}>…</button>
<button type="button" {...{ 'data-testid': `work-item-${id}` }}>…</button>
<button type="button" {...anchorTestIdProps('registry-key')}>…</button>

// ❌ FORBIDDEN — legacy kebab-case attributes (must be converted)
<button type="button" data-testid="test-id-example">…</button>
<button type="button" data-testid={`work-item-${id}`}>…</button>
<button type="button" data-testid={someExpr}>…</button>
```

Id **values** remain kebab-case (`test-id-example`). Only the JSX form changes.

## Preconditions

Run in parallel:

```bash
git status
git diff --cached --name-only --diff-filter=ACMR
node scripts/check-data-testid.mjs
```

**Hard stops:**

- No staged client TSX → tell the user to stage UI files first, then re-run.
- Do not edit protected files without explicit permission (see
  `scope-discipline`).
- Never use `--no-verify` to skip the hook.
- Prefer fixing ids over blanket `data-testid-exempt`.

## What the checker requires

**Source of truth:** `scripts/check-data-testid.mjs` (`REQUIRED_TAGS`, `COMPONENT_SUFFIX_RE`). Prefer that file over any abbreviated list.

Interactive elements that need a test id:

| Kind | Examples |
|------|----------|
| Intrinsic | `a`, `button`, `dialog`, `form`, `input`, `select`, `textarea` |
| Handler-driven | elements with `onClick`, `onSubmit`, `onChange`, `onKeyDown`, `onKeyUp`, `onPointerDown`, `onDoubleClick` |
| Role-driven | `role="button\|dialog\|tab\|…"`, etc. |
| Named UI components | names ending in `Button`, `Modal`, `Dialog`, `Drawer`, `Input`, `Select`, `Checkbox`, `Toggle`, `Switch`, `Tab`, `Menu`, `MenuItem`, `Dropdown`, `Popover`, `Tooltip`, `Form`, `Field`, `Panel`, `Card`, `Banner`, `Badge`, `Chip`, `Fab`, `Link`, `NavItem` |

Common misses: `<form>`, `*Panel`, `*Card`, `*Field`, and parent mounts of new interactive components in a touched file.

Accepted markers (spread only for new/fixed code):

- `{...{ 'data-testid': 'kebab-case-id' }}`
- `{...{ 'data-testid': dynamicExpression }}`
- `{...anchorTestIdProps('registry-key')}` (walkthrough anchors)

Escape hatch (rare, decorative only):

```tsx
{/* data-testid-exempt */}
<button type="button">…</button>
```

## Step 1 — Capture the violation list

```bash
node scripts/check-data-testid.mjs
```

Treat each `path:line  <Tag>  <snippet>` line as a work item. Fix **all**
reported lines in each touched file (the scan is whole-file).

## Step 2 — Convert legacy kebab-case attributes (mandatory)

In every staged client TSX file you touch (and any file reported by the
checker), **find all non-spread `data-testid` usages and rewrite them to
spread**. Do this even when the checker already passes — legacy attributes
must not remain on interactive (or landmark) elements you are editing.

### Conversion rules

| Old (forbidden) | New (required) |
|-----------------|----------------|
| `data-testid="foo-bar"` | `{...{ 'data-testid': 'foo-bar' }}` |
| `data-testid='foo-bar'` | `{...{ 'data-testid': 'foo-bar' }}` |
| `data-testid={\`foo-${id}\`}` | `{...{ 'data-testid': \`foo-${id}\` }}` |
| `data-testid={expr}` | `{...{ 'data-testid': expr }}` |

Search patterns to locate legacy forms in a file:

```bash
rg -n "data-testid\s*=" --glob "*.tsx" <file>
```

Skip matches that are already inside a spread object key string
(`'data-testid': …`) or inside `anchorTestIdProps`. Skip test files under
`__tests__` / `*.test.tsx` / `*.spec.tsx` unless the user asked to update
those selectors (queries still use `getByTestId('foo-bar')` —
DOM attribute name is unchanged).

Replace **every** legacy instance in the file (not only the lines the
checker reported). Preserve the id value exactly.

## Step 3 — Choose stable ids (for missing markers)

For each violation (element with no test id at all):

1. Prefer ids already listed in the feature design spec (`data-testid
   attributes` section) when this UI belongs to an in-flight feature.
2. Otherwise invent a **kebab-case** id that describes role + context:
   - Screen root: `prd-review`, `profile-page`
   - Control: `save-preferences-btn`, `avatar-remove-confirm`
   - State landmark: `assembly-lane-empty`, `notification-badge`
3. Keep ids stable across refactors (do not encode ephemeral layout).
4. For walkthrough targets, use `anchorTestIdProps` + registry key from
   `src/shared/walkthroughAnchors.ts` instead of duplicating literals.
5. Dynamic lists: include a stable suffix, e.g.
   `{...{ 'data-testid': \`work-item-${id}\` }}`.

## Step 4 — Apply fixes

- Add `{...{ 'data-testid': '…' }}` on the opening tag reported by the
  checker — never `data-testid="…"`.
- When touching an existing screen, also mark other interactive controls in
  that file that the checker lists — that is expected for touched files.
- Convert every legacy `data-testid=` attribute in those files to spread
  (Step 2).
- Update unit/E2E queries to use the new ids (`getByTestId` /
  `[data-testid="…"]`) when tests targeted the same controls via brittle
  selectors. Query strings stay the id value; only component JSX uses
  spread.
- Do not add test ids to SVG primitives, pure layout wrappers, or
  non-interactive text unless they are E2E landmarks (then prefer an
  explicit landmark id on a container).

## Step 5 — Verify and re-stage

```bash
node scripts/check-data-testid.mjs
# Confirm no leftover kebab-case attrs in fixed files:
rg -n "\bdata-testid\s*=" --glob "*.tsx" <fixed-client-tsx-paths>
git add -- <fixed-client-tsx-paths>
node scripts/check-data-testid.mjs
```

Exit code must be `0` before telling the user to retry the commit.
`rg` should find **no** `data-testid=` attribute assignments in fixed
production TSX (only `'data-testid':` inside spreads is fine).

Optional full hook smoke:

```bash
npx lint-staged
node scripts/check-data-testid.mjs
```

## Step 6 — Report

```
## data-testid pre-commit resolved

### Added / updated (spread)
- path:line — <Tag> → {...{ 'data-testid': '…' }}

### Converted from kebab-case attribute
- path:line — data-testid="…" → {...{ 'data-testid': '…' }}

### Exempted (must justify)
- path:line — reason

### Tests updated
- path — selector changes

### Status
Ready to retry commit | Needs operator decision on …
```

## Related

- ESLint / lint-staged failures → [`resolve-pre-commit-eslint`](../resolve-pre-commit-eslint/SKILL.md)
- Hook: `.husky/pre-commit` → `node scripts/check-data-testid.mjs`
- Policy script: `scripts/check-data-testid.mjs`
- Dev guidance: `.cursor/skills/dev-orchestrator/feature-executor.md` (F3.3)
