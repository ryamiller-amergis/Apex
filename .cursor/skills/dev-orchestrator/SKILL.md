---
name: dev-orchestrator
description: Lean orchestrator that turns a reviewed to-prd backlog into an ordered, TDD-driven implementation plan. Coordinator mode topo-sorts Features by feature.dependsOn and batches them by implementationPhases into waves (planning only, no code). Feature Executor mode loads full PBI/TBI context (acceptance criteria, definition of done, BRs, NFRs) plus the Feature's design-spec trio, builds an AC→test matrix, and runs a self-contained item DAG with TDD Red-Green that asserts every criterion. Use when the user says /dev-orchestrator plan {slug}, /dev-orchestrator feature {slug} FEAT-NNN, or when this skill is wired as the developmentSkillPath.
disable-model-invocation: true
---

# Dev Orchestrator (lean)

Turns a **reviewed** `to-prd` backlog into implementation. Two modes:

- **Coordinator** — PRD-level planning only. Orders Features into execution **waves**. Emits `.ai-pilot/output/{slug}.dev-plan.json`. **No code changes.**
- **Feature Executor** — implements **one** Feature inside a Dev Workbench `mode: 'development'` session, running that Feature's self-contained item DAG with TDD Red-Green **driven by every PBI acceptance criterion, every TBI definition-of-done item, and the Feature's design-spec files**.

This skill assumes **dependency locality is already enforced upstream** by `/to-prd` (generation) and `/prd-spec-review` (hard gate): item-level `dependsOn` never crosses a Feature boundary, and every cross-Feature relationship is a `feature.dependsOn` edge. Because of that guarantee this orchestrator carries **no elevation rule and no item-level cross-feature graph** — each Feature's item DAG is guaranteed self-contained.

**Hard rule — requirements fidelity:** Feature Executor must not implement from titles/goals alone. Every RED test and every GREEN behavior must trace to a concrete backlog field (`acceptanceCriteria[]`, `definitionOfDone[]`, `businessRules`, NFRs) and/or an explicit design-spec decision. If those inputs are missing, **stop** and ask the operator to export/generate them — do not invent criteria.

**Pipeline position:**

```
/to-prd → /prd-design-spec → /create-test-case → dev-orchestrator → build-test-push
```

---

## Mode selection

| Invocation | Mode |
|------------|------|
| `/dev-orchestrator plan {slug}` | **Coordinator** |
| `/dev-orchestrator feature {slug} FEAT-NNN` | **Feature Executor** (explicit) |
| Invoked as the project's `developmentSkillPath` (Dev Workbench `mode: 'development'`) | **Feature Executor** (default) — the session's `workItemId` identifies the Feature |

When invoked with no arguments and no development-session context, ask which mode is intended; do not guess.

---

# MODE 1 — Coordinator (planning only, NO code changes)

`/dev-orchestrator plan {slug}`

Produces an ordered wave plan across the whole PRD. This mode **never edits source, never writes tests, never runs a build**. It only reads inputs and writes the plan artifact.

## Phase C0 — Load inputs

Read each of the following. The canonical store for backlogs is the `prds.backlog_json` column in Postgres — the file-based inputs below are exported projections.

1. `.ai-pilot/output/{slug}.backlog.json` — **required.** Source of Features, `feature.dependsOn`, and `implementationPhases`.
2. `.ai-pilot/output/{slug}.test-cases.json` — **optional.** Used to catalog deferred e2e coverage (see Phase C3).
3. Per-Feature design specs under `.ai-pilot/output/{slug}-design-spec/` (`{feature-slug}-tech-spec.md`, `-design.md`, `-assumptions.md`) — optional for Coordinator (planning only); **required for Feature Executor** (see Phase F0).
4. `.cursor/skills/dev-orchestrator/dev-plan-schema.json` — the output contract to self-validate against.

**If the file inputs are absent:** the canonical backlog lives in `prds.backlog_json` (Postgres). Instruct the operator to export the backlog (and test-cases, if available) to `.ai-pilot/output/{slug}.backlog.json` (and `.test-cases.json`) first, then re-run. Do not attempt to read the database directly from this skill.

## Phase C1 — Build the Feature DAG

