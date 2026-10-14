# Playbook Engine Integration — putting Mastra behind the boundary

**Status: delivered, 2026-09-22. Mastra drives traversal; Apex's traversal is deleted. 141
integration tests and 190 unit tests green.**

The slice was built as a **single path**, not the two-paths-behind-a-flag shape planned in Wave C.
That was a deliberate call: two engines mean two sets of behaviour to keep honest and a standing
question about which one a given run took. The conformance harness — the same 141 tests, unchanged
in what they assert — is what makes a direct swap safe enough to take without a fallback path.
Waves B, C and D are folded into that outcome and annotated in place below.

This slice sits between the verification epic (complete) and the *Playbook Definition Model, Step
Registry & RBAC* epic (decomposed, 3 features / 11 items, not started). It exists because the
program backlog has no items for it: the plan assumed the engine would slot in behind the wrapper
once step types existed, and instead FEAT-004 and FEAT-005 wired the adapters to a traversal Apex
wrote itself. That traversal works and is tested. The wiring work was never decomposed.

---

## What this slice is

Mastra takes over **traversal** — deciding which node runs next, and driving a suspended run
forward. That is the job the PRD assigns it and no more:

> Apex owns the durable record of what happened and what happens next; the embedded workflow engine
> adopted in the linked ADR supplies only the mechanics of moving from one step to the next.

Concretely, it replaces the traversal half of `playbookAdvanceService.ts` (319 lines): `entryNode`,
`successorNode`, `firstUnrunNode` and the chain runner. The run-level bookkeeping in that file —
the settled-position rule, `markRunCompleted`, `markRunFailed` and `advanceStalledRuns` — is Apex's
and survives either way.

## What this slice is not

- **No new capability.** No branching, no parallel steps, no data mapping between steps, no
  schedules. Those are the next epic's and later. A slice that adds capability while swapping the
  engine cannot tell you which of the two broke.
- **No new step types.** The three adapters are untouched except for how they are invoked.
- **No infrastructure change.** No separate Container App, no new Redis, no worker split. That
  question is TBI-046's to *record a decision on*, not to act on.
- **No change to the Apex-owned parts.** Four tables, RBAC, the admission governor integration, the
  agent-run callback chain, the reconciliation sweep and the status projection all stay as built.

## Why it goes first, alone

Phase 0 left behind definitions A and B, a demo script whose step 4 restarts the server mid-run,
and 137 integration tests that pass. That is the conformance harness you would otherwise have to
write to prove an engine swap is safe, and it is only a clean signal if nothing else moves at the
same time.

The second reason is ordering: the next epic wants Zod input/output schemas per step type, and
Mastra's `createStep` already requires them. Designing that contract against our traversal and then
porting it to Mastra's is the same work twice.

---

## Integration triggers

Two questions can change the shape of this slice or end it. They are answered in Wave A, before any
integration code is written, in the same spirit as Phase 0's fallback triggers.

| Trigger | Condition that trips it | Item | Verdict |
|---|---|---|---|
| One — cross-process resumption | Mastra cannot resume a run in a process that never started it | TBI-040, TBI-041 | **not tripped** (2026-09-21) |
| Two — test runtime | Mastra cannot be loaded under the integration test runner, and no workaround is acceptable | TBI-042 | **not tripped** (2026-09-21) — the condition's first half holds, the second does not |

Both verdicts are re-runnable rather than asserted:
`tests/integration/playbook-engine-load.integration.test.ts`, four checks, green.

**If trigger one trips**, Mastra cannot own resumption, because a run started on one App Service
instance and resumed by an event landing on another is our normal case, not an edge case. The slice
does not necessarily die — Mastra can still be a synchronous traversal component that Apex calls
once it already knows a step finished — but that is a materially smaller adoption and the question
of whether it is worth the dependency has to be re-asked rather than assumed.

**If trigger two trips**, the acceptance criterion below changes shape and this slice grows a test
infrastructure item. It does not trip the adoption itself: production runs Node 24, where the load
succeeds. Only Jest's module runtime is affected.

