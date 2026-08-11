---
name: resolve-theme-contrast
description: >-
  Fixes theme-contrast CI failures from scripts/ci/check-theme-contrast.mjs
  (npm run lint:theme-contrast). Replaces fixed light foregrounds on
  accent/success fills with var(--on-accent) or var(--on-success). Use when
  the user says /resolve-theme-contrast, validate fails on Lint (ESLint and
  theme contrast), or CI reports tokenized fills cannot use fixed light
  foregrounds.
disable-model-invocation: true
---

# Resolve Theme Contrast

Clear failures from `scripts/ci/check-theme-contrast.mjs` (CI validate job:
`Lint (ESLint and theme contrast)` → `npm run lint:theme-contrast`).

Bright themes (e.g. Ice) use near-white accents. Text/icons on accent or
success fills must use semantic foreground tokens — not fixed light colors.

Do **not** commit or push unless the user explicitly asks.

## Forbidden vs required

On any rule whose `background` / `background-color` includes a tokenized fill:

| Fill tokens | Required foreground |
|-------------|---------------------|
| `var(--accent-color)`, `var(--accent-hover)` | `var(--on-accent)` |
| `var(--success-color)`, `var(--success-hover)` | `var(--on-success)` |

**Forbidden** on those fills (`color`, `fill`, or `stroke`):

- `#fff` / `#ffffff` / `white`
- `rgba(255, 255, 255, …)`
- `var(--bg-primary)`
- `var(--brand-text-inverse)`

```css
/* ✅ REQUIRED */
.primary-button {
  color: var(--on-accent);
  background: var(--accent-color);
}

.success-badge {
  color: var(--on-success);
  background: var(--success-color);
}

/* ❌ FORBIDDEN */
.primary-button {
  color: var(--bg-primary); /* or #fff / white / brand-text-inverse */
  background: var(--accent-color);
}
```

SVG icons on these fills should use `currentColor` / `inherit` so they track
the parent semantic foreground.

## Preconditions

```bash
git status
node scripts/ci/check-theme-contrast.mjs
# or: npm run lint:theme-contrast
```

**Hard stops:**

- Do not edit protected files without explicit permission (see
  `scope-discipline`).
- Do not weaken or skip the checker (`scripts/ci/check-theme-contrast.mjs`,
  CI workflow, or package scripts) to make the job green.
- Prefer token swaps over hard-coded hex that “looks fine” in one theme.

## What the checker does

**Source of truth:** `scripts/ci/check-theme-contrast.mjs`.

- Scans all `src/client/**/*.css`
- For each CSS rule with accent/success tokenized backgrounds, flags
  `color` / `fill` / `stroke` values matching the fixed-light pattern above
- Prints: `file:line selector` then `property: value; use <expected>`

**Limitation:** same-rule only. It cannot see a light child on an
accent-filled parent. For nested icons/badges, prefer `currentColor` /
`inherit`.

**Noise note:** ESLint often reports thousands of **warnings** in the same
CI step. Exit code 1 from this job is usually theme-contrast (or real
ESLint **errors**), not the warning dump. Confirm with the script output
near the end of the log.

## Step 1 — Capture violations

```bash
node scripts/ci/check-theme-contrast.mjs
```

Treat each `path:line … use var(--on-accent)` (or `--on-success`) line as a
work item. Fix **all** reported violations.

## Step 2 — Apply token swaps

For each violation:

1. Open the reported CSS file at the given line/selector.
2. Replace the forbidden foreground with the expected token from the
   checker message (`var(--on-accent)` or `var(--on-success)`).
3. If icons use `fill`/`stroke` with a forbidden light value on the same
   accent/success rule, swap those too (or switch to `currentColor`).
4. Do not change the background tokens unless they are wrong for the
   component’s role.

## Step 3 — Verify

```bash
node scripts/ci/check-theme-contrast.mjs
```

Exit code must be `0` (`Theme contrast check passed (…)`) before telling
the user CI should pass this check.

## Step 4 — Report

```
## theme-contrast resolved

### Fixed
- path:line — selector — color/fill/stroke: <old> → <new>

### Status
Ready to commit/push | Needs operator decision on …
```

## Related

- Design tokens & filled-control rules → [`design-system`](../design-system/SKILL.md)
- ESLint / lint-staged failures → [`resolve-pre-commit-eslint`](../resolve-pre-commit-eslint/SKILL.md)
- Data-testid hook failures → [`resolve-pre-commit-data-testid`](../resolve-pre-commit-data-testid/SKILL.md)
- Checker: `scripts/ci/check-theme-contrast.mjs`
- npm: `npm run lint:theme-contrast`
