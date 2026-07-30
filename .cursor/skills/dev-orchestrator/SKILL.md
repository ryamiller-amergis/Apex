---
name: dev-orchestrator
description: Lean orchestrator that turns a reviewed to-prd backlog into an ordered, TDD-driven implementation plan. Coordinator mode topo-sorts Features by feature.dependsOn and batches them by implementationPhases into waves (planning only, no code). Feature Executor mode loads full PBI/TBI context (acceptance criteria, definition of done, BRs, NFRs) plus the Feature's design-spec trio, builds an AC→test matrix, and runs a self-contained item DAG with TDD Red-Green that asserts every criterion. Use when the user says /dev-orchestrator plan {slug}, /dev-orchestrator feature {slug} FEAT-NNN, or when this skill is wired as the developmentSkillPath.
disable-model-invocation: true
---

# Dev Orchestrator (lean)

Turns a **reviewed** `to-prd` backlog into implementation. Two modes:

- **Coordinator** — PRD-level planning only. Orders Features into execution **waves**. Emits `.ai-pilot/output/{slug}.dev-plan.json`. **No code changes.**
- **Feature Executor** — implements **one** Feature with TDD Red-Green driven by every PBI acceptance criterion, every TBI definition-of-done item, and the Feature's design-spec trio.

**Dependency locality** is enforced upstream by `/to-prd` and `/prd-spec-review`: item `dependsOn` never crosses a Feature boundary. This orchestrator has no elevation rule and no cross-feature item graph.

**Hard rule — requirements fidelity:** Do not implement from titles/goals alone. Every RED test and GREEN behavior must trace to backlog fields (`acceptanceCriteria[]`, `definitionOfDone[]`, `businessRules`, NFRs) and/or an explicit design-spec decision. If those inputs are missing, **stop** — do not invent criteria.

**Pipeline:** `/to-prd` → `/prd-design-spec` → `/create-test-case` → `dev-orchestrator` → `build-test-push`

---

## Mode selection

| Invocation | Mode | Read next |
|------------|------|-----------|
| `/dev-orchestrator plan {slug}` | **Coordinator** | [coordinator.md](coordinator.md) |
| `/dev-orchestrator feature {slug} FEAT-NNN` | **Feature Executor** | [feature-executor.md](feature-executor.md) |
| Project `developmentSkillPath` (Dev Workbench `mode: 'development'`) | **Feature Executor** (default) | [feature-executor.md](feature-executor.md) |
| Local kickoff prompt (Cursor, not Dev Workbench) | **Feature Executor** (local) | [local-dev.md](local-dev.md) then [feature-executor.md](feature-executor.md) |

When invoked with no arguments and no development-session context, ask which mode is intended; do not guess.

### Progressive disclosure (mandatory)

1. Select the mode from the table above.
2. **Read only the linked file(s) for that mode** before proceeding.
3. Before dispatching Phase F4 subagents, also read [tdd-prompts.md](tdd-prompts.md).
4. Do **not** load Coordinator content during Feature Executor (or vice versa).

Supporting contracts (Coordinator only, when emitting the plan):

- [dev-plan-schema.json](dev-plan-schema.json)
- [dev-plan-example.json](dev-plan-example.json)

---

## Feature Executor phase index

| Phase | Purpose |
|-------|---------|
| F0 | Load backlog + design-spec trio + test cases; print Work-Item Context Ledger |
| F0.5 | Assumption gate — resolve naming against live repo; stop on material ⚠ items |
| F1 | Build Context Block (rules, skills, protected files) |
| F2 | Inner item DAG + parallel waves |
| F3 | Requirements → Test Matrix; author E2E specs (defer execution only if env unavailable) |
| F4 | Dispatch items with TDD prompts from [tdd-prompts.md](tdd-prompts.md) |
| F5 | Inner-wave gate: `tsc` + tests + AC/DoD coverage |
| F6 | Completion synopsis; no commit/push |

Full procedures: [feature-executor.md](feature-executor.md).

---

## Wiring

Config-driven — no source changes required to enable:

- **Development Skill:** set `developmentSkillPath` to `dev-orchestrator` via **Admin → Project Settings** (`project_skill_settings`). Dev Workbench launches this skill for `mode: 'development'` sessions.
- **Local kickoff:** Apex `localDevContextService` emits an explicit `/dev-orchestrator feature {slug} FEAT-NNN` block when the skill is configured.
- **Optional Skill Pill:** `/dev-orchestrator plan {slug}` for Coordinator from Agent Home.