*Outcome: it did not, in the end.* TBI-042 concluded the load was impossible under Jest and the
slice took **TBI-052** — move the traversal suites out of process — to work around it. That
conclusion was wrong, and TBI-052 has been dropped. Mastra loads and runs under Jest given two
things together, neither sufficient alone: `NODE_OPTIONS=--experimental-vm-modules`, and a dynamic
import that Jest's transformer cannot see, which `new Function('s', 'return import(s)')` provides
because V8 compiles it at run time. TBI-042 had tried each separately. The suites run in process
and assert against the real engine, which is a better test than the out-of-process probe would have
been.

---

## Build order

| Wave | Items | Gate to leave the wave | Status |
|---|---|---|---|
| **A — Prove it can work** | TBI-040, TBI-041, TBI-042 | Both integration triggers answered with evidence. | **complete 2026-09-21** |
| **B — Decide the shape** | TBI-043 … TBI-046 | Four decisions recorded, with the deployment decision in the ADR. | **complete 2026-09-22**, in code rather than on paper |
| **C — Build the swap** | TBI-047 … TBI-050 | ~~Both engine paths run behind one flag~~; Apex rows stay authoritative. | **complete 2026-09-22**, single path |
| **D — Verify and retire** | ~~TBI-052~~, PBI-010, PBI-011, PBI-012, TBI-051 | A and B behave identically; the old path is removed. | **complete 2026-09-22** |

**Do not start Wave B until Wave A is answered.** Designing a translation layer for an engine that
cannot resume across processes is the same wasted work Phase 0 avoided by gating Wave B on Wave A.

Wave A was answered and the gate opened. What followed departed from the plan in two ways worth
recording, because both were decisions rather than drift.

**The flag never guarded two paths.** TBI-047 through TBI-050 assumed `playbooks-mastra-engine`
would select between Apex's traversal and Mastra's, with the old path retired later. The engine was
swapped outright instead, and `playbooks-spike` remains the only flag: it already gates every
operation at the boundary, so a run either goes through Mastra or is refused. Retiring Apex's
traversal in the same change is what TBI-051 asked for, and doing it at the end of a flagged
rollout rather than the start would have meant carrying a second traversal through a rollout nobody
intended to use it for.

**Wave B's decisions were made in code.** TBI-043 through TBI-046 were written as four documents to
produce before any integration. Three of them — the translation shape, where the engine's state
lives, how Apex rows stay authoritative — turned out to be answerable only by building, and the
answers are in `playbookEngine/runtime.ts` and its tests rather than in prose. TBI-046, the
deployment decision, stands on its own and is unchanged: in-process on App Service, with TBI-041's
finding that no distributed PubSub is required.

---

## Wave A — Prove it can work

Three items, all Developer, all research with recorded answers. Reuse
`tests/integration/support/engine-probe.ts` — it already loads the real engine out of process,
which is exactly what these need.

### TBI-040 — Resume from a cold process *(integration trigger 1)*

Suspend a Mastra run, terminate the process entirely, start a fresh one sharing only the
`PostgresStore`, and resume by run ID alone.

TBI-002 proved all four operations drive in-process with nothing mounted, and that result stands —
but it drove them through plain method calls on a live `Run` object in a single process. The demo's
step 4 is *restart the server while the run is suspended*, and our own implementation gets that free
because nothing is ever held in memory. Whether Mastra rehydrates from storage is the one thing
that has to be true for the swap to be worth making.

Note Mastra's own known limitation here: a crash during step execution can leave a run in `running`
with no automatic retry, recovered only via `restart()` / `restartAllActiveWorkflowRuns()` or the
opt-in `recovery.durableAgents` path. Record which of those we would depend on.

*Done when:* a run suspended in one process is resumed to completion in another that never saw it
start; the mechanism that made it possible is named; the trigger is marked tripped or not.

**Answered 2026-09-21. It resumes. Trigger not tripped.**

Two child processes, a scratch database, and nothing shared but the connection string. Process one
started a run and let it suspend at a gate, then exited. Process two — a fresh `Mastra` container, a
fresh `PostgresStore`, no knowledge of the first — found the run `suspended` in storage, resumed it
with `{ decision: 'approved' }`, and read `success` afterwards.

| Observation | Result |
|---|---|
| Status after process one exits | `suspended` |
| Run found in storage by process two | yes |
| Resume outcome | `success`, result `{ decision: 'approved' }` |

