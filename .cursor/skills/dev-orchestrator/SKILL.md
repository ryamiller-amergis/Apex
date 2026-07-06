---
name: dev-orchestrator
description: Lean orchestrator that turns a reviewed to-prd backlog into an ordered, TDD-driven implementation plan. Coordinator mode topo-sorts Features by feature.dependsOn and batches them by implementationPhases into waves (planning only, no code). Feature Executor mode runs a single Feature's self-contained item DAG with kick-off TDD Red-Green inside a Dev Workbench development session. Use when the user says /dev-orchestrator plan {slug}, /dev-orchestrator feature {slug} FEAT-NNN, or when this skill is wired as the developmentSkillPath.
disable-model-invocation: true
---

# Dev Orchestrator (lean)

Turns a **reviewed** `to-prd` backlog into implementation. Two modes:

- **Coordinator** — PRD-level planning only. Orders Features into execution **waves**. Emits `.ai-pilot/output/{slug}.dev-plan.json`. **No code changes.**
- **Feature Executor** — implements **one** Feature inside a Dev Workbench `mode: 'development'` session, running that Feature's self-contained item DAG with TDD Red-Green.

This skill assumes **dependency locality is already enforced upstream** by `/to-prd` (generation) and `/prd-spec-review` (hard gate): item-level `dependsOn` never crosses a Feature boundary, and every cross-Feature relationship is a `feature.dependsOn` edge. Because of that guarantee this orchestrator carries **no elevation rule and no item-level cross-feature graph** — each Feature's item DAG is guaranteed self-contained.

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
3. Per-Feature design specs under `.ai-pilot/output/{slug}-design-spec/` (`{feature-slug}-tech-spec.md`, `-design.md`, `-assumptions.md`) — optional context.
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

## Phase F0 — Load Feature inputs

1. `.ai-pilot/output/{slug}.backlog.json` — locate the target Feature; read its `items[]` (PBIs and TBIs), `featureFlag` (if present), `affectedPersonas`, and `outOfScope`.
2. This Feature's design specs: `.ai-pilot/output/{slug}-design-spec/{feature-slug}-tech-spec.md`, `-design.md`, `-assumptions.md`.
3. `.ai-pilot/output/{slug}.test-cases.json` — filter to test cases whose `traceability.pbiId` belongs to this Feature's PBIs. These are the **verification targets**.

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
Git policy: NO `git commit` / NO `git push`. The Dev Workbench captures the diff and opens the PR.
```

## Phase F2 — Build the inner (item) DAG

- **Nodes** = this Feature's `items[]` (PBIs + TBIs).
- **Edges** = item `dependsOn` (guaranteed self-contained — every referenced ID resolves to an item in **this** Feature). If any `dependsOn` references an item outside this Feature, stop and report it as an upstream decomposition error (the `/prd-spec-review` gate should have caught it).
- **Parallel hints** = `parallelGroup`; items sharing a `parallelGroup` label are safe to run together.
- Validate the item graph is a DAG. Topo-sort into **inner waves**: items with no unmet `dependsOn` form the first inner wave; each subsequent wave unlocks once its predecessors pass the wave gate.

## Phase F3 — Catalog & defer e2e

Filter this Feature's verification targets: any test case with `automation.recommendedTier === 'e2e-playwright'` is **cataloged and skipped** with a "deferred: e2e" note. Do not author or run Playwright specs. Report the deferred list at the end. All other tiers (`unit`, `integration`, `manual`-where-automatable) are in scope for TDD.

## Phase F4 — Dispatch inner waves with TDD

For each inner wave, dispatch one subagent per item (items in the same wave run in parallel). Each subagent prompt uses this structure:

```
## Task: <item id> — <item title>

### Goal
<1-2 sentences: the deliverable for this PBI/TBI>

### Files to create or edit
<explicit list — no others unless unavoidable>

### Verification targets (from test-cases.json)
<the test cases whose traceability.pbiId maps to this item, by id + acceptanceCriteriaIndex>
<e2e-playwright cases are DEFERRED — do not implement them>

