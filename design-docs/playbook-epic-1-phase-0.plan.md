---
name: Playbook Orchestration — Epic 1 (Phase 0 Demo)
overview: Implementation plan for all 34 child items of Epic 1, "Playbook Engine Verification & Governance Foundations". Epic 1 is not a product feature — it is a reversible, default-off, local-and-dev-only spike that proves an embedded workflow engine can run a durable multi-step Playbook inside Apex, ending in a rehearsed live demo of two seeded Playbooks.
source: Playbooks-user-composable-AI-workflow-orchestration-(phases-1-3)-prd.zip (prd.md + backlog.json)
status: draft — not yet approved for implementation
---

# Playbook Orchestration — Epic 1 (Phase 0 Demo)

## What Epic 1 is

Epic 1 answers one question: **can Apex run a Playbook durably, and does the engine we picked actually behave the way the ADR assumed?**

It ships a working demo, not a product. Nothing a customer or a BA can reach. The whole epic sits behind the `playbooks-spike` feature flag, default-off, enabled in local and development environments only. A Developer is the only persona in the epic.

The demo we are building toward is a fixed sequence, set in the interview and carried into TBI-027:

1. Show seeded definition **A** as a row: `cursor-agent` → `approval-gate` → `notify`.
2. Start it. Watch the agent step queue on the background lane in the read-only status view.
3. Watch the gate suspend, showing its deadline.
4. **Restart the server process while the run is suspended.**
5. Approve the gate. Watch the run resume and finish.
6. Run seeded definition **B** — the same three step types in a different order — end to end with zero code changes.

Steps 4 and 6 are the point. Step 4 proves durability, which is the only reason to adopt an engine at all. Step 6 proves the registry is a real contract and not three hardcoded paths.

## What Epic 1 is deliberately not

These are boundaries from the interview, recorded as constraints rather than preferences. Breaking one quietly breaks the case for the whole program.

- **No Playbook writes a pipeline artifact.** No PRD, design doc, test case or validation status is touched. The seeded definitions are synthetic rehearsals. The design-doc validation Playbook is Phase 2 work and depends on an extraction that has not happened yet.
- **No production or staging enablement.** Local and development only.
- **No authoring UI.** Definitions are seeded by a Developer. The canvas is Phase 4.
- **Only three step types** — `cursor-agent`, `approval-gate`, `notify`. No Zod input/output schemas, no `sideEffect` classification, no `requiredPermissions` on the registry yet; that full contract is Epic 2.
- **Agent steps may only run Skills whose MCP configuration is read-only.**

---

## What Apex already gives us

Epic 1 is far less greenfield than it reads. Most of the hard machinery exists; the epic is mostly about wiring a durable graph on top of it.

| Need | Already in Apex |
|---|---|
| Queue an AI agent run without blocking | `agentRunLifecycleService.enqueue` (`src/server/services/agentRunLifecycleService.ts`) |
| Environment-wide in-flight cap with per-project fairness | `admissionGovernorService.runAdmissionCycle` + `admissionGovernorScheduler` |
| Terminal agent-run events across instances | `pgNotifyService.notifyRunEvent` / `subscribeRunEvents` (Postgres `LISTEN`/`NOTIFY` on channel `agent_run_events`) |
| Sweep for orphaned and timed-out runs | `agentRunReaperService.startReaper`, plus `recoverStaleDispatchedRuns` |
| Durable notification rows | `notificationService.createNotification` |
| Approver pools, groups, any-one vs all-required | `documentApprovalService.ts` + `projectSettingsService.getApproverPool` |
| Feature flags with targeting and kill switch | `featureFlagService.isFeatureEnabled`, `useFeatureFlag` |
| Permission keys and route gating | `rbacService.getUserPermissions`, `middleware/rbac.requirePermission`, `useAppShell().can()` |
| Multi-instance scheduler coordination | `pg_advisory_xact_lock(hashtext(...))`, as used by the admission governor |
| Blob references for large payloads | `{ container, key }` shape, as in `src/shared/types/loadTest.ts` |
| Zod | Already a dependency at v4.3.6 |

What does **not** exist: any Playbook table, the engine package itself, a graph validator, an import-boundary lint rule, and the `playbooks:*` permission keys.

---

## Implementation details to settle before coding

Epic 1's scope is complete. The PRD names every permission it needs in its Access Control table, the backlog decomposes all 34 items, and the interview settled the decisions behind them. Nothing below is missing scope.

These are four code-level details a developer hits on day one that no PRD should carry — the `to-prd` skill explicitly bars file paths and code from Implementation Decisions. They are listed here because this is the document where they belong, not because anything upstream failed to consider them.

**1. Seed `playbooks:view` and `playbooks:run` during Epic 1, not Epic 2.**
TBI-036 in Epic 2 creates all four permission keys together, which is the right home for the full set. But three Epic 1 items — PBI-001, PBI-002 and TBI-025 — gate on two of them. A one-line migration inserting just `playbooks:view` and `playbooks:run` into `app_permissions` unblocks Epic 1 without disturbing TBI-036, which still owns `playbooks:author`, `playbooks:admin` and the author-implies-run semantics. Tracked below as **IMPL-001**. Purely a sequencing convenience.