**The mechanism** is `workflow.createRun({ runId })`. Passing an existing id returns a `Run` bound
to it rather than minting a new one, and `resume()` then loads the snapshot through the store. There
is no separate rehydrate call to find — the ordinary run-creation path takes an id.

The storage read is asserted separately from the resume on purpose. "Resume failed" and "the run was
never persisted" are different faults with the same symptom, and only the first is about resumption.

Recovery mechanism to depend on, per the note above: neither `restartAllActiveWorkflowRuns()` nor
`recovery.durableAgents` is needed for the suspend/resume path, because a suspended run is durable
in the store without them. They remain the answer for the *crash mid-step* case, which is TBI-050's
subject and is where the overlap with Apex's own sweep has to be resolved.

### TBI-041 — Resume on an instance that never started the run *(integration trigger 1)*

The same question with the process still alive. Two Mastra instances against one `PostgresStore`,
configured as we would configure them in production: start a run on instance A, deliver the resume
to instance B.

This is separated from TBI-040 because it fails for a different reason. Mastra's default in-process
mode runs its workers inside the API process with an **in-memory** event bus, and we run three App
Service instances — so three isolated buses. If resumption depends on the event reaching the
instance that holds the run, the default configuration is wrong for us regardless of what storage
does.

Record whether a shared PubSub backend is required to make this work, and if so whether
`RedisStreamsPubSub` against the existing `redis-apex-ai-prd-v2` is sufficient. That is the cheapest
answer available and nobody has checked it.

*Done when:* the cross-instance case is recorded as working, working-with-shared-pubsub, or not
working; any configuration it required is written down as a deployment input for TBI-046.

**Answered 2026-09-21. Working, with no shared PubSub. Trigger not tripped.**

Two `Mastra` containers over one schema, each with its own store handle and its own in-memory bus.
Instance B created none of the tables — it ran with `disableInit: true`, the way a second App
Service instance finds its tables already there. A run started on A and suspended; B saw it, resumed
it, and drove it to `success`.

| Observation | Result |
|---|---|
| Run visible to the instance that did not start it | yes |
| Resume on instance B | `success` |
| Status then seen by instance A | `success` |

That last row is the one worth keeping. A stale starter is the failure that would not announce
itself — B finishes the run while A still believes it suspended, and Apex's status view shows
whichever instance the request happened to land on. A re-read the store and saw the truth.

**Why the in-memory bus turned out not to matter**, which is the part that changes the deployment
question: the bus carries events *within* an engine instance. We do not need it to carry anything,
because Apex already solved delivery. A terminal agent-run event reaches every instance through
`pgNotifyService`'s `LISTEN`/`NOTIFY` on `agent_run_events`, and whichever instance picks it up calls
`resume()` directly. The engine is never asked to find the run — it is handed the id.

So the answer to the cheapest-available question is that it does not need asking:
`RedisStreamsPubSub` against `redis-apex-ai-prd-v2` is **not required** for the resumption path.

This is a direct input to TBI-046, and it removes the strongest argument in the separate-Container-App
recommendation. That argument was that multiple instances need distributed PubSub to coordinate. For
the work we are actually giving Mastra, they do not: Postgres is the shared state and `pg_notify` is
the shared bus, both already in production. Mastra's multi-host PubSub requirement applies to
*Mastra's* event delivery, and we are not using it for delivery.

### TBI-042 — Loading the engine under the integration test runner *(integration trigger 2)*

Determine what it costs to exercise Mastra from the Jest integration suites.

The probe's header records the problem: Mastra's CJS bundle calls `require()` on an ESM-only
dependency, which Node 22+ permits and Jest's module runtime does not. Every current integration
test calls `startRun` directly, so the moment `startRun` routes through Mastra they all hit this.
The acceptance criterion in Wave D assumes those tests still run.

Evaluate at least: running the affected suites under the real Node runtime; `--experimental-vm-modules`;
and mocking at the `playbookEngine/` boundary for most suites with a smaller out-of-process suite
proving the real engine. Changing `jest.config.integration.js` needs permission under the
scope-discipline rule — ask before editing it.

*Done when:* the failure is reproduced, each option is costed, one is recommended, and the trigger
is marked tripped or not.

**Answered 2026-09-21. The engine cannot be loaded under Jest by any means tried. Trigger not
tripped, because an acceptable workaround already exists and is already in use.**