### Constraints
- Follow all rules in the Context Block below
- Load the skills listed in the Context Block before writing code
- Do NOT modify protected files without user approval
- Do NOT run `git commit` or `git push`
- If feature-flag gating applies: top-level split from `feature-flags` at the entry route/component with the agreed flag key; keep the disabled branch functional

### TDD Instructions (see below)
<paste the TDD block matching this item's layer>

### Cross-item contracts
<interfaces / types / signatures this item must respect from earlier inner waves>

<paste the Context Block from Phase F1>
```

### TDD — Red to Green (paste the block for the item's layer)

**Server task TDD block:**

```
TDD — Red to Green:

1. RED: Write src/server/__tests__/<module>.test.ts first.
   - Mock the Drizzle db instance: jest.mock('../db/drizzle', () => ({ db: { ... } }))
   - Follow the mock shape in src/server/__tests__/rbacService.test.ts
   - Use AAA (Arrange / Act / Assert); test public API only
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation (minimum code to pass).
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.server.json --noEmit — fix all errors.
```

**Client task TDD block:**

```
TDD — Red to Green:

1. RED: Write src/client/components/__tests__/<Component>.test.tsx
        or src/client/hooks/__tests__/<hook>.test.ts first.
   - Use @testing-library/react + jest-environment-jsdom
   - Mock fetch and external hooks; use MSW or inline jest.fn() mocks
   - Use AAA pattern; test user-visible behavior, not implementation details
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
3. If failures: diagnose, fix inline or dispatch a targeted fix subagent, then re-run.
4. Only after type-check and tests pass: dispatch the next inner wave.

Report after each inner-wave gate:
> "Inner wave N complete. Type-check: ✓. Tests: ✓. Proceeding to inner wave N+1."

## Phase F6 — Feature completion

When the last inner wave passes its gate:

1. Confirm every non-deferred verification target has a passing test.
2. List deferred e2e cases (skipped by design).
3. Run the **Quality-gate checklist** below.
4. **Verify all items are implemented.** Cross-reference every PBI and TBI in this Feature's `items[]` against the files you created or modified. If any item has no corresponding implementation, **go back and implement it before proceeding** — do not skip PBIs (frontend) in favor of TBIs (backend) or vice versa. A Feature is not complete until all its items are accounted for.
5. **Stop.** Do **not** commit or push — the Dev Workbench session owns the branch and opens the PR via `finalisePush`.

**MANDATORY — post a completion synopsis.** You MUST end your run with a visible chat message (not just tool calls). The synopsis must include:

```
## Implementation Synopsis

### Completed items
- [PBI/TBI-ID] Title — files created/modified
- ...

### Deferred (e2e)
- [TC-ID] — reason

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
[ ] Feature inputs loaded (backlog items, design specs, matching test-cases)
[ ] Context Block produced and injected into every subagent prompt
[ ] Inner item DAG built from item.dependsOn (verified self-contained) + parallelGroup
[ ] e2e-playwright test cases cataloged and DEFERRED (not implemented)
[ ] Every item followed RED → GREEN → REFACTOR → tsc
[ ] Verification targets from test-cases.json traceability satisfied (non-e2e)
[ ] Inner-wave gate passed (tsc + jest) before each subsequent wave
[ ] ALL PBIs AND TBIs in this Feature's items[] have corresponding implementation
[ ] No protected files modified without explicit permission
[ ] NO `git commit` / NO `git push` performed
[ ] Completion synopsis posted as a visible chat message (not just tool calls)
```

---

## Wiring

This skill is config-driven — no source changes are required to enable it.

- **Development Skill:** set `developmentSkillPath` to `dev-orchestrator` via **Admin → Project Settings** (persisted in the `project_skill_settings` table). Dev Workbench then launches this skill as the default Feature Executor for `mode: 'development'` sessions, passing the session's `workItemId`.
- **Optional Quick Skill Pill:** add a pill for the coordinator invocation (`/dev-orchestrator plan {slug}`) so planning can be triggered from Agent Home.

Config only — no source or protected-file edits.
