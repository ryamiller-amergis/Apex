# MODE 1 — Coordinator (planning only, NO code changes)

`/dev-orchestrator plan {slug}`

Produces an ordered wave plan across the whole PRD. This mode **never edits source, never writes tests, never runs a build**. It only reads inputs and writes the plan artifact.

## Phase C0 — Load inputs

Read each of the following. The canonical store for backlogs is the `prds.backlog_json` column in Postgres — the file-based inputs below are exported projections.

1. `.ai-pilot/output/{slug}.backlog.json` — **required.** Source of Features, `feature.dependsOn`, and `implementationPhases`.
2. `.ai-pilot/output/{slug}.test-cases.json` — **optional.** Used to catalog deferred e2e coverage (see Phase C3).
3. Per-Feature design specs under `.ai-pilot/output/{slug}-design-spec/` (`{feature-slug}-tech-spec.md`, `-design.md`, `-assumptions.md`) — optional for Coordinator (planning only); **required for Feature Executor**.
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

If `.test-cases.json` is present, collect every test case where `automation.recommendedTier === 'e2e-playwright'`. Record each in the plan's `deferredE2E[]` with its `testCaseId`, `pbiId`, and owning `featureId`. Coordinator catalogs these for planning visibility; Feature Executor authors the specs and may defer execution per [feature-executor.md](feature-executor.md) Phase F3.2.

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

3. Coordinator stops here. It **does not** dispatch executors or touch code. The operator runs each Feature through Feature Executor (typically one Dev Workbench session per Feature, in wave order).
