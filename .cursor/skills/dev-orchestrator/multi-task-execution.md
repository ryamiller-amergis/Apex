# Multi-Task Execution

Read this file during Feature Executor Phase F2 when the Feature tech spec contains an `Implementation Plan`.

The tech-spec step graph refines backlog-item scheduling; it never replaces backlog requirements. Backlog ACs, DoDs, business rules, NFRs, and explicit design decisions remain authoritative.

## Activation and fallback

- **Task mode (preferred):** Use when `Implementation Plan` contains at least two uniquely identified steps (`S1`, `S2`, …) and each step states its blockers or says `no blockers`.
- **Item mode (fallback):** Use the backlog item DAG only when no implementation-step graph exists.
- If a step graph exists but has unresolved blockers, duplicate IDs, a cycle, or a step that cannot be mapped to requirements, **stop and report the design-spec defect**. Do not silently fall back to item mode.

Print the selected mode before dispatch:

> Execution mode: multi-task tech-spec DAG.

or:

> Execution mode: backlog-item DAG (tech spec has no executable implementation-step graph).

## Build the Task Context Ledger

Normalize every implementation step into:

| Field | Rule |
|-------|------|
| `id` | Unique step ID from the tech spec |
| `goal` | Step text verbatim |
| `owningItems` | One or more PBI/TBI IDs justified by the per-work-item decisions, verification matrix, and affected contract |
| `criteria` | AC/DoD/BR/NFR matrix rows enabled or completed by this step |
| `verificationTargets` | `VT-*` rows explicitly named by the step or mapped from the tech-spec verification matrix |
| `dependsOn` | Explicit blockers from the implementation plan |
| `files` | Exact expected source, migration, and test files from the step and tech-spec module guidance |
| `verificationOwner` | Criteria/VT rows whose passing assertion becomes this step's responsibility |

Mapping rules:

1. Every step must map to at least one owning backlog item and one requirement, design decision, or verification target.
2. Every AC and DoD in the Feature matrix must map to one or more steps.
3. Every criterion and `VT-*` row has exactly one **verification owner** step. Earlier enabling steps may reference it but must not claim it as passing.
4. A schema, migration, or shared-contract step with no direct behavioral test must own a deterministic check (migration shape, schema shape, type assertion, or parent-owned type-check).
5. Never derive behavior from a step title alone. Paste the owning item contract and relevant design anchors into its execution bundle.
6. If ownership is ambiguous, stop and ask the operator; do not invent a mapping.

Print the completed Task Context Ledger before dispatch.

## Build and validate the task DAG

1. Create one node per normalized step and one edge per `dependsOn`.
2. Confirm every dependency resolves and the graph is acyclic.
3. Treat explicit tech-spec blockers as the scheduling graph. Backlog item dependencies remain **completion constraints**:
   - A dependent item cannot be marked complete before its prerequisite item is complete.
   - A task from a dependent item may start early only when the tech spec explicitly identifies its concrete predecessor steps, all those steps passed, and the task consumes no unfinished prerequisite output.
   - If that proof is missing, add an edge from the prerequisite item's final task.
4. Recompute topological waves; the written `Execution lanes` are hints to validate, not commands to trust blindly.
5. Ensure each wave leaves complete contracts. If a later wave consumes a TypeScript contract, the parent runs the applicable boundary type-check before dispatching it. If a split would leave an incomplete contract, combine the steps or add an edge.

## Prevent parallel write conflicts

Before dispatching a wave, compare each task's expected source and test files.

- Different files and no unresolved contract edge: separate bundles may run concurrently.
- Same source file, same test file, overlapping generated artifact, or likely adjacent edits: coalesce those tasks into one **execution bundle** with one writer.
- Prefer coalescing a small linear producer/consumer chain when the steps form one contract (for example, migration + ORM schema), no other bundle needs the intermediate state, and one writer can execute the internal dependency in order.
- Unknown file scope: inspect the repository before dispatch; do not assume it is safe.
- If coalescing would violate ordering, keep both tasks in one bundle and execute them sequentially.

Example: steps that both modify `callerGroundingService.ts` and its Jest suite belong in one bundle even if the dependency graph otherwise permits parallel execution.

After coalescing, build the **bundle DAG** by retaining only dependencies that cross bundle boundaries. Internal task edges define execution order inside the bundle and do not force separate waves. Topologically schedule bundles, not raw tasks.

## Print the execution plan

Before Phase F3, print:

```markdown
## Multi-Task Execution Plan — FEAT-NNN

### Task Context Ledger
| Task | Owning items | Depends on | Criteria / VT | Verification owner | Files |
|------|--------------|------------|---------------|--------------------|-------|
| S1 | TBI-001 | — | DoD-0, VT-01 | check: migration shape | migrations/... |

### Execution waves
- Wave 1
  - Bundle A: S1 + S2 (one writer; shared schema contract)
  - Bundle B: S3
- Wave 2
  - Bundle C: S4
  - Bundle D: S5 + S6 (one writer; overlapping files)

### Completion constraints
- TBI-002 cannot complete before TBI-001.
```

## Dispatch and gates

- Dispatch one subagent per execution bundle, with different bundles in the same wave running concurrently.
- Include every task in the bundle, full owning-item contracts, design anchors, matrix rows, file scope, and cross-task contracts.
- A bundle follows RED → GREEN for its verification-owner rows and runs deterministic checks for enabling-only rows.
- After each non-final wave, run the lean parent Phase F5 gate: one aggregate focused-test command per Jest project (exact file paths, `--selectProjects`), matrix coverage, and only the TypeScript config needed by a downstream consumer. Run F6 instead of F5 for the final wave.
- Update matrix rows as `enabled` when only a prerequisite landed; use `covered` only after the verification-owner assertion passes.
- At completion, account for every implementation step as well as every backlog item and criterion.