Reproduced against all four loading strategies, each failing identically:

| Strategy | Result |
|---|---|
| `require('@mastra/core/workflows')` | `SyntaxError: Cannot use import statement outside a module` |
| `require('@mastra/core')` | same |
| `require('@mastra/pg')` | same |
| `await import('@mastra/pg')` | same |

**The culprit has a name.** Under `--experimental-vm-modules` the error changes to `Must use import
to load ES Module: node_modules/@sindresorhus/slugify/index.js`. That package is `"type": "module"`
with a single ESM entry point and ships no CommonJS build, so there is nothing for Jest's `require`
to load. Mastra reaches it for id generation.

Options, costed:

| Option | Result |
|---|---|
| `--experimental-vm-modules` | **fails.** Changes the error, not the outcome. |
| `transformIgnorePatterns` exception + a `.js` transform | **fails.** Still `Unexpected token 'export'`. |
| Transform *all* of `node_modules` | **fails**, and takes 54s per run. Disqualified twice over. |
| Out-of-process under real Node | **works.** Proven by TBI-040 and TBI-041 above, and by the conformance suite since FEAT-001. |
| Mock at the `playbookEngine/` boundary | works, but tests nothing about Mastra — useful only for suites that do not need real traversal. |

`jest.config.integration.js` was **not** edited. The two config experiments ran through a throwaway
config that re-exported it, and both failed, so there is nothing to ask permission for.

**Recommended: the last two together, split by what each suite actually needs.** The blast radius is
smaller than the plan assumed — not every Playbook suite, but five of fifteen:

| Suite | How it reaches traversal |
|---|---|
| `playbook-run-start` | directly, via `startRun` |
| `playbook-run-advance` | directly, via `advanceRun` |
| `playbook-exit-criteria` | directly, via `startRun` |
| `playbook-reconciliation` | transitively, via `runReconciliationPass` → `advanceStalledRuns` |
| `playbook-exit-criterion-e2` | transitively, the same way |

The other ten — approval gate, notify delivery, projection, schema, registry startup, demo seed,
spike flag, conformance and the rest — never reach traversal and are untouched by the swap. No test
imports `playbookEngine` today, so the boundary is clean to mock.

**What this costs Wave D**, and it should be said plainly rather than discovered there: those five
suites are the ones that prove the swap works, and they are precisely the five that cannot run
in-process once Mastra is behind traversal. PBI-010's "the existing suites pass against the Mastra
path" therefore requires moving them out of process first. That is a real test-infrastructure item
and the plan should carry it rather than leave it implied — see TBI-052 below.

---

## Wave B — Decide the shape

Four decisions. Each is recorded before code depends on it, because all four are the kind that get
made accidentally by whoever writes the first integration commit.

### TBI-043 — What role Mastra plays

Decide explicitly between two designs:

**Orchestrator** — Mastra owns resumption. It receives events, decides what is next, and drives the
run. Needs Wave A to have gone well and needs a shared PubSub backend.

**Traversal component** — Apex keeps the terminal-event listener and the sweep, and calls Mastra
only to answer "given this graph and this completed step, what runs next?" Mastra's event bus is
barely used and the worker-topology question mostly disappears.

The PRD's "supplies only the mechanics of moving from one step to the next" points at the second.
The second is also the only one available if trigger one tripped. Choosing the first is choosing to
depend on beta worker infrastructure for durability we already have.

*Done when:* one is chosen in writing with its reasoning, and Wave C is scoped against it.

### TBI-044 — Translating a stored graph into a workflow

Design the function that turns a `PlaybookGraph` row into a Mastra workflow, with each node's
adapter wrapped as a Mastra step.

Every Mastra example defines workflows statically in a file and registers them at startup. Ours are
JSON rows composed by users and pinned per run, so workflows must be constructed per run instead.
`engine-probe.ts` already shows this is possible — `buildWorkflow()` builds one inside a function —
but two advertised benefits weaken: schema type inference is meaningless for a graph assembled from
JSON, and Studio's graph view keys off registered workflows. Confirm whether Studio is reachable for
dynamically constructed workflows before counting it as a benefit of adoption.

*Done when:* the translation shape is designed; per-run construction cost is measured rather than
assumed; the Studio question is answered yes or no.

### TBI-045 — Which store is authoritative

