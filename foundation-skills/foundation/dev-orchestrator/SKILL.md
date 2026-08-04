---
name: dev-orchestrator
description: Turns a reviewed to-prd backlog into an ordered, TDD-driven implementation plan. Coordinator mode orders Features into execution waves; Feature Executor mode implements one Feature with TDD Red-Green driven by acceptance criteria. Use when the user says /dev-orchestrator plan {slug} or /dev-orchestrator feature {slug} FEAT-NNN.
disable-model-invocation: true
---

# Dev Orchestrator — Foundation

Turns a **reviewed** `to-prd` backlog into implementation. Two modes:

- **Coordinator** — PRD-level planning only. Orders Features into execution waves. Emits `.ai-pilot/output/{slug}.dev-plan.json`. No code changes.
- **Feature Executor** — Implements **one** Feature using TDD, driven by every PBI acceptance criterion, TBI definition-of-done, and design-spec files.

## Hard rule — requirements fidelity

Feature Executor must not implement from titles/goals alone. Every RED test and GREEN behavior must trace to a concrete backlog field (`acceptanceCriteria[]`, `definitionOfDone[]`, `businessRules`, NFRs) or an explicit design-spec decision. If those inputs are missing, stop and ask for them.

## Mode selection

| Invocation | Mode |
|------------|------|
| `/dev-orchestrator plan {slug}` | Coordinator |
| `/dev-orchestrator feature {slug} FEAT-NNN` | Feature Executor |
| Invoked as `developmentSkillPath` | Feature Executor (session's work item identifies the Feature) |

## Coordinator — Phase C0-C4

1. Read `.ai-pilot/output/{slug}.backlog.json` and `.ai-pilot/output/{slug}.test-cases.json` (optional).
2. Build the Feature DAG from `feature.dependsOn` edges.
3. Topo-sort Features and batch into waves by `implementationPhases`.
4. Emit `.ai-pilot/output/{slug}.dev-plan.json` validated against `dev-plan-schema.json`.
5. Print a wave summary to the operator.
6. Stop — do not dispatch executors or touch code.

## Feature Executor — Phase F0-F4

1. Load full Feature context: backlog item, acceptance criteria, design-spec trio, sibling items.
2. Build an AC→test matrix for every acceptance criterion.
3. Implement the item DAG with TDD (RED test → GREEN code → REFACTOR) per item.
4. Run build + full test suite after each item. Fix errors before moving on.
5. Do not commit or push — the dev workflow session owns that.

## Pipeline position

```
/to-prd → /prd-design-spec → /create-test-case → dev-orchestrator → build-test-push
```
