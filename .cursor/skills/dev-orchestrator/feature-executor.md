# MODE 2 — Feature Executor (one Feature)

`/dev-orchestrator feature {slug} FEAT-NNN` — or the default when this skill runs as `developmentSkillPath` (the session's `workItemId` maps to the Feature).

Implements exactly **one** Feature end-to-end using TDD.

**Git (Dev Workbench):** Never run `git commit` or `git push` — the Dev Workbench captures the diff and opens the PR via `finalisePush`.

**Local kickoff:** Also read [local-dev.md](local-dev.md) first and apply artifact-root / git / scope overrides.

**Before Phase F4:** Read [tdd-prompts.md](tdd-prompts.md) and paste the matching blocks into each subagent prompt.

## Phase F0 — Load Feature inputs (full work-item + design context)

**Do not proceed to F1 until every required input below is loaded and summarized.** Titles alone are insufficient.

Default paths use `.ai-pilot/output/`. Under local kickoff, use `.ai-pilot/local-dev/{slug}/` per [local-dev.md](local-dev.md).

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
- `feature-flags` — read when this Feature has a `featureFlag.name`; follow the top-level split pattern.

Output the block in this format:

```
## Context Block (inject into all subagent prompts)
Applicable rules: <comma-separated list>
Load these skills: <comma-separated list, or "none">
Feature flag: <yes — key `my-feature-key` | no>
Protected files requiring explicit permission: <list or "none">
Key existing files: <3-5 most relevant file paths>
Design specs: <paths to the three {feature-slug}-*.md files>
Git policy: NO `git commit` / NO `git push`. The Dev Workbench captures the diff and opens the PR.
```

(For local kickoff, replace the Git policy line per [local-dev.md](local-dev.md).)

## Phase F2 — Build the inner (item) DAG

- **Nodes** = this Feature's `items[]` (PBIs + TBIs).
- **Edges** = item `dependsOn` (guaranteed self-contained — every referenced ID resolves to an item in **this** Feature). If any `dependsOn` references an item outside this Feature, stop and report it as an upstream decomposition error (the `/prd-spec-review` gate should have caught it).
- **Parallel hints** = `parallelGroup`; items sharing a `parallelGroup` label are safe to run together.
- Validate the item graph is a DAG. Topo-sort into **inner waves**: items with no unmet `dependsOn` form the first inner wave; each subsequent wave unlocks once its predecessors pass the wave gate.

## Phase F3 — AC/DoD → Test Matrix + E2E

### F3.1 — Build the Requirements → Test Matrix

Before any RED tests are written, build a matrix covering **all** items in this Feature. Print it in chat:

```
## Requirements → Test Matrix — {FEAT-NNN}

| Item | Criterion | Source | Linked TC (if any) | Tier | Planned test name | Status |
|------|-----------|--------|--------------------|------|-------------------|--------|
| PBI-001 | AC-0 | backlog acceptanceCriteria[0] | TC-PBI-001-001 | unit | saves preference when toggled off | pending |
| PBI-001 | AC-1 | backlog acceptanceCriteria[1] | TC-PBI-001-002 | unit | reverts toggle and shows error on save failure | pending |
| TBI-001 | DoD-0 | backlog definitionOfDone[0] | — | unit | migration creates notification_preferences | pending |
| … | … | … | … | … | … | … |
```

**Matrix rules:**
1. **Every** PBI `acceptanceCriteria[i]` gets ≥1 non-e2e automated test row (or an explicit deferral reason that is **not** "skipped for convenience").
2. **Every** TBI `definitionOfDone[j]` gets ≥1 automated test or a verifiable check (e.g. migration file exists + unit tests for API DoD lines).
3. Map `test-cases.json` rows onto AC indexes via `traceability.acceptanceCriteriaIndex` when present; if a TC adds coverage beyond an AC, add a matrix row tagged `source: test-case`.
4. Include testable `businessRules` and NFR rows when they imply observable behavior not already covered by an AC/DoD.
5. Respect Feature and item `outOfScope` — do not add matrix rows for out-of-scope behavior.
6. Design-spec decisions that refine an AC (route, status code, component state) must be reflected in the planned assertion, not ignored.

### F3.2 — E2E Playwright tests

Any test case (or matrix row) with `automation.recommendedTier === 'e2e-playwright'`:

- **Author the spec** under `e2e/` (or the project's Playwright folder) with `data-testid` selectors matching the design spec.
- **Defer execution** only when a Playwright environment is demonstrably unavailable (no browser binaries, CI-only config). Append a `// DEFERRED: Playwright env unavailable` comment to the skipped `test.skip(...)` block and record it in `deferredE2E[]`.
- Do **not** defer authoring. A deferred spec must still be written and syntactically valid.

**Coverage gate:** An AC that has only e2e test cases must still have a unit/integration RED test derived from the Given/When/Then. E2E deferral must not leave an AC entirely untested.

Report the deferred list at the end of the Feature Executor run.

## Phase F4 — Dispatch inner waves with TDD

For each inner wave, dispatch one subagent per item (items in the same wave run in parallel). Each subagent prompt **must** include the full work-item contract and design anchors — not a one-line goal.

**Read and paste from [tdd-prompts.md](tdd-prompts.md):**
1. Subagent task template
2. AC/DoD binding rules
3. The TDD block for the item's layer (server / client / shared-types)

## Phase F5 — Inner-wave verification gate

After all subagents in an inner wave complete, the executor (you, in the parent session) must:

1. Run type-check for all affected configs:
   ```bash
   npx tsc -p tsconfig.server.json --noEmit
   npx tsc -p tsconfig.client.json --noEmit
   ```
2. Run tests for the wave's new test files:
   ```bash
   npm test -- --testPathPattern="<pattern covering this wave's new files>"
   ```
3. **AC/DoD coverage check:** For each item in the wave, confirm every non-deferred matrix row has a corresponding passing test (by criterion id in the test name/description or an explicit mapping in the synopsis). If any AC/DoD is uncovered, treat it as a gate failure — write the missing RED test and fix before continuing.
4. If failures: diagnose, fix inline or dispatch a targeted fix subagent, then re-run.
5. Only after type-check, tests, and matrix coverage pass: dispatch the next inner wave.

Report after each inner-wave gate:
> "Inner wave N complete. Type-check: ✓. Tests: ✓. AC/DoD matrix: ✓. Proceeding to inner wave N+1."

## Phase F6 — Feature completion

When the last inner wave passes its gate:

1. Confirm every non-deferred verification target has a passing test.
2. Confirm every PBI AC and every TBI DoD in the Requirements → Test Matrix is `covered` (or explicitly deferred e2e **with** a lower-tier substitute where required by F3.2).
3. List deferred e2e cases (skipped by design).
4. Run the **Quality-gate checklist** below.
5. **Verify all items are implemented.** Cross-reference every PBI and TBI in this Feature's `items[]` against the files you created or modified **and** against the matrix. If any item has no corresponding implementation or uncovered criterion, **go back and implement it before proceeding** — do not skip PBIs (frontend) in favor of TBIs (backend) or vice versa. A Feature is not complete until all its items and criteria are accounted for.
6. **Stop.** Do **not** commit or push — Dev Workbench owns `finalisePush` (or the operator owns git in local mode).

**MANDATORY — post a completion synopsis.** You MUST end your run with a visible chat message (not just tool calls). The synopsis must include:

```
## Implementation Synopsis

### Completed items
- [PBI/TBI-ID] Title — files created/modified
  - AC/DoD coverage: AC-0 ✓, AC-1 ✓, … (or DoD-0 ✓, …)
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
[ ] Inner item DAG built from item.dependsOn (verified self-contained) + parallelGroup
[ ] e2e-playwright test cases: specs AUTHORED; execution DEFERRED only when Playwright environment is unavailable; AC still covered at unit/integration
[ ] Every subagent prompt included verbatim work-item contract + design-spec anchors + matrix rows (from tdd-prompts.md)
[ ] Every item followed RED → GREEN → REFACTOR → tsc with tests bound to AC-/DoD- ids
[ ] Verification targets from test-cases.json traceability satisfied (non-e2e)
[ ] Inner-wave gate passed (tsc + jest + AC/DoD matrix coverage) before each subsequent wave
[ ] ALL PBIs AND TBIs in this Feature's items[] have corresponding implementation AND criterion coverage
[ ] No protected files modified without explicit permission
[ ] NO `git commit` / NO `git push` performed
[ ] Completion synopsis posted as a visible chat message (includes final matrix + design specs consulted + assumptions resolved/blocked)
```