**2. A Playbook agent step needs a `workflowClass` value and a thread.**
`EnqueueAgentRunInput` requires `threadId` and `ExecutionSnapshot` requires `workflowClass`. `BackgroundWorkflowClass` is a closed union of five members today — `prd`, `design-doc`, `validation`, `test-cases`, `walkthrough-smart-tagging` — so a new member has to be added before a step can enqueue anything.

The related consequence is already a settled decision, not an open problem: the interview examined `resolveUsageEntityFromThread` (`src/server/services/aiUsageService.ts:71`) at Q5 and established that a Playbook-owned thread resolves to no entity, that usage writes are fire-and-forget by design, and that cost is therefore advisory and never in the execution path. That became BR-007 and the Epic 3 spend-admission policy. At Phase 0, where runs are synthetic and local-only, a null entity anchor is the accepted outcome. Worth fixing cheaply if it is cheap; not a blocker. Tracked as **IMPL-002**.

**3. The graph validator is built inside TBI-023, not before it.**
TBI-023 lists the shared graph validator under `technicalDependencies`, which is the backlog saying this item needs it. Phase 0 needs only loop detection and the caps. The note worth carrying forward is to write that minimal version as the seed the Phase 4 shared validator grows from, rather than a throwaway the canvas later replaces. Folded into TBI-023 below.

**4. Confirm E5's owner and deputy against the ADR.**
The PRD's Assumptions Made lists them as unnamed; the interview record says two names were attached to all five duties in the ADR, and that making E5 a tracked item was the deliberate mechanism for keeping an empty slot visible. So TBI-029 is working as designed. Read the ADR first — if the names are there, this is a copy-forward rather than a staffing decision.

---

## Build order

Dependencies inside Epic 1 form five waves. Items in the same wave are safe to run in parallel.

| Wave | Items | Gate to leave the wave |
|---|---|---|
| **A — Verify and decide** | TBI-001 … TBI-005, TBI-010, TBI-029 | Both fallback triggers answered. Go/no-go on Mastra recorded. |
| **B — Governance and schema** | TBI-006, TBI-007, TBI-008, TBI-009, TBI-011 … TBI-015, IMPL-001, IMPL-002 | Wrapper module is the only import site, enforced by a failing build. Four tables migrated and mirrored in Drizzle. |
| **C — Registry and adapters** | TBI-016 … TBI-019, PBI-001 | A seeded Playbook starts and its first agent step queues without blocking. |
| **D — Durability and guards** | TBI-020 … TBI-024, PBI-004, PBI-005 | A suspended run survives a restart and resumes. Deadlines expire via sweep only. |
| **E — Demo surface and exit criteria** | TBI-025, TBI-026, TBI-027, TBI-028, PBI-002, PBI-003 | Rehearsal runs clean end to end. E1–E4 pass as tests. |

Wave A is the only wave that can send the whole program somewhere else. **Do not start Wave B until Wave A is answered** — pinning a version and building a wrapper around an engine we may abandon is wasted work.

---

## FEAT-001 — Mastra Verification Spike & Fallback Decision

Six items, all Developer, all TBIs. This is research with recorded answers, not integration code. Two of the six can send the program to VoltAgent.

### TBI-001 — Postgres store: table creation and schema confinement *(fallback trigger 1)*

Read the pinned Mastra package's store initialization code and answer three questions: does it run DDL on init under the application's own database role; can that be disabled or pointed at tables an Apex migration created; and can it be confined to a dedicated schema owned by a role with no rights anywhere else.

Apex forbids DDL at app startup (`.cursor/rules/postgresql-db.mdc`), so a store that insists on public-schema DDL under the app role with no confinement option **trips the fallback**. Run this against a scratch database, never a shared one.

*Done when:* auto-create, disable, and confinement behavior are each recorded with evidence; fallback-trigger status is explicitly marked tripped or not; the finding is handed to TBI-006 and to TBI-014.

### TBI-002 — In-process driving with no engine HTTP surface *(fallback trigger 2)*

Confirm the engine can be started, resumed, suspended and cancelled entirely from Apex's own Express routes with none of the engine's endpoints mounted. Apex layers auth on `/api` in `src/server/index.ts`; a mounted engine router would be a new surface sitting outside that. If mounting under a non-`/api` prefix is the only option, that is **fallback trigger two**.

*Done when:* the in-process answer is recorded; fallback-trigger status is marked; the finding feeds TBI-006.

### TBI-003 — Pool acceptance and connection budget

Determine whether the store accepts an existing pool or client rather than opening its own. If it opens its own, record the default pool size and add it as a line item to Apex's declared connection budget. The interview settled that this number is *declared*, not discovered under load.

*Done when:* pool/client acceptance is recorded; default pool size is recorded if applicable; the budget line item exists and the total stays inside the database's connection limit.

### TBI-004 — Diff the enterprise entitlement list against the ADR

Entitlement boundaries move between releases. Re-read the current licensing and entitlement list for the pinned version and compare it line by line with what the ADR recorded. The "nothing may be purchased" constraint rests on a claim about configuration, so any feature Apex depends on that has moved behind a commercial licence matters.

*Done when:* the comparison is done line by line; every discrepancy is recorded with its licensing implication; the resulting key list is handed to TBI-009.

### TBI-005 — Telemetry kill switch actually stops outbound calls