- **Nodes** = Features (`epics[].features[]`). Capture `id` (FEAT-NNN), `title`, parent epic `title`.
- **Edges** = `feature.dependsOn` **only**. No item-level edges are ever elevated — item `dependsOn` is intra-Feature by construction and is irrelevant to Feature ordering.
- Assign each Feature its `phase` from `implementationPhases` (the phase whose `epics` array contains this Feature's parent epic).
- Validate the edge set is a **DAG** (no cycles). If a cycle exists, stop and report the offending edges.
- If any `feature.dependsOn` references a non-existent `FEAT-NNN`, stop and report the dangling reference.

## Phase C2 — Topo-sort and batch into waves

1. Topologically sort Features by `feature.dependsOn`.
2. Batch into **waves** primarily by `implementationPhases` (phase 1 → wave(s) first, etc.). Within a phase, Features with no unmet `dependsOn` edge to another Feature in the same phase may share a wave; a Feature whose upstream sits in the same phase moves to a later wave in that phase.
3. **Cross-check phases vs the Feature DAG and flag conflicts.** If Feature A `dependsOn` Feature B but A's phase ≤ B's phase, that is a **phase/DAG conflict** — record it in `conflicts[]` with both IDs and their phases. The DAG edge is authoritative for ordering; the phase mismatch is surfaced for the operator to reconcile in `/to-prd`.
4. **Sync points = wave boundaries.** A downstream Feature's branch is cut only **after** all upstream Features it depends on have merged. Each wave boundary is one sync point.

## Phase C3 — Catalog deferred e2e

If `.test-cases.json` is present, collect every test case where `automation.recommendedTier === 'e2e-playwright'`. These are **not executed** by the Feature Executor; they are cataloged and skipped with a "deferred: e2e" note. Record each in the plan's `deferredE2E[]` with its `testCaseId`, `pbiId`, and owning `featureId`.

## Phase C4 — Emit the plan

1. Write `.ai-pilot/output/{slug}.dev-plan.json`. It **must validate** against `dev-plan-schema.json` (draft-07, `additionalProperties: false`). Use `dev-plan-example.json` as the shape reference.
2. Print a **human-readable wave summary** to the operator:

```
Dev plan — {slug}
Wave 1 (sync point → merge before Wave 2):
  - FEAT-001  Foundations: shared types & API   [Epic: Platform, Phase 1]
Wave 2 (sync point → merge before Wave 3):
  - FEAT-002  Notification preferences UI        [Epic: Notifications, Phase 2]  depends on FEAT-001
  - FEAT-003  Notification delivery service      [Epic: Notifications, Phase 2]  depends on FEAT-001
Conflicts: none
Deferred (e2e): TC-PBI-004-002 (PBI-004, FEAT-003)
```

3. Coordinator stops here. It **does not** dispatch executors or touch code. The operator runs each Feature through Mode 2 (typically one Dev Workbench session per Feature, in wave order).

---

# MODE 2 — Feature Executor (one Feature, inside a Dev Workbench development session)

`/dev-orchestrator feature {slug} FEAT-NNN` — or the default when this skill runs as `developmentSkillPath` (the session's `workItemId` maps to the Feature).

Implements exactly **one** Feature end-to-end using TDD. Runs inside a Dev Workbench `mode: 'development'` session, which owns the branch and the eventual PR. **Never run `git commit` or `git push`** — the Dev Workbench captures the diff and opens the PR via `finalisePush`.

## Phase F0 — Load Feature inputs (full work-item + design context)

**Do not proceed to F1 until every required input below is loaded and summarized.** Titles alone are insufficient.

### F0.1 — Backlog Feature + every associated item

1. Read `.ai-pilot/output/{slug}.backlog.json` — **required.** Locate the target Feature (`FEAT-NNN`).
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

Resolve `{feature-slug}` from the Feature title (kebab-case, same convention as `/prd-design-spec`). Read **all three** files under `.ai-pilot/output/{slug}-design-spec/`:

| File | Use during implementation |
|------|---------------------------|
| `{feature-slug}-tech-spec.md` | APIs, data model, modules, sequences, error handling — primary engineering contract |
| `{feature-slug}-design.md` | UX flows, surfaces, states, copy, accessibility — primary UI contract for PBIs |
| `{feature-slug}-assumptions.md` | Defaults and open decisions — do not contradict without operator confirmation |

**If any of the three files is missing:** stop and tell the operator to run `/prd-design-spec {slug}` (or export the design-spec folder) before Feature Executor. Do not invent architecture or UX to fill gaps.

While reading, note sections that map to this Feature's items (routes, components, services, tables, endpoints, flag behavior). Those excerpts are pasted into subagent prompts in F4.

### F0.3 — Test cases (verification targets)

Read `.ai-pilot/output/{slug}.test-cases.json` when present. Filter to cases whose `traceability.pbiId` belongs to this Feature's PBIs. Keep `testCaseId`, `traceability.acceptanceCriteriaIndex`, `traceability.businessRules`, `automation.recommendedTier`, and expected behavior text.

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

## Phase F1 — Context Block (from kick-off Phase 2)

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

## Phase F2 — Build the inner (item) DAG

- **Nodes** = this Feature's `items[]` (PBIs + TBIs).
- **Edges** = item `dependsOn` (guaranteed self-contained — every referenced ID resolves to an item in **this** Feature). If any `dependsOn` references an item outside this Feature, stop and report it as an upstream decomposition error (the `/prd-spec-review` gate should have caught it).
- **Parallel hints** = `parallelGroup`; items sharing a `parallelGroup` label are safe to run together.
- Validate the item graph is a DAG. Topo-sort into **inner waves**: items with no unmet `dependsOn` form the first inner wave; each subsequent wave unlocks once its predecessors pass the wave gate.

## Phase F3 — AC/DoD → Test Matrix + defer e2e

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

### F3.2 — Catalog & defer e2e

Any test case (or matrix row) with `automation.recommendedTier === 'e2e-playwright'` is **cataloged and skipped** with a "deferred: e2e" note. Do not author or run Playwright specs. Report the deferred list at the end. All other tiers (`unit`, `integration`, `manual`-where-automatable) are in scope for TDD.

**Coverage gate:** If a PBI AC has **only** e2e-linked test cases and no unit/integration alternative, still author a unit/integration RED test from the AC's Given/When/Then (and design-spec detail). E2e deferral must not leave an AC untested at a lower tier.

## Phase F4 — Dispatch inner waves with TDD

For each inner wave, dispatch one subagent per item (items in the same wave run in parallel). Each subagent prompt **must** include the full work-item contract and design anchors — not a one-line goal.

Use this structure:

```
## Task: <item id> — <item title>

### Goal
<1-2 sentences: the deliverable for this PBI/TBI>

### Full work-item contract (from backlog — paste verbatim fields)
<For PBI: userStory, businessRules, NFRs, outOfScope, and EVERY acceptanceCriteria entry as AC-N: Given/When/Then>
<For TBI: description, technicalDependencies, NFRs, and EVERY definitionOfDone entry as DoD-N: …>

### Design-spec anchors (excerpts — do not paraphrase away constraints)
From {feature-slug}-tech-spec.md:
<relevant sections: data model, API, modules, errors, flag behavior>
From {feature-slug}-design.md:   (required for PBIs; include for TBIs when UI-adjacent)
<relevant UX flows, states, a11y>
From {feature-slug}-assumptions.md:
<assumptions that constrain this item>

### Requirements → Test Matrix rows for this item
<table rows for this item only — each AC/DoD must appear>

### Files to create or edit
<explicit list — no others unless unavoidable; align with tech-spec module/file guidance>

### Verification targets (from test-cases.json)
<the test cases whose traceability.pbiId maps to this item, by id + acceptanceCriteriaIndex>
<e2e-playwright cases are DEFERRED — do not implement them>
<Reminder: backlog AC/DoD remain authoritative even when a TC is deferred>

### Constraints
- Follow all rules in the Context Block below
- Load the skills listed in the Context Block before writing code
- Implement ONLY behavior justified by the work-item contract + design-spec anchors above
- Do NOT modify protected files without user approval
- Do NOT run `git commit` or `git push`
- If feature-flag gating applies: top-level split from `feature-flags` at the entry route/component with the agreed flag key; keep the disabled branch functional

### TDD Instructions (see below)
<paste the TDD block matching this item's layer>
<also paste the AC/DoD binding rules below>

### Cross-item contracts
<interfaces / types / signatures this item must respect from earlier inner waves>
<relevant sibling PBI/TBI fields this item depends on>

<paste the Context Block from Phase F1>
```

### AC/DoD binding rules (paste into every item prompt)

```
AC/DoD binding (mandatory):

- RED tests MUST encode the Given/When/Then (PBI) or DoD bullet (TBI) as assertions — one focused test (or describe block) per matrix row for this item.
- Name or document each test with its criterion id (e.g. `AC-0`, `DoD-2`, or `TC-PBI-001-001`) so traceability is greppable.
- GREEN implementation must make those assertions pass without weakening the Then/DoD.
- Do not mark an AC/DoD done because a vaguely related test passes — the assertion must match the criterion.
- Prefer design-spec details (status codes, field names, UI states) when the AC is abstract.
- Re-run the item's tests after GREEN and confirm every matrix row for this item is covered.
```

### TDD — Red to Green (paste the block for the item's layer)

**Server task TDD block:**

```
TDD — Red to Green:

1. RED: Write src/server/__tests__/<module>.test.ts first.
   - Derive cases from this item's matrix rows (AC-*/DoD-*/BR/NFR) BEFORE writing implementation
   - Mock the Drizzle db instance: jest.mock('../db/drizzle', () => ({ db: { ... } }))
   - Follow the mock shape in src/server/__tests__/rbacService.test.ts
   - Use AAA (Arrange / Act / Assert); test public API only
   - Arrange = Given / DoD precondition; Act = When / operation; Assert = Then / DoD outcome
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation (minimum code to pass every matrix row).
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.server.json --noEmit — fix all errors.
```

**Client task TDD block:**

```
TDD — Red to Green:

1. RED: Write src/client/components/__tests__/<Component>.test.tsx
        or src/client/hooks/__tests__/<hook>.test.ts first.
   - Derive cases from this item's matrix rows (AC-*/linked TCs) BEFORE writing implementation
   - Use @testing-library/react + jest-environment-jsdom
   - Mock fetch and external hooks; use MSW or inline jest.fn() mocks
   - Use AAA pattern; test user-visible behavior matching Given/When/Then, not implementation details
   - Align UI assertions with {feature-slug}-design.md states/labels where specified
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation.
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.client.json --noEmit — fix all errors.
```

**Shared-types task TDD block:**

```
TDD — Red to Green:

1. RED: Write tests that import and validate the new types/utilities.
   - Map each DoD/AC row that constrains the shared contract to a type or pure-function assertion
   - For pure functions, use standard Jest unit tests
   - Run: npm test -- <testfile> — confirm tests FAIL

2. GREEN: Implement the types and utilities.
   - Run: npm test -- <testfile> — confirm PASS

3. TYPE-CHECK (both configs):
   npx tsc -p tsconfig.server.json --noEmit
   npx tsc -p tsconfig.client.json --noEmit
```

## Phase F5 — Inner-wave verification gate (from kick-off Phase 6)

After all subagents in an inner wave complete, the executor (you, in the parent development session) must:

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
6. **Stop.** Do **not** commit or push — the Dev Workbench session owns the branch and opens the PR via `finalisePush`.

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

### Items NOT implemented (if any)
- [PBI/TBI-ID] Title — reason (should be empty if all items are done)

### Files changed
- path/to/file.ts (new | modified)
- ...

### Status
Feature is implementation-complete and ready for diff capture.
```

**CRITICAL:** Never end a run with only tool calls and no final text. The user must always see a summary of what was implemented. If the run ends without this synopsis, the session will appear hung to the user.

---

## Quality-gate checklist

Copy and track per Feature Executor run:

```
[ ] Feature inputs loaded: full PBI fields (incl. every acceptanceCriteria Given/When/Then) and full TBI fields (incl. every definitionOfDone)
[ ] Design-spec trio loaded for this Feature (tech-spec + design + assumptions) — stopped if missing
[ ] Work-Item Context Ledger printed before any code
[ ] Requirements → Test Matrix built (every AC + every DoD + linked non-e2e TCs)
[ ] Context Block produced and injected into every subagent prompt (includes design-spec paths)
[ ] Inner item DAG built from item.dependsOn (verified self-contained) + parallelGroup
[ ] e2e-playwright test cases cataloged and DEFERRED; AC still covered at unit/integration when needed
[ ] Every subagent prompt included verbatim work-item contract + design-spec anchors + matrix rows
[ ] Every item followed RED → GREEN → REFACTOR → tsc with tests bound to AC-/DoD- ids
[ ] Verification targets from test-cases.json traceability satisfied (non-e2e)
[ ] Inner-wave gate passed (tsc + jest + AC/DoD matrix coverage) before each subsequent wave
[ ] ALL PBIs AND TBIs in this Feature's items[] have corresponding implementation AND criterion coverage
[ ] No protected files modified without explicit permission
[ ] NO `git commit` / NO `git push` performed
[ ] Completion synopsis posted as a visible chat message (includes final matrix + design specs consulted)
```

---

## Wiring

This skill is config-driven — no source changes are required to enable it.

- **Development Skill:** set `developmentSkillPath` to `dev-orchestrator` via **Admin → Project Settings** (persisted in the `project_skill_settings` table). Dev Workbench then launches this skill as the default Feature Executor for `mode: 'development'` sessions, passing the session's `workItemId`.
- **Optional Quick Skill Pill:** add a pill for the coordinator invocation (`/dev-orchestrator plan {slug}`) so planning can be triggered from Agent Home.

Config only — no source or protected-file edits.
