---
name: resolve-pre-commit-eslint
description: >-
  Fixes pre-commit / lint-staged ESLint errors and warnings on staged or
  touched TypeScript files so the Husky hook can pass (--max-warnings=0),
  without introducing breaking behavior changes. Use when the user says
  /resolve-pre-commit-eslint, pre-commit failed on ESLint, lint-staged
  blocked a commit, or they need errors and warnings cleared on staged
  src/{client,server,shared} files.
disable-model-invocation: true
---

# Resolve Pre-commit ESLint

Clear ESLint **errors and warnings** that block the Husky pre-commit hook
(`npx lint-staged` → ESLint with `--max-warnings=0` on staged
`src/{client,server,shared}/**/*.{ts,tsx}`).

**Hard rule — no breaking changes.** Lint cleanup must not change runtime
behavior, public APIs, contracts, auth/RBAC, data shapes, or user-visible
flows. If a fix might alter behavior — or you are unsure — **stop and ask
the user before editing**. Large files can surface many findings; never
“bulk rewrite” to silence them.

Do **not** commit or push unless the user explicitly asks.

## Preconditions

Run in parallel:

```bash
git status
git diff --cached --name-only --diff-filter=ACMR
```

**Hard stops:**

- No staged `.ts`/`.tsx` under `src/client`, `src/server`, or `src/shared` →
  tell the user to stage the files first, then re-run.
- Do not edit protected files without explicit permission:
  `vite.config.ts`, `src/server/index.ts`, `src/server/routes/auth.ts`,
  `.env.example`, `tsconfig*.json`, `jest.config.*`, `package.json`,
  CI/CD (`.github/`, `azure-pipelines.yml`, etc.), `.eslintrc.json`.
- Never use `--no-verify` / skip hooks to "fix" the commit.
- Never weaken ESLint config to silence the hook.

## Non-breaking policy (read before any edit)

### Safe to fix without asking (cosmetic / type-only)

Apply only when the change cannot alter runtime behavior:

| Kind | Examples |
|------|----------|
| Unused symbols | Remove truly unused imports/locals; prefix intentionally unused args with `_` |
| Type narrowing | Replace `any` with an existing precise type; add types that do not change emitted JS |
| Formatting / autofix | `eslint --fix` / `lint:fix` output that only rewrites style |
| Dead code that is clearly unreachable and unreferenced | Remove only when certain it is unused |

### Must ask the user before proceeding

Pause and present the concern (file, rule, proposed fix, risk) when **any** of
these apply:

| Concern | Examples |
|---------|----------|
| Behavior change | Changing `useEffect` / hook deps in a way that adds/removes runs; reordering effects; altering when state updates |
| Control flow | Removing a `console` that callers rely on in ops; deleting a catch path; changing early returns |
| API / contract | Renaming exports, props, route handlers, shared types used outside the file |
| Auth / security / RBAC | Anything near permissions, tokens, session, middleware |
| Data / persistence | Query shapes, migrations-adjacent code, serializers |
| Ambiguous unused | A “unused” variable/param that may be kept for API stability, future use, or intentional side effects |
| a11y that changes UX | Adding keyboard handlers, roles, or focus behavior that changes interaction (propose, then ask) |
| High volume / blast radius | **>15 findings in one file**, or fixes would touch **>3 files** with non-autofix edits — summarize and ask how to proceed (fix all safe / fix this file only / skip risky rules via narrow disable) |
| Unsure | Any doubt that the fix is behavior-preserving |

When asking, use a short decision block:

```
## ESLint fix needs confirmation

File: path:line
Rule: <rule-id>
Finding: <message>
Proposed fix: <1–2 sentences>
Risk: <why this might break behavior>
Options: (1) apply as proposed (2) narrow eslint-disable-next-line + comment (3) skip / leave for later
```

Do not apply the risky edit until the user chooses.

### Prefer disable over risky rewrite (when user agrees)

If the correct behavioral fix is unclear or large:

```tsx
// eslint-disable-next-line <rule> -- <why behavior must stay as-is>
```

Keep disables **single-line**, rule-specific, and commented. Prefer this over
a speculative refactor when the user wants the commit unblocked without
behavior change.

## Step 1 — Reproduce and triage

Prefer the same surface as pre-commit (staged files only):

```bash
npx lint-staged
```

Or ESLint on staged paths:

```bash
# PowerShell — adjust for bash as needed
$files = git diff --cached --name-only --diff-filter=ACMR |
  Where-Object { $_ -match '^src/(client|server|shared)/.+\.tsx?$' }
cross-env ESLINT_USE_FLAT_CONFIG=false npx eslint --max-warnings=0 @files
```

Capture every **error** and **warning**. Group into:

1. **Safe** — autofix / unused / pure types
2. **Needs confirmation** — anything in the ask table above
3. **Out of scope** — protected files, unrelated unstaged code

If group 2 is non-empty **or** volume is high, **ask before editing group 2**.
You may proceed with group 1 only after stating what you will autofix.

## Step 2 — Auto-fix what is safe

```bash
npm run lint:fix
```

Or ESLint `--fix` only on the staged paths from Step 1.

After autofix:

1. Skim the diff — if anything looks behavioral (logic, deps arrays with
   semantic meaning, JSX structure), **revert that hunk** and ask.
2. Re-stage only confirmed-safe paths:

```bash
git add -- <fixed-paths>
```

## Step 3 — Manual fixes (safe path only)

For each remaining **safe** diagnostic:

1. Open the file at the reported line.
2. Apply the smallest behavior-preserving fix.
3. Allowed without asking:
   - Prefix unused args/vars with `_`
   - Remove unused imports
   - Add precise types that do not change runtime
4. For `react-hooks/*`, `jsx-a11y/*`, control-flow, or anything ambiguous →
   **ask first** (see decision block). Do not “fix” hook deps by guessing.

Do not blanket-disable entire files or rules.

## Step 4 — Verify clean (and non-breaking)

Re-run until exit 0 on the lint surface:

```bash
npx lint-staged
```

Also sanity-check:

```bash
# If client files changed:
npx tsc -p tsconfig.client.json --noEmit
# If server/shared files changed:
npx tsc -p tsconfig.server.json --noEmit
```

If tests exist for the touched area and are quick to run, run them. A lint
pass that breaks `tsc` or tests is not done — fix or ask.

## Step 5 — Report

```
## ESLint pre-commit resolved

### Fixed (non-breaking)
- path:line — rule — what changed

### Auto-fixed
- paths touched by lint:fix

### Asked / waiting on user
- path:line — rule — risk summary

### Narrow disables (if any)
- path:line — rule — justification

### Still blocked
- path:line — rule — why

### Status
Ready to retry commit | Awaiting confirmation on N items | Needs operator decision on …
```

## Related

- Data-testid hook failures → [`resolve-pre-commit-data-testid`](../resolve-pre-commit-data-testid/SKILL.md)
- Hook definition: `.husky/pre-commit` → `npx lint-staged`
- Config: `.eslintrc.json` (do not edit without permission)