Disable the engine's telemetry configuration and observe network activity with the switch both on and off. A suppressed log line while data still leaves is the failure mode we are looking for.

*Done when:* outbound behavior is observed and recorded in both states; any discrepancy is recorded as a fallback consideration.

### TBI-006 — Package all six answers as a re-runnable conformance suite

Turn TBI-001 through TBI-005 into automated checks that can be re-run before any future version-pin move, rather than a one-time spike memo. A check that cannot currently evaluate its question **must fail, not skip** — a silent skip is how a spike record rots.

Lives with the Jest suites under `src/server/__tests__/` or `tests/integration/`, and must run without production access or credentials.

*Done when:* all six questions are re-runnable; an unevaluable check fails; the suite's output is attached to the pin-move pull-request template referenced in TBI-007.

*Depends on:* TBI-001 … TBI-005.

---

## FEAT-002 — Engine Governance Scaffolding

Four items. This is the containment boundary. Get it wrong and a fallback swap becomes a rewrite instead of a directory replacement.

> **Permission needed:** TBI-007 edits `package.json` and TBI-008 edits `.eslintrc.json`. Both are config files under the scope-discipline rule. Ask before touching either.

### TBI-007 — Pin every engine package at an exact version

Pin with no caret and no range, and configure automated dependency tooling to skip these packages. The engine is a fast-moving project and the licensing posture depends on which version we are on, so an unattended bump is a real risk rather than a theoretical one.

*Done when:* every engine package is pinned exactly; automated bumps are excluded; the pin is reviewable only through the existing file-change permission path.

### TBI-008 — Engine wrapper module as the sole import site, enforced by lint

Create one module — suggested `src/server/services/playbookEngine/` — exposing `start`, `resume`, `suspend` and `cancel` in Apex's own vocabulary, hiding every engine type behind them. Nothing engine-shaped crosses the boundary.