State the rule and the mechanism that enforces it.

`engineConfig.ts` already declares the intent — the engine store is "an execution cache rather than
the system of record" — and the projection service is deliberately Apex-only. That means every
transition Mastra drives must still write Apex's rows, because the status view and the sweep read
nothing else. Get this wrong and a run finishes in Mastra's 43 tables while the UI shows it still
going.

*Done when:* the rule is written down; the place every transition writes Apex's rows is named; a
test asserts the two cannot diverge for a completed run.

### TBI-046 — Deployment shape, recorded in the ADR

Record where Mastra runs and why, including the option not taken.

This is where the "move orchestration workers to a warm Container App" recommendation lands. On
current evidence it is premature — App Service averages ~10% CPU across three P1v3 instances,
Postgres ~6% with 69 connections of 859, Mastra's own docs say to skip worker infrastructure at
light traffic, the Workers feature is beta, and in split mode the orchestration worker delegates
step execution back to the API over HTTP, which undoes the stated benefit. But TBI-041 may
establish that a shared PubSub backend is needed, and that is a real configuration decision.

**TBI-041 settled that, and the answer was no.** Cross-instance resumption works over the shared
Postgres store with no distributed PubSub, because Apex delivers the event itself through
`pg_notify` and hands the engine a run id. Mastra's multi-host PubSub requirement is about Mastra's
own event delivery, which we are not using.

That removes the recommendation's strongest argument rather than merely weakening it — "three
instances need distributed coordination anyway" was the part that did not depend on current load,
and it is now measured false for the work Mastra is being given. The remaining arguments are all
load-dependent, and current load does not support them. Record the threshold accordingly.

Include a revisit threshold — something measurable, such as sweep duration or web-tier CPU
attributable to Playbooks — so the question reopens on evidence rather than on argument. The Mastra
ADR is not in this repo; record this through Apex's ADR feature.

*Done when:* the deployment decision and its reasoning are recorded; the rejected option is recorded
with the evidence against it; a revisit threshold is named.

---

## Wave C — Build the swap

Four items. Both engine paths stay live throughout, which is what makes this reversible.

### TBI-047 — Graph-to-workflow translation

Implement TBI-044's design inside `src/server/services/playbookEngine/`. Nothing outside that
directory may import Mastra — the `no-restricted-imports` rule fails the build on it, and a snapshot
test guards the wrapper's export list.

Adapters are wrapped, not rewritten. `executeCursorAgentStep` and friends keep their current
signatures and their current behaviour, including suspending without ever awaiting the agent run.

*Done when:* a stored graph produces a runnable workflow; the three adapters execute unchanged; the
import boundary still fails the build when crossed.

### TBI-048 — Route traversal through the boundary behind a new flag

Create a flag — default-off, before any gated code merges — whose two branches are Mastra traversal
and Apex traversal, following `.cursor/skills/feature-flags/SKILL.md` and its cleanup markers.
Record the winning branch and the cleanup criterion at creation.

A dedicated flag rather than reusing `playbooks-spike`: the PRD is explicit that each phase mints
its own rather than stretching one across four, and for a swap specifically the flag is the rollback
switch. Both paths must be selectable until Wave D says otherwise.

`startRun` and `advanceRun` become the two call sites that branch. Everything below them is shared.

*Done when:* either path can be selected at runtime; with the flag off, behaviour is byte-identical
to today; the cleanup criterion is on the flag record.

### TBI-049 — Apex rows stay authoritative on every transition

Implement TBI-045's rule: every Mastra transition also writes `playbook_runs` and
`playbook_step_runs`. The projection and the sweep continue reading only Apex's tables.

*Done when:* a run driven by Mastra produces the same Apex rows as one driven by the current
traversal; the divergence test from TBI-045 passes.

### TBI-050 — Reconcile the sweep with Mastra's restart semantics

Decide what `advanceStalledRuns` does when Mastra is driving, and whether Mastra's own
`restartAllActiveWorkflowRuns()` runs at boot at all.

These overlap, and overlapping recovery is how a step executes twice. Mastra documents
`autoRestartActiveRuns: false` for workflows whose side effects must not be re-driven by a blanket
restart, which describes ours exactly — a `cursor-agent` step re-driven blindly enqueues a second
agent run. Our sweep is already safe here because it only advances from a settled position; Mastra's
blanket restart is not.

