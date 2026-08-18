# MODE 2 — Feature Executor (one Feature)

`/dev-orchestrator feature {slug} FEAT-NNN` — or the default when this skill runs as `developmentSkillPath` (the session's `workItemId` maps to the Feature).

Implements exactly **one** Feature end-to-end using TDD.

**Git (Dev Workbench):** Never run `git commit` or `git push` — the Dev Workbench captures the diff and opens the PR via `finalisePush`.

**Local kickoff:** Also read [local-dev.md](local-dev.md) first and apply artifact-root / git / scope overrides.

**Before Phase F4:** Read [tdd-prompts.md](tdd-prompts.md) and paste the matching blocks into each subagent prompt.

## Phase F0 — Load Feature inputs (full work-item + design context)

**Do not proceed to F1 until every required input below is loaded and summarized.** Titles alone are insufficient.

Default paths use `.ai-pilot/output/` with `{slug}`-prefixed filenames. Under local kickoff, use `.ai-pilot/local-dev/{pack}/` and the **short fixed filenames** in [local-dev.md](local-dev.md) (`backlog.json`, `design-spec/design.md`, …).

### F0.1 — Backlog Feature + every associated item

1. Read `{root}/{slug}.backlog.json` — **required.** Locate the target Feature (`FEAT-NNN`).
2. Capture Feature-level fields: `id`, `title`, `description`, `affectedPersonas`, `outOfScope`, `dependsOn`, `featureFlag` (if present).
3. For **every** entry in `items[]` (PBIs **and** TBIs), extract the **full** work-item payload — not a summary:

**For each PBI, read and retain:**
- `id`, `title`, `priority`, `dependsOn`, `parallelGroup`
- `userStory` (`persona`, `iWant`, `soThat`)
- `businessRules[]` (every `BR-NNN` reference)
- `nonFunctionalRequirements` (`performance`, `accessibility`, `security`)
- `outOfScope[]`
- **`acceptanceCriteria[]` in full** — every `{ given, when, then }` object, preserving 0-based index (AC-0, AC-1, …). These are the primary TDD contracts for the PBI.
- `sizingNote`, `testCaseCount` when present

**For each TBI, read and retain:**
- `id`, `title`, `priority`, `dependsOn`, `parallelGroup`
- `description` (full text)
- `technicalDependencies[]`
- `nonFunctionalRequirements[]`
- **`definitionOfDone[]` in full** — every DoD bullet is a TDD contract for the TBI (DoD-0, DoD-1, …)

4. Also load **sibling items** in the same Feature that appear in any item's `dependsOn` (already in `items[]`) so cross-item contracts are available when dispatching.

**Stop conditions:**
- Missing backlog file → instruct operator to export, then re-run.
- Target Feature not found → stop and report.
- Any PBI missing `acceptanceCriteria` (or fewer than 4 entries) → stop; backlog is incomplete for TDD.
- Any TBI missing `definitionOfDone` (or fewer than 3 entries) → stop; backlog is incomplete for TDD.

### F0.2 — Design-spec trio for this Feature (required)

Resolve `{feature-slug}` from the Feature title (kebab-case, same convention as `/prd-design-spec`). Read **all three** files under `{root}/{slug}-design-spec/`:

| File | Use during implementation |
|------|---------------------------|
| `{feature-slug}-tech-spec.md` | APIs, data model, modules, sequences, error handling — primary engineering contract |
| `{feature-slug}-design.md` | UX flows, surfaces, states, copy, accessibility — primary UI contract for PBIs |
| `{feature-slug}-assumptions.md` | Defaults and open decisions — do not contradict without operator confirmation |

**If any of the three files is missing:** stop and tell the operator to run `/prd-design-spec {slug}` (or export the design-spec folder) before Feature Executor. Do not invent architecture or UX to fill gaps.

While reading, note sections that map to this Feature's items (routes, components, services, tables, endpoints, flag behavior). Those excerpts are pasted into subagent prompts in F4.

### F0.3 — Test cases (verification targets)

Read `{root}/{slug}.test-cases.json` when present. Filter to cases whose `traceability.pbiId` belongs to this Feature's PBIs. Keep `testCaseId`, `traceability.acceptanceCriteriaIndex`, `traceability.businessRules`, `automation.recommendedTier`, and expected behavior text.

- Test cases **enrich** AC coverage; they do **not** replace reading `acceptanceCriteria[]` from the backlog.
- If test-cases are absent, proceed using backlog AC/DoD + design specs only, and note "test-cases.json absent — AC/DoD are sole verification targets."

### F0.4 — Emit Work-Item Context Ledger (mandatory, before any code)

Print a visible ledger in chat (not only in tool thoughts). One block per item:

```
## Work-Item Context Ledger — {FEAT-NNN} {title}

### Design specs loaded
- tech-spec: {path} ✓
- design: {path} ✓
- assumptions: {path} ✓

### PBI-001 — {title}
User story: As {persona}, I want {iWant} so that {soThat}
Business rules: BR-001, …
NFRs: perf=…; a11y=…; security=…
Out of scope: …
AC-0: Given … / When … / Then …
AC-1: …
AC-2: …
AC-3: …
Linked test cases: TC-PBI-001-001 (AC-0, unit), … | deferred e2e: …
Design anchors: {section headings or 1–3 short quotes from design.md / tech-spec.md}

### TBI-001 — {title}
Description: …
Technical dependencies: …
NFRs: …
DoD-0: …
DoD-1: …
DoD-2: …
Design anchors: {section headings or quotes from tech-spec.md}
```

Do not dispatch subagents until this ledger is complete for **every** PBI and TBI in the Feature.

### F0.5 — Assumption gate (required before any code)

Read `{feature-slug}-assumptions.md`. For every item marked ⚠ (unresolved):

1. Classify it: **material** (affects behavior, security, data contract, or scope) vs **naming** (e.g. confirm a key literal against the live repo).
2. For **naming** items: resolve by inspecting the live repository files (`grep`, `read`) and proceed.
3. For **material** items: **stop** and surface them to the operator. Do not invent a resolution. Do not begin Phase F1 until each material item is either confirmed or explicitly waived by the operator.

Report resolved naming items inline. A material item blocked here must appear in the completion synopsis under "Assumptions resolved" or "Assumptions blocked."

## Phase F1 — Context Block

Read the applicable rules and skills, then build a **Context Block** and inject it verbatim into **every** subagent prompt.

**Rules to read** (`.cursor/rules/*.mdc`):
- `scope-discipline` — always applies; note protected files that would be touched.
- `typescript-typecheck` — applies to all `.ts`/`.tsx` changes.
- `react-coding-standards` — applies when client `.tsx` files are involved.
- `ui-design-standards` — applies when CSS or new components are involved.
- `postgresql-db` — applies when DB queries, schema, or migrations are involved.
- `rbac-governance` — applies when client UI features are added or removed.
- `feature-flags` — read when this Feature has a `featureFlag.name`; follow the top-level split pattern and add the required balanced `@feature-flag:<key>` markers around enabled and disabled branches so later cleanup is deterministic.

Output the block in this format:

```
## Context Block (inject into all subagent prompts)
Applicable rules: <comma-separated list>
Load these skills: <comma-separated list, or "none">
Feature flag: <yes — key `my-feature-key` | no>
Protected files requiring explicit permission: <list or "none">
Key existing files: <3-5 most relevant file paths>
Design specs: <paths to the three {feature-slug}-*.md files>
data-testid: <ids from design.md, or "n/a — no UI"> — spread `{...{ 'data-testid': 'kebab-id' }}`; match scripts/check-data-testid.mjs (form, *Panel, full suffix list); verify with `node scripts/check-data-testid.mjs` before done
Git policy: NO `git commit` / NO `git push`. The Dev Workbench captures the diff and opens the PR.
```

(For local kickoff, replace the Git policy line per [local-dev.md](local-dev.md).)

## Phase F2 — Build the execution DAG

First validate the backlog item completion graph:

- **Item nodes** = this Feature's `items[]` (PBIs + TBIs).
- **Item edges** = item `dependsOn`. If any reference resolves outside this Feature, stop and report an upstream decomposition error.
- Confirm the item graph is acyclic. Item dependencies remain completion constraints even when implementation tasks overlap.

Then inspect the Feature tech spec:

1. When it contains an `Implementation Plan` with uniquely identified steps and explicit blockers, **read and follow [multi-task-execution.md](multi-task-execution.md)**. Build the Task Context Ledger, task DAG, file-conflict-safe execution bundles, and topological waves. This is the preferred multi-task mode.
2. Treat written execution lanes as hints. Recalculate them from dependencies and coalesce tasks that would write the same source or test files.
3. When no executable implementation-step graph exists, fall back to the item DAG: `parallelGroup` is a parallel hint, and items with no unmet `dependsOn` form each wave.
4. If an implementation plan exists but is malformed or cannot be traced to backlog/design requirements, stop. Do not silently discard it or invent missing task contracts.

Print the selected execution mode and complete execution plan before proceeding to F3.

## Phase F3 — AC/DoD → Test Matrix + E2E

### F3.1 — Build the Requirements → Test Matrix

Before any RED tests are written, build a matrix covering **all** items in this Feature. Print it in chat:

```
## Requirements → Test Matrix — {FEAT-NNN}

| Item | Criterion | Task / verification owner | Source | Linked TC (if any) | Tier | Planned test or check | Status |
|------|-----------|---------------------------|--------|--------------------|------|-----------------------|--------|
| PBI-001 | AC-0 | S4 | backlog acceptanceCriteria[0] | TC-PBI-001-001 | unit | saves preference when toggled off | pending |
| PBI-001 | AC-1 | S4 | backlog acceptanceCriteria[1] | TC-PBI-001-002 | unit | reverts toggle and shows error on save failure | pending |
| TBI-001 | DoD-0 | S1 | backlog definitionOfDone[0] | — | check | migration creates notification_preferences | pending |
| … | … | … | … | … | … | … | … |
```

**Matrix rules:**
1. **Every** PBI `acceptanceCriteria[i]` gets ≥1 non-e2e automated test row (or an explicit deferral reason that is **not** "skipped for convenience").
2. **Every** TBI `definitionOfDone[j]` gets ≥1 automated test or a verifiable check (e.g. migration file exists + unit tests for API DoD lines).
3. Map `test-cases.json` rows onto AC indexes via `traceability.acceptanceCriteriaIndex` when present; if a TC adds coverage beyond an AC, add a matrix row tagged `source: test-case`.
4. Include testable `businessRules` and NFR rows when they imply observable behavior not already covered by an AC/DoD.
5. Respect Feature and item `outOfScope` — do not add matrix rows for out-of-scope behavior.
6. Design-spec decisions that refine an AC (route, status code, component state) must be reflected in the planned assertion, not ignored.
7. In multi-task mode, map every row to its enabling tasks and exactly one verification-owner task. Use `enabled` only for landed prerequisites and `covered` only after the owner assertion passes.

### F3.2 — E2E Playwright tests

Any test case (or matrix row) with `automation.recommendedTier === 'e2e-playwright'`:

- **Author the spec** under `e2e/` (or the project's Playwright folder) with `data-testid` selectors matching the design spec.
- **Defer execution** only when a Playwright environment is demonstrably unavailable (no browser binaries, CI-only config). Append a `// DEFERRED: Playwright env unavailable` comment to the skipped `test.skip(...)` block and record it in `deferredE2E[]`.
- Do **not** defer authoring. A deferred spec must still be written and syntactically valid.

**Coverage gate:** An AC that has only e2e test cases must still have a unit/integration RED test derived from the Given/When/Then. E2E deferral must not leave an AC entirely untested.

Report the deferred list at the end of the Feature Executor run.

### F3.3 — `data-testid` on UI (mandatory for client work)

Pre-commit runs `scripts/check-data-testid.mjs` on staged client TSX under `src/client/` (non-test). When a file is staged, **every** interactive element in that file must have `data-testid` — missing ids on existing controls in a touched file fail the commit. Resolve with `/resolve-pre-commit-data-testid`.

**Source of truth:** `scripts/check-data-testid.mjs` (`REQUIRED_TAGS`, `COMPONENT_SUFFIX_RE`, handler/role heuristics). Do **not** invent a shorter suffix list in prompts — if the script and this skill disagree, follow the script.

**Required syntax (spread — not kebab-case JSX attribute):**

```tsx
// ✅ REQUIRED
<button type="button" {...{ 'data-testid': 'test-id-example' }}>…</button>
<button type="button" {...{ 'data-testid': `work-item-${id}` }}>…</button>
<button type="button" {...anchorTestIdProps('registry-key')}>…</button>

// ❌ FORBIDDEN — do not write kebab-case attributes
<button type="button" data-testid="test-id-example">…</button>
<button type="button" data-testid={`work-item-${id}`}>…</button>
```

Id **values** stay kebab-case (`test-id-example`); only the JSX form must be the object spread.

**Elements that always need a test id (mirror the script):**

| Kind | Must mark |
|------|-----------|
| Intrinsic tags | `a`, `button`, `dialog`, `form`, `input`, `select`, `textarea` |
| Handler-driven | any element with `onClick` / `onSubmit` / `onChange` / `onKeyDown` / `onKeyUp` / `onPointerDown` / `onDoubleClick` |
| Role-driven | interactive `role=` values the script matches (button, link, dialog, tab, …) |
| PascalCase suffixes | names ending in `Button`, `Modal`, `Dialog`, `Drawer`, `Input`, `Select`, `Checkbox`, `Toggle`, `Switch`, `Tab`, `Menu`, `MenuItem`, `Dropdown`, `Popover`, `Tooltip`, `Form`, `Field`, `Panel`, `Card`, `Banner`, `Badge`, `Chip`, `Fab`, `Link`, `NavItem` |

Common misses that fail commits: `<form>`, `*Panel`, `*Card`, `*Field`, mounting custom interactive children in a touched parent file.

When the Feature (or any PBI) touches UI:

1. From `{feature-slug}-design.md`, copy the **data-testid attributes** list into the Context Block and every client subagent prompt.
2. **New screens / components:** put `{...{ 'data-testid': 'kebab-id' }}` on the screen root, primary landmarks (empty/error/loading containers used in tests), and every element matching the table above (including `form` and `*Panel`).
3. **Existing / touched screens:** before claiming GREEN, ensure **all** interactive controls in that file have a spread `data-testid` (pre-commit scans the whole file). Convert any legacy `data-testid="…"` / `data-testid={…}` attributes on touched elements to the spread form in the same change.
4. Prefer design-spec ids verbatim. If the design spec omitted an id for a control you add, invent a stable kebab-case id and note it in the completion synopsis under Files changed.
5. Escape hatch only for non-testable decorative markup: `// data-testid-exempt` on the line above the tag (rare).
6. **Verify (mandatory for client work):** stage or pass the touched client TSX paths, then run `node scripts/check-data-testid.mjs` and fix until exit 0. Do not treat “ids look complete” as done.

## Phase F4 — Dispatch execution waves with TDD

For each wave:

- **Multi-task mode:** dispatch one subagent per conflict-safe execution bundle. Different bundles in the same wave run in parallel; tasks coalesced because they touch the same source/test files have one writer.
- **Item fallback mode:** dispatch one subagent per item; items in the same wave run in parallel.

Each subagent prompt **must** include every task in its bundle, full owning-item contracts, design anchors, matrix rows, expected files, and cross-task contracts — not a one-line goal.

**Read and paste from [tdd-prompts.md](tdd-prompts.md):**
1. Subagent execution-bundle template
2. AC/DoD binding rules
3. The TDD block for every layer the bundle touches (server / client / shared-types)

## Phase F5 — Lean intermediate wave gate

The parent executor owns type-check, data-testid, and ESLint commands. Execution-bundle subagents run only the focused RED and GREEN tests/checks assigned to them. Do not rerun a successful command unless subsequent edits could invalidate its result.

After all subagents in a **non-final** wave complete:

1. Run one aggregate focused Jest invocation per Jest project covering the wave's **exact** new or changed test file paths:
   ```bash
   # Server tests in this wave (omit if none)
   npx jest --selectProjects server --no-coverage -- <exact server test files>

   # Client tests in this wave (omit if none)
   npx jest --selectProjects client --no-coverage -- <exact client test files>
   ```
   Pass literal paths, not `--testPathPattern`. Do not use `--runInBand`. Do not boot both projects unless the wave has files in both. Do not separately rerun each already-green test file.
2. **AC/DoD coverage check:** Confirm every matrix row owned by a task in this wave has a corresponding passing test/check (by criterion id in the test name/description or an explicit mapping in the synopsis). Enabling-only rows may become `enabled`, never `covered`. If any due row is uncovered, treat it as a gate failure.
3. Determine whether a later wave consumes a TypeScript contract produced by this wave:
   - Server-only contract → run `npx tsc -p tsconfig.server.json --noEmit`.
   - Client-only contract → run `npx tsc -p tsconfig.client.json --noEmit`.
   - Shared contract consumed by both → run both configs.
   - Documentation, SQL-only migration, or terminal implementation with no downstream consumer → defer type-check to F6.
4. If a check fails, diagnose and fix it, then rerun only the failed command and any focused test directly affected by the fix. Do not restart the entire gate.
5. In multi-task mode, update the Task Context Ledger and verify that newly unlocked tasks consume only completed outputs.
6. Dispatch the next wave only after its required aggregate tests, matrix coverage, and any downstream-contract type-check pass.

For the final wave, skip this intermediate gate and run the F6 final gate instead; never run both gates for the same wave.

Report after each intermediate gate:
> "Execution wave N complete. Focused tests/checks: ✓. AC/DoD matrix: ✓. Boundary type-check: ✓ | deferred | n/a. Proceeding to wave N+1."

## Phase F6 — Feature completion

When the last execution wave completes, run one final verification gate:

1. Run each applicable TypeScript config once based on all files touched by the Feature:
   ```bash
   # Server or shared-server changes
   npx tsc -p tsconfig.server.json --noEmit

   # Client or shared-client changes
   npx tsc -p tsconfig.client.json --noEmit
   ```
   Run both only when both compilation domains are affected.
2. Run one impacted-test command **per Jest project** covering all new and directly related changed test **file paths** across the Feature (same `npx jest --selectProjects … --no-coverage -- <files>` shape as F5). Do not use `--testPathPattern` or `--runInBand`. Do not run the full repository suite here; `build-test-push` owns the final build and full regression suite.
3. Run pre-commit gates once for all touched client/shared/server TS|TSX:
   ```bash
   # data-testid — stage touched client TSX first (checker reads the index)
   git add -- <touched-src-client-tsx>
   node scripts/check-data-testid.mjs

   # ESLint — blocking errors only
   cross-env ESLINT_USE_FLAT_CONFIG=false npx eslint --max-warnings=-1 <touched-ts-tsx-paths>
   ```
   Skip data-testid when no client TSX changed. Fix blocking errors without expanding scope to unrelated warnings. After a fix, rerun only the failed gate and directly affected focused tests.
4. Confirm every non-deferred verification target has a passing test.
5. Confirm every PBI AC and every TBI DoD in the Requirements → Test Matrix is `covered` (or explicitly deferred e2e **with** a lower-tier substitute where required by F3.2).
6. List deferred e2e cases (skipped by design).
7. Run the **Quality-gate checklist** below.
8. **Verify all tasks and items are implemented.** In multi-task mode, account for every tech-spec implementation step. Cross-reference every PBI and TBI in this Feature's `items[]` against the files you created or modified **and** against the matrix. If any task is incomplete, item has no corresponding implementation, or criterion is uncovered, **go back and implement it before proceeding**.
9. **Stop.** Do **not** commit or push — Dev Workbench owns `finalisePush` (or the operator owns git in local mode).

**MANDATORY — post a completion synopsis.** You MUST end your run with a visible chat message (not just tool calls). The synopsis must include:

```
## Implementation Synopsis

### Completed items
- [PBI/TBI-ID] Title — files created/modified
  - AC/DoD coverage: AC-0 ✓, AC-1 ✓, … (or DoD-0 ✓, …)
- ...

### Completed implementation tasks
- [S1] Goal — owning item(s); verification/check ✓
- ...

### Requirements → Test Matrix (final)
- [Item] [Criterion] → [test name] — PASS | DEFERRED e2e

### Deferred (e2e)
- [TC-ID] — reason (lower-tier substitute: [test name] | n/a)

### Design specs consulted
- {feature-slug}-tech-spec.md, -design.md, -assumptions.md

### Assumptions resolved / blocked
- …

### Items NOT implemented (if any)
- [PBI/TBI-ID] Title — reason (should be empty if all items are done)

### Files changed
- path/to/file.ts (new | modified)
- ...

### Status
Feature is implementation-complete and ready for diff capture.
```

**CRITICAL:** Never end a run with only tool calls and no final text. The user must always see a summary of what was implemented.

## Quality-gate checklist

Copy and track per Feature Executor run:

```
[ ] Feature inputs loaded: full PBI fields (incl. every acceptanceCriteria Given/When/Then) and full TBI fields (incl. every definitionOfDone)
[ ] Design-spec trio loaded for this Feature (tech-spec + design + assumptions) — stopped if missing
[ ] Work-Item Context Ledger printed before any code
[ ] Assumption gate (F0.5) passed: ⚠ naming items resolved against live repo; material items confirmed or waived by operator
[ ] Requirements → Test Matrix built (every AC + every DoD + linked non-e2e TCs)
[ ] Context Block produced and injected into every subagent prompt (includes design-spec paths)
[ ] Backlog item completion DAG built and verified self-contained
[ ] Tech-spec Implementation Plan evaluated: multi-task DAG + Task Context Ledger + conflict-safe bundles used, or item fallback explicitly justified because no step graph exists
[ ] Every task maps to owning items + requirements/design/VT; every criterion/VT has exactly one verification owner
[ ] Parallel bundles have non-overlapping writes; same-file tasks coalesced under one writer
[ ] e2e-playwright test cases: specs AUTHORED; execution DEFERRED only when Playwright environment is unavailable; AC still covered at unit/integration
[ ] data-testid: new/touched interactive UI matches `scripts/check-data-testid.mjs` (incl. `form`, `*Panel`, full suffix list); spread syntax only; `node scripts/check-data-testid.mjs` exited 0 on staged client TSX
[ ] eslint: touched staged TS/TSX have no ESLint **errors** (warnings optional unless operator requires; do not boil ocean on unrelated files)
[ ] Every subagent prompt included its complete task bundle + verbatim owning-item contracts + design-spec anchors + matrix rows (from tdd-prompts.md)
[ ] Every verification-owner task followed RED → GREEN with tests bound to AC-/DoD-/VT ids; post-GREEN tests reran only when later edits could invalidate them
[ ] Verification targets from test-cases.json traceability satisfied (non-e2e)
[ ] Each non-final wave passed one aggregate focused-test per Jest project (exact file paths, `--selectProjects`, no `--testPathPattern` / `--runInBand`) + AC/DoD gate; `tsc` ran only when a later wave consumed that TypeScript contract
[ ] Final gate ran once: applicable `tsc` config(s), one impacted-test command per Jest project, and data-testid/eslint when applicable
[ ] Every tech-spec implementation task is complete (multi-task mode)
[ ] ALL PBIs AND TBIs in this Feature's items[] have corresponding implementation AND criterion coverage
[ ] No protected files modified without explicit permission
[ ] NO `git commit` / NO `git push` performed
[ ] Completion synopsis posted as a visible chat message (includes final matrix + design specs consulted + assumptions resolved/blocked)
```