Enforcement is two-sided. Outward: an ESLint `no-restricted-imports` rule (or `eslint-plugin-import`'s `no-restricted-paths`, already a dependency) that **fails the build**, not warns, on any import of an engine package from outside that directory. Inward: a test that snapshots the module's exported symbols, so the wrapper's own surface cannot widen without a visible, reasoned snapshot update. The lint rule cannot see that second kind of growth.

The same boundary is what makes the VoltAgent fallback a directory replacement.

*Done when:* the wrapper exposes only Apex-vocabulary operations; the lint rule fails CI on an external import; the exported-symbol snapshot test passes.

*Depends on:* TBI-007.

### TBI-009 — Licence-configuration assertion test

Add a CI test asserting that no commercially licensed feature key appears anywhere in the engine's active configuration, using TBI-004's findings as the key list. The point is that a future config change that quietly enables an entitled feature fails the build instead of surfacing at renewal.

*Done when:* the test enumerates every known licensed key; it fails if any appears in active configuration; it runs in CI.

*Depends on:* TBI-004 (for the key list).

### TBI-010 — Create the `playbooks-spike` flag with its cleanup criterion declared up front

Create the flag default-off **before any gated code merges**, per `.cursor/skills/feature-flags/SKILL.md`. Record the winning branch (enabled) and the cleanup criterion (retire at acceptance of the Phase 1 definition model) on the flag record at creation, not later.

Gate at a single top-level entry point, with the `@feature-flag:playbooks-spike` markers the cleanup tooling reads. Target local and development environments only. This flag covers Phase 0 alone — each later phase boundary mints its own short-lived flag.

*Done when:* the flag exists default-off with a kebab-case key; winning branch and cleanup criterion are recorded at creation; gating is verified at one top-level split.

---

## FEAT-003 — Apex-Owned Playbook Schema

Five items. The invariant here is BR-001: **Apex owns run truth; the engine's store is a disposable execution cache.** If the engine's tables vanish between two steps, the run must still be reconstructible from Apex tables alone.

All migrations are node-pg-migrate SQL under `migrations/`, named `YYYYMMDDHHMMSS_<kebab-description>.sql`, with matching `pgTable` definitions added by hand to `src/server/db/schema.ts`. Status vocabularies get a `CHECK` constraint in SQL and a `check()` in the Drizzle table callback — the pattern `run_groundings` already uses.

### TBI-011 — `playbook_definitions` and `playbook_definition_versions`

Two tables. A definition is the mutable container; a version is immutable once published. After publish, only lifecycle status may change (`published` → `deprecated` → `archived`). A version referenced by any run is never hard-deleted — deprecation, never forced migration.

Postgres cannot express "immutable after publish" cleanly with a constraint alone, so enforce it at the application layer and prove it with a test.

*Done when:* the migration creates both tables with indexes and foreign keys; Drizzle matches; a test shows an attempt to mutate a published version's content is rejected.

### TBI-012 — `playbook_runs`

Carries the initiating user, the pinned definition version, the run status, and step-budget counters used by the structural guards.

The status vocabulary is `running`, `suspended`, `completed`, `cancelled`, `failed`, **`expired`** — constrained by a `CHECK` at the database level. `expired` is distinct on purpose: "nobody came" is a different fact from "somebody cancelled it" or "it broke."

Counters are incremented by the runtime, not computed on read, so a guard check never has to aggregate.

*Done when:* the migration creates the table with the full vocabulary including `expired`; Drizzle matches; counter columns are present and written by the runtime.

*Depends on:* TBI-011.

### TBI-013 — `playbook_step_runs`

Carries the step id, the correlated `agent_run_id`, status, a resume token, the step output, and `expires_at`.

Output is inline for small payloads and a Blob reference above a size threshold — use the `{ container, key }` shape Apex already uses. **The threshold is unset in the PRD and needs a number before this is built** (see Open Decisions).

`expires_at` must be indexed. The reconciliation sweep queries it on every tick, and the sweep's cost must scale with the number of suspended steps, not the number of all runs.

*Done when:* the migration creates every documented column; Drizzle matches; the `expires_at` index is confirmed by an `EXPLAIN` check inside the sweep query test.

*Depends on:* TBI-012.

### TBI-014 — Confined engine schema and least-privilege role *(conditional)*

Only if TBI-001 found the store must create its own tables. Then: a dedicated Postgres schema and a role with zero grants on anything Apex owns. If the store accepts Apex-created tables, this item is a recorded no-op.

Either way the conditional must be **resolved and written down**, not left ambiguous.

*Done when:* the branch is resolved and recorded; if created, role privileges are verified to exclude every Apex-owned object; dropping every table in the confined schema is verified to leave Apex data untouched.

*Depends on:* TBI-001.

### TBI-015 — Apex-only reconstruction projection

A read path that answers "what happened and what happens next" for any run using only the four Apex tables — current step, run status, pinned version, suspension cause and deadline — with no query against an engine table under any condition.

This is the single most load-bearing item in the schema feature. It is what the status view renders (TBI-025) and what exit criterion E4 tests against (TBI-028). Build it as a real module, not a helper inside the route.

*Done when:* the projection answers current step, run status and pinned version from Apex tables alone; a test drops every engine-owned table and the projection still returns a correct result for an in-flight run; the lint boundary from TBI-008 confirms nothing outside the wrapper reads an engine table.

*Depends on:* TBI-013.

### IMPL-001 — Seed `playbooks:view` and `playbooks:run` *(implementation task)*

One migration inserting both keys into `app_permissions` with category `playbooks`, granting both to `admin` only. Follow `.cursor/skills/rbac-management/SKILL.md` and update the catalog in `.cursor/rules/rbac-governance.mdc`.

Minimal on purpose: `playbooks:author` and `playbooks:admin` belong to FEAT-009 in Epic 2. Epic 1 only needs enough to satisfy PBI-001, PBI-002 and TBI-025.

*Done when:* both keys exist and are grantable; `requirePermission('playbooks:view')` gates the status route; `can('playbooks:run')` gates the start action in the client; the governance catalog is updated.

### IMPL-002 — Extend `workflowClass` and thread resolution for Playbook steps *(implementation task)*

Add a `playbook-step` member to `BackgroundWorkflowClass` in `src/shared/types/backgroundWorkflow.ts` and decide how a Playbook step obtains the `threadId` that `enqueue` requires. Both are hard blockers — a step cannot enqueue an agent run without them.

Optionally extend `resolveUsageEntityFromThread` so Playbook usage rows carry an entity anchor. This one is not a blocker: the interview settled at Q5 that cost data is advisory, best-effort and out of the execution path, and Phase 0 runs are synthetic and local-only. Do it if it is a small change; defer it to the phase that first spends real money if it is not.

*Done when:* the new class member exists and typechecks; a Playbook step's agent run carries a resolvable thread.

---

## FEAT-004 — Minimal Step-Type Registry & Core Step Adapters

Five items: one registry, three adapters, one PBI. The smallest thing that proves the suspend/resume primitive.

### TBI-016 — Minimal registry with suspend-requires-deadline enforcement

A step type declares whether it can suspend, and if it can, it **must** declare a default deadline or registration fails. Failure happens at application startup, not at first use — a missing deadline discovered mid-run is a suspension nobody can expire.

Register exactly three types. Their deadline defaults are not a blanket value: `cursor-agent` defaults to **60 minutes**, because that is exactly what the existing validation watcher's five-second, 720-attempt loop allows today (`documentValidationService.ts`). Deriving the default from the behavior being replaced is the rule (BR-005).

The registry is the only place a step type is declared. No step-type logic lives outside it.

> **Permission needed:** registry validation at startup means a line in `src/server/index.ts`. Ask first.

*Done when:* a test shows a suspendable type with no deadline fails to register; all three types are registered with their defaults; no step-type logic exists outside the registry.

### TBI-017 — `cursor-agent` adapter: enqueue, correlate, suspend, never await

Executing the step calls `agentRunLifecycleService.enqueue` on the background lane, writes the correlation row into `playbook_step_runs` linking step run to `agent_run_id`, and suspends immediately.

**The adapter must never hold an in-process await on the agent run.** An awaiting adapter is a process-resident waiter that a restart destroys — exactly the failure the engine was adopted to eliminate. Admission is the governor's job, not the adapter's: a full lane means the run waits like any other agent run.

*Done when:* executing the step enqueues and returns without awaiting; the correlation row links step run to agent run id; a test kills the process immediately after enqueue and the step is still suspended, not lost.

*Depends on:* TBI-016.

### TBI-018 — `approval-gate` adapter on the shared suspend/resume primitive

Same primitive as the agent adapter. The only difference is what produces the resume: a human decision instead of a terminal run event. That equivalence (BR-008) is the reason the engine earns its place rather than just moving the polling around.

Phase 0 does no approver-pool resolution — the demo is synthetic. But PBI-004's acceptance criteria say only the party the gate is waiting on may approve. **Decide who that is for Phase 0** (the run initiator is the obvious answer) and write it down; the real pool resolution and the empty-pool inversion land in Epic 3's FEAT-013.

Resuming must be idempotent. A duplicate decision after the run already advanced is a no-op, not an error that corrupts state.

*Done when:* executing the step suspends the run; a recorded decision resumes it at the next step; a duplicate decision is a no-op.

*Depends on:* TBI-016.

### TBI-019 — `notify` adapter asserting the durable notification row

Call `notificationService.createNotification`. **The asserted effect is the row, not the delivery.** Teams push is a best-effort side channel; if it is unconfigured or fails, the step still completes. Classifying by durable effect rather than side channel is the rule the whole `sideEffect` taxonomy rests on later (BR-011).

*Done when:* the step creates a notification row and completes regardless of downstream delivery; a test with delivery unconfigured still shows the step completing; the row is visible in the standard notification center.

*Depends on:* TBI-016.

### PBI-001 — Developer starts a seeded Playbook and its agent step queues without blocking

> As a Developer, I want to start a seeded Playbook and see its first agent step queue immediately, so that I can prove the engine drives a real background agent run without the server blocking on it.

The start endpoint writes the run row, enqueues the first step, and returns — **within 1 second**, before the agent step begins executing. No user-facing action waits on an agent turn.

Four cases to cover: the happy path; a full admission lane, where the run is still created and the step waits rather than failing; a definition with no published version, where the start is refused and **no run row is created**; and a caller without `playbooks:run`, refused the same way.

*Depends on:* TBI-016, TBI-017, and IMPL-001 for the permission key.

---

## FEAT-005 — Durable Suspend/Resume & Structural Guards

Seven items. This feature is where the durability claim is actually made good. The latency path and the correctness path are both required — the sweep is not a nicety.

### TBI-020 — Resume on terminal agent-run event

Subscribe the Playbook runtime to terminal agent-run events — `subscribeRunEvents` in `pgNotifyService.ts` gives cross-instance delivery — and resume the correlated suspended step when one arrives. This is the latency path.

Resume must be idempotent against duplicate delivery, and must advance the run with the completed step's output available to the next step.

*Done when:* a terminal event resumes its correlated step within seconds; duplicate delivery is a no-op; the next step can read the prior step's output.

### TBI-021 — Reconciliation sweep

A scheduled sweep covering three populations: steps whose correlated agent run went terminal but whose Playbook never resumed; steps past their deadline; and steps with no path forward. This is the correctness path — it guarantees delivery when the notification is missed. Notification is the nudge, not the record.

Model it on `agentRunReaperService.startReaper`, registered in `src/server/index.ts` with a `stop` on server close. **Use a Postgres advisory lock** the way `admissionGovernorService` does, so multiple instances do not sweep the same rows.

Query off the `expires_at` index from TBI-013 so a pass scales with suspended steps, not total runs. Make the last-run outcome observable — an invisible sweep is one nobody notices has stopped.

> **Permission needed:** scheduler registration edits `src/server/index.ts`. Ask first.

*Done when:* the sweep resumes any step whose terminal event was missed; it expires any step past its deadline; it runs on a fixed interval with an observable last-run outcome.

*Depends on:* TBI-020.

### TBI-022 — `expired` as a terminal state distinct from `cancelled` and `failed`

Reachable **only** through the sweep's deadline check. No client-side clock decision can produce it, and a run that expires is not retried automatically — a new run must be started deliberately.

*Done when:* a step past its deadline becomes `expired` only via the sweep; the projection surfaces it distinctly from `cancelled` and `failed`; a test confirms no client path can set it.

*Depends on:* TBI-021.

### TBI-023 — Structural guards

Six checks, all synchronous, deterministic, and enforced at publish or admission time: max steps per run, max agent steps per run, max fan-out width, **an outright ban on loops**, a per-project active-run cap, and a separate per-project suspended-run ceiling.

The two caps are separate on purpose. The active-run cap bounds resource use; the suspended-run ceiling bounds orphan accumulation. Collapsing them creates the collision the interview identified: count suspensions against concurrency and a few abandoned runs become a self-inflicted denial of service on that project; do not count them and a fan-out that suspends escapes the only bound there is.

**No guard may read cost data.** Cost is asynchronous, estimate-prone and up to an hour stale by design; it is advisory and never in the execution path (BR-007).

This item also builds the minimal graph validator it lists under technical dependencies — loop detection plus the caps. Write it as the seed of the shared validator that publish-time validation, the execution-time guard and the Phase 4 canvas will all call. Do not write a throwaway the canvas has to replace.

The placeholder values in the PRD (active-run cap of 5, max 10 agent steps per run) are explicitly illustrative, not agreed. See Open Decisions.

*Done when:* a definition with a loop is refused at publish; a project at its active-run cap refuses a new start with an error naming the cap; a project at its suspended-run ceiling refuses a new suspension with an error naming the ceiling.

### TBI-024 — Execution-time initiator-permission re-check

Before any side-effecting step, re-check that the run's initiator **currently** holds the permissions that step requires in that project. Query live permissions via `rbacService.getUserPermissions` — never a value cached at run start.

A failed check fails the step and suspends the run for a human, using the same failure path as any other step failure. Not a silent skip, not a crashed run. This is the mechanism behind the invariant that a Playbook can never do something its initiator could not do by hand, in that project, at that moment.

Phase 0 has no `requiredPermissions` on the registry yet (that is Epic 2's FEAT-008), so the Phase 0 version re-checks the initiator's project access and `playbooks:run`. The hook is what matters; the per-step-type permission list plugs into it later.

*Done when:* a step whose initiator's permission was revoked after start fails at execution, not at start; the failure suspends for human intervention; a read-only step with no required permissions is unaffected.

*Depends on:* TBI-023.

### PBI-004 — Developer approves a run waiting at a gate and it resumes

> As a Developer, I want to approve a run that is waiting at a gate, so that the run picks up at its next step without me touching anything else.

Approval resumes within the same request cycle, with the next step enqueued inside a second. Keyboard-operable.

Four cases: the happy path; a duplicate approval after the run already resumed, which is a no-op; **a gate with no recorded deadline, where the approval is refused with an error naming the missing deadline** rather than silently resuming a suspension that should not exist; and an approval submitted against a run that is not suspended, refused with a clear message.

That third case matters more than it looks. A suspension with no deadline is invisible to the sweep, so it would hang forever. Refusing loudly turns a silent orphan into a reported bug.

*Depends on:* TBI-020.

### PBI-005 — A run whose deadline passes ends in a distinct `expired` state

> As a Developer, I want to see a suspended run that nobody acted on end in a state that clearly says nobody came, so that I can distinguish an abandoned run from one still legitimately waiting.

Four cases: the sweep expires an overdue suspension; the sweep leaves a not-yet-due suspension alone; a deadline passing at the exact instant of a sweep is treated as passed, with no strict margin required; and an already-completed run is never overwritten to `expired` when the sweep walks old rows.

*Depends on:* TBI-021, TBI-022.

---

## FEAT-006 — Phase 0 Status View, Demo Playbooks & Exit Criteria

Seven items. This is the demo itself plus the evidence that it meant something.

### TBI-025 — Wire the status view to the Apex-owned projection exclusively

The view's data path reads the TBI-015 projection and nothing else. **No fallback read of an engine table under any condition** — the view is itself the proof that nothing outside the wrapper needs the engine's store.

Route gated with `requirePermission('playbooks:view')`, project-scoped. Client hook follows the TanStack Query convention in `src/client/hooks/` with a local `fetch` and `credentials: 'include'`.

*Done when:* the view reads only the Apex projection; a test drops every engine-owned table and the view still renders correctly for an in-flight run; the route is gated behind `playbooks:view`.

*Depends on:* TBI-015, IMPL-001.

### TBI-026 — Seed two demo Playbook definitions, A and B

Definition **A**: `cursor-agent` → `approval-gate` → `notify`. Definition **B**: the same three step types in a different order and configuration. Both published through the normal definition/version path, not inserted as fixtures — publishing is part of what B proves.

**Neither writes a pipeline artifact.** No PRD, design doc, test case or validation row is touched. Both are synthetic by design; the real workflow is Phase 2.

*Done when:* A is published in the stated order; B is published as a different composition; both are confirmed to write zero pipeline artifacts.

### TBI-027 — Demo rehearsal script

Write the live sequence with the expected screen state at each point, then rehearse it. The sequence is the six steps at the top of this document.

The script must be **repeatable without manual database cleanup between attempts**. A demo that needs a hand-run `DELETE` between takes will fail in front of an audience.

The restart-while-suspended step is the one to rehearse hardest. It is the whole argument.

*Done when:* the script documents every step with expected screen state; it has been rehearsed end to end at least once with no manual intervention; the restart step resumed correctly on the first attempt.

*Depends on:* TBI-025, TBI-026.

### TBI-028 — Exit criteria E1–E4 as re-runnable tests

| | Criterion | Why it is a test |
|---|---|---|
| **E1** | A gate suspends and resumes correctly after a process restart | Also demoed live |
| **E2** | Process death during a live agent step leaves the step failed-retryable, with no lost prior output and no attempted mid-turn continuation | Unsuitable for a live stage |
| **E3** | Definition B runs end to end with zero lines of code changed from A's deployment | Also demoed live |
| **E4** | Dropping every engine-owned table between two steps leaves the run reconstructible from Apex tables alone | Unsuitable for a live stage |

E2 and E4 are recorded as test evidence rather than staged. Each test must be independently re-runnable — none may depend on another having just run.

*Done when:* all four pass, each with its result recorded against its named criterion.

*Depends on:* TBI-026, TBI-015.

### TBI-029 — Exit criterion E5: name the dependency owner and deputy in writing

Name both, with all five governance duties attached to each: deciding the pin, reviewing the wrapper surface, watching the entitlement list, running the recurring conformance review, and escalating a fallback-trigger finding.

No technical dependency — this is a staffing decision and could close on day one. It is listed last only because it belongs to the exit-criteria feature. **It stays open and blocking until both names are recorded.**

**Check the ADR first.** The interview record suggests two names were already attached to all five duties. If so this is a copy-forward.

*Done when:* the owner is named in writing with all five duties; the deputy is named with the same five as backup; both are recorded in the same place conformance-suite results attach to a pin-move pull request.

### PBI-002 — Developer sees each step's live status and the pinned definition version

> As a Developer, I want to see each step's live status alongside the exact definition version its run pinned, so that I can tell what a running Playbook is doing without reading engine-internal state.

Returns within **2 seconds at P95**, matching the `HOME_DASHBOARD_LOCAL_TIMEOUT_MS` convention. Keyboard-navigable, and every status conveyed by text rather than color alone.

Four cases: a run in progress shows per-step status and names the pinned version; **with every engine table dropped, the view still renders correctly**; a project with zero runs shows an empty state rather than an error; and a user without `playbooks:view` is refused, with no run data returned.

*Depends on:* TBI-025.

### PBI-003 — Developer sees the cause and deadline of every suspension

> As a Developer, I want to see why a run is suspended and by when it must be acted on, so that I know whether a waiting run needs attention before its deadline passes.

The deadline renders in both absolute and relative terms, in the same request and the same 2-second budget as the rest of the view.

Four cases: a suspension shows its cause and deadline; a suspension the sweep has already expired shows `expired` rather than appearing to still wait; **a suspension with no recorded deadline surfaces as a data-integrity warning** rather than quietly omitting the field; and a run with no suspension shows neither.

The third case is the same orphan-detection instinct as PBI-004's refused approval, shown from the reading side.

*Depends on:* TBI-025.

---

## Open decisions to make before or during build

Three of these (1, 2 and 6) are open because the PRD's Assumptions Made section deliberately flagged them as unresolved and named the risk of getting each one wrong. The interview left them open on purpose; Epic 1 is where they get numbers. The other three are code-level choices that only appear once you start writing the step adapters.

| # | Decision | Blocks | Why it cannot wait |
|---|---|---|---|
| 1 | Blob-reference threshold for step outputs | TBI-013 | Too low adds indirection to trivial outputs; too high lets agent transcripts bloat a frequently-read table |
| 2 | Real values for the structural guards — active-run cap, max agent steps per run, max fan-out | TBI-023 | The PRD says 5 and 10 are illustrative, not agreed; the wrong guard gets tightened after an incident |
| 3 | Who may approve a Phase 0 gate, given no pool resolution | TBI-018, PBI-004 | PBI-004 says "only the party the gate is waiting on"; Phase 0 has no resolved pool, so name the run initiator and move on |
| 4 | Whether to seed `playbooks:view` / `playbooks:run` early (IMPL-001) | PBI-001, PBI-002, TBI-025 | A one-line migration; only needs a yes so it is not left to Epic 2 |
| 5 | The `workflowClass` value and thread strategy for Playbook agent steps (IMPL-002) | TBI-017 | `enqueue` will not accept a step without them |
| 6 | Whether the ADR already names the dependency owner and deputy | TBI-029 | Determines whether E5 is real work or a copy-forward |

---

## Environment prerequisites for the demo

Worth checking early, because each one can quietly turn the rehearsal into an in-process fake that proves nothing.

- The `ai-runs-background` flag must be **on** in the demo environment. With it off, `backgroundWorkflowRouter` does not route to the background lane and the cursor-agent step never exercises the admission governor.
- A background worker must be running and reachable, with `APEX_CALLBACK_URL` set so ingest can call back.
- `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT` should be set low enough to demonstrate PBI-001's queue-behind-the-cap case on demand.
- `E2E_MODE` must not be `true`, or the schedulers — including the reconciliation sweep — never start.
- The `playbooks-spike` flag must target the demo environment and no other.

---

## Gaps Epic 1 records but does not close

Found while building, deliberately carried forward. Each is written here rather than only in the
design-spec folder because that folder is not in version control, and a gap nobody can find later is
the same as one nobody wrote down.

**Agent steps cannot be restricted to read-only Skills, and Epic 2's FEAT-008 has to fix it.**

The PRD restricts `cursor-agent` steps to Skills whose MCP configuration is read-only, and FEAT-004's
tech spec asks the adapter to validate that before enqueueing. There is nothing to validate against.
`ExecutionSnapshot.skillPath` is a bare path; SKILL.md frontmatter is parsed but `src/` reads none of
its extra keys; the Agent Skills `allowed-tools` field is known only to `foundation-skills`
validation, never to Apex's execution path.

What looks like read-only today is a property of the lane, not the Skill. The background worker and
interactive actor pass `mcpServers: {}` and hand the agent `createNativeReadTools` — but both still
set `local.cwd` to a writable scratch directory, so the SDK's own write tools keep working. Empty MCP
is not a sandbox. Ask Apex, the one service that advertises itself as read-only, gets there with
prompt text and a minimal MCP map, which is the honour system.

Phase 0 therefore enforces *which* Skills may run rather than *what* they can do: the `cursor-agent`
descriptor carries an explicit allow-list and the adapter refuses anything not named. That is
defensible for synthetic local demos and indefensible the moment a Playbook runs a Skill someone else
wrote. Real enforcement needs a declared capability on the skill manifest, propagation into
`ExecutionSnapshot`, and a central check in `buildMcpServers` and the worker's SDK options — which is
the same contract FEAT-008 builds for `sideEffect` and `requiredPermissions`. It should be built
there, once, rather than approximated twice.

---

## Deferred items and where they stand

Reviewed 2026-09-19, after FEAT-004. Recorded here rather than only in the design-spec folder for the
same reason as the gap above: that folder is not in version control.

**Closed**

- **What "failed-retryable" means as a stored value** (was blocking TBI-024's failure path and exit
  criterion E2). Answered by construction rather than by decision — FEAT-003 shipped it as a distinct
  step-status value while building the schema. It is in the `playbook_step_runs` CHECK constraint, the
  Drizzle table and `PlaybookStepRunStatus`; `failStepRun({ retryable: true })` writes it; and an
  integration test asserts the database accepts it. It sits on the step vocabulary and deliberately not
  on the run vocabulary, because a retryable step does not make the whole run retryable. **FEAT-005
  needs no migration for this**, contrary to what its tech spec previously implied.
- **Which permissions a Phase 0 step re-checks on resume.** The initiator's project access plus
  `playbooks:run`, confirmed as the intended stand-in rather than a no-op. Both checks are real —
  a contributor removed from the project, or one whose `playbooks:run` was revoked, is caught between
  suspension and resume. Epic 2's TBI-036 replaces it with per-step `requiredPermissions`.
- **Which Skill the demo `cursor-agent` steps run.** `.cursor/skills/app-knowledge/SKILL.md`, already
  the sole entry in the `cursor-agent` descriptor's allow-list. Subject to the read-only gap above:
  the allow-list constrains which Skills may be named, not what they can do.
- **`playbooks-spike` targeting.** Enabled and scoped to `environment = local`, verified through the
  real service and not by reading rows — `evaluateFlags` requires at least one rule, so a rule-less
  flag resolves to false however enabled it looks.

**Still open**

- **No worker drains the background lane locally.** `ai-runs-background` is deliberately off: it does
  not gate the Playbook adapter, which calls `enqueue` directly, and turning it on with no worker
  would leave local PRD and design-doc generation queued forever. Blocks the live demo and the
  observable queue-behind-the-cap case; blocks neither the implementation nor its tests.
- **The Blob container for step outputs is unnamed.** Nothing in Phase 0 writes a blob, so naming it
  now would fix a decision with no evidence behind it. Blocks the first large-payload step in Phase 1.
- **Playbook threads resolve to a null usage-entity anchor.** `resolveUsageEntityFromThread` matches
  interviews, PRDs, ADRs and design docs; a Playbook-owned thread matches none. Accepted — cost data
  is advisory and off the execution path per BR-007.
- **Exit criterion E5 has no named owner and deputy.** A staffing decision, not code.

---

## Files that need your explicit permission

Per `.cursor/rules/scope-discipline.mdc`, these are not to be edited as a side effect of the work:

| File | Item | Why |
|---|---|---|
| `package.json` | TBI-007 | Pin the engine packages at exact versions |
| `.eslintrc.json` | TBI-008 | Add the import-boundary rule that fails the build |
| `src/server/index.ts` | TBI-016, TBI-021 | Registry validation at startup; register and stop the reconciliation sweep |

The ADR granted this permission in principle for engine adoption, but I will still ask before each edit.

---

## Risks

**The demo is committed for a near-term date and Wave A can invalidate Waves B through E.** Both fallback triggers land in TBI-001 and TBI-002. If either trips, the program moves to VoltAgent behind the same wrapper boundary — recoverable, but it costs the schedule. Run Wave A first and run it fast.

**The engine's tables and Apex's tables must not share a fate.** If TBI-001 finds the store insists on public-schema DDL under the application role, TBI-014 becomes mandatory and non-trivial rather than a recorded no-op.

**The restart-while-suspended step is the demo.** If it does not work, nothing else in the sequence carries the argument. Rehearse it before polishing anything else.

**The sweep is easy to under-build and it is the correctness path.** Notification delivery is a nudge. If the sweep is missing, weak, or unscheduled, every suspension is one dropped event away from hanging forever, and the failure is silent.

**`expired` must never be a client-side decision.** A client that decides a deadline has passed will disagree with the server under clock skew and show a run as dead while it is still legitimately waiting.

---

## If the schedule gets tight

Ordered by what I would cut first. The first two are recoverable. The last three are not — cutting any of them means the demo proves nothing.

1. **TBI-006** — record the six verification answers as a written memo now, package them as a re-runnable suite after the demo. Costs future pin-move safety, not the demo.
2. **TBI-023's fan-out and suspended-run ceiling** — Phase 0 definitions are linear and seeded, so fan-out cannot occur. Keep loop detection and the active-run cap. Document what was deferred.
3. **Do not cut TBI-015 or TBI-025's projection-only rule.** Reading an engine table "just for the demo" discards the invariant the whole program rests on, and E4 stops meaning anything.
4. **Do not cut TBI-021.** Without the sweep there is no durability claim, only a faster notification.
5. **Do not cut the restart step from TBI-027.** It is the argument.