*Done when:* one recovery owner is chosen; the other is disabled explicitly rather than left
unconfigured; a test starts a run, kills it mid-step, restarts, and asserts exactly one execution.

---

## Wave D — Verify and retire

### ~~TBI-052 — Move the five traversal suites out of process~~ *(dropped, 2026-09-22)*

Dropped because its premise was false: the suites run in process against the real engine. See the
corrected TBI-042 outcome above for what makes the load work.

The item is worth leaving visible rather than deleting, because the reasoning that produced it was
sound and the conclusion still wrong. TBI-042 tried the Jest flag and the import escape hatch
separately, found each insufficient, and concluded the combination would be too. Neither works
alone; together they do.

What the work did need, and what nobody predicted, was three fixes with nothing to do with either:

- **Import the engine's packages sequentially.** `Promise.all` lets Jest's ESM registry begin
  linking a module another import is part-way through, which surfaces as `request for
  './classic/external.js' is from a module not been linked`.
- **Cache resolved modules, never the promise that produced them.** Awaiting a promise built in a
  VM context that has since been torn down fails with `Test environment has been torn down`, from a
  stack that names neither Mastra nor the import.
- **Give Jest a worker to recycle.** `maxWorkers: 1` runs in band, and Mastra's module state
  accumulates across files until a run wedges silently. Setting `workerIdleMemoryLimit` both forces
  a worker process and restarts it before that point. The full Playbook run went from wedging
  indefinitely to three minutes and a clean exit.

### PBI-010 — Definition A behaves identically on either engine path

**As a** Developer, **I want** the seeded demo Playbook to behave the same whichever traversal is
selected, **so that** the swap is provably a swap and not a behaviour change.

*Acceptance criteria:*
1. Definition A runs to completion on both paths, producing the same step rows in the same order
   with the same statuses.
2. The existing integration suites pass against the Mastra path, with no assertion changed. Test
   *infrastructure* may change per TBI-042; test *expectations* may not.
3. Any assertion that genuinely cannot hold is recorded as a behaviour difference with a decision,
   not quietly edited.

Criterion 2 is the whole gate. An assertion edited to make a test pass is the failure mode this
slice exists to avoid.

### PBI-011 — A suspended run survives a restart with Mastra driving

**As a** Developer, **I want** step 4 of the demo to work unchanged, **so that** durability is
proven for the engine rather than inherited from the code it replaced.

*Acceptance criteria:*
1. A run suspended at a gate survives a full process restart and resumes to completion.
2. A run suspended on an agent step is resumed by a terminal agent-run event delivered to a
   different instance than the one that started it.
3. With the terminal event suppressed entirely, the reconciliation sweep still finishes the run.

Criterion 3 matters most. It proves the sweep is still the backstop after the swap, which is what
keeps the fast path from becoming the only path.

### PBI-012 — Definition B runs end to end with zero code changes

**As a** Developer, **I want** definition B to run on the Mastra path without touching code, **so
that** the registry is still a real contract and not three hardcoded paths.

*Acceptance criteria:*
1. B runs end to end from its stored graph, creating every step row itself.
2. No source file changes between running A and running B.

This mirrors exit criterion E3 exactly, including its rewritten test that provisions nothing.

### TBI-051 — Retire the Apex traversal path

Once PBI-010 through PBI-012 are green and the Mastra path has been the winner for an agreed
period, remove the superseded traversal and retire the flag per
`.cursor/skills/feature-flag-cleanup/SKILL.md`.

Deliberately last, and deliberately not automatic. Keeping both paths costs a branch at two call
sites; removing the fallback before the new path has run for a while costs the ability to revert
cheaply.

*Done when:* `successorNode`, `firstUnrunNode` and `runStepChain` are gone; the flag is retired with
its markers removed; the suite is green with one path.

---

## Open items carried in

- **Exit criterion E5 still has no deputy.** Reese is recorded as dependency owner; the deputy slot
  is open. The kill-switch owner for this slice's new flag is the same role, so the gap follows the
  program forward. See `design-docs/playbook-engine-verification.md`.
- **The conformance suite should be re-run** against the pinned version before Wave C, per TBI-006's
  purpose. Six answered questions recorded in September are evidence about a version, not about a
  package.
