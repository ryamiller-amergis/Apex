# Playbook Engine Verification Record

> **Work item:** FEAT-001 — Mastra Verification Spike & Fallback Decision
> **Branch:** `labs/mastra-poc`
> **Engine under verification:** Mastra — `@mastra/core@1.67.0`, `@mastra/pg@1.25.0` (exact pins, installed 2026-09-18)
> **Status:** complete — all six questions answered; see the Verdict Summary at the end

This file is the written record for the six verification questions in FEAT-001. It is read
directly by `tests/integration/playbook-engine-conformance.integration.test.ts`, which asserts
that every question has an explicit answer and fails — never skips — when one is missing.

**How to use this file.** Run a verification step, then replace the `not yet answered` markers in
that step's section with what you actually observed. Do not delete a marker without recording an
answer: the conformance suite treats a missing marker and a missing answer identically, and both
fail. Record what happened, including results that are inconvenient.

**Marker vocabulary.** The suite recognises exactly these values, backticked:

| Marker | Meaning |
|--------|---------|
| `not yet answered` | The question has not been investigated. The conformance check fails with this reason. |
| `tripped` | A fallback trigger fired. Per BR-004 this halts Epic 1 pending an ADR supersession. |
| `not tripped` | The fallback trigger was evaluated and did not fire. |
| `yes` / `no` | A boolean finding was observed. |

---

## Fallback trigger verdicts

Only these two questions can send the program to VoltAgent. Per BR-004 the dependency owner may
hold or move the version pin but may **not** decide the fallback alone — abandoning Mastra is an
ADR supersession. A verdict of `tripped` halts FEAT-002 through FEAT-006.

| Trigger | Condition that trips it | Item | Verdict |
|---------|-------------------------|------|---------|
| Trigger one | The store insists on public-schema DDL under the application role with no confinement option | TBI-001 | `not tripped` |
| Trigger two | The engine requires mounting its own HTTP endpoints as the only way to drive it | TBI-002 | `not tripped` |

---

## TBI-001 — Postgres store table creation and schema confinement

**Status:** answered — fallback trigger one **not tripped**

Initialize the store against a scratch database with Apex migrations applied. Read
`information_schema.tables` before and after to capture exactly what appeared and in which schema,
then snapshot the connection role's grants from `information_schema.role_table_grants`.

Reading Mastra's source to infer this is not sufficient. Source tells you what the code intends;
the question is what it does under Apex's role.

| Sub-question | Finding |
|--------------|---------|
| (a) Does the store auto-create its tables on initialization under the application role? | **Yes.** `new PostgresStore({...}).init()` created 43 tables. Auto-creation is the default behaviour. |
| (b) Can that auto-creation be disabled or pointed at migration-created tables? | **Yes.** With `disableInit: true` the same call created **0** tables in the target schema. Suppression is a supported option, not a workaround. |
| (c) Can the store be confined to a dedicated schema owned by a restricted role? | **Yes.** With `schemaName: 'playbook_engine'`, run under a role owning only that schema and explicitly revoked from `public`, `init()` succeeded and every table landed in `playbook_engine`. |

**Tables observed after initialization:**

```tbi-001-tables
playbook_engine.mastra_agent_versions
playbook_engine.mastra_agents
playbook_engine.mastra_ai_spans
playbook_engine.mastra_background_tasks
playbook_engine.mastra_channel_config
playbook_engine.mastra_channel_installations
playbook_engine.mastra_dataset_items
playbook_engine.mastra_dataset_versions
playbook_engine.mastra_datasets
playbook_engine.mastra_experiment_results
playbook_engine.mastra_experiments
playbook_engine.mastra_favorites
playbook_engine.mastra_knowledge_activity
playbook_engine.mastra_knowledge_cursors
playbook_engine.mastra_knowledge_mentions
playbook_engine.mastra_knowledge_nodes
playbook_engine.mastra_knowledge_records
playbook_engine.mastra_knowledge_semantic_outbox
playbook_engine.mastra_mcp_client_versions
playbook_engine.mastra_mcp_clients
playbook_engine.mastra_mcp_server_versions
playbook_engine.mastra_mcp_servers
playbook_engine.mastra_messages
playbook_engine.mastra_notifications
playbook_engine.mastra_observational_memory
playbook_engine.mastra_prompt_block_versions
playbook_engine.mastra_prompt_blocks
playbook_engine.mastra_resources
playbook_engine.mastra_schedule_triggers
playbook_engine.mastra_schedules
playbook_engine.mastra_scorer_definition_versions
playbook_engine.mastra_scorer_definitions
playbook_engine.mastra_scorers
playbook_engine.mastra_skill_blobs
playbook_engine.mastra_skill_versions
playbook_engine.mastra_skills
playbook_engine.mastra_thread_state
playbook_engine.mastra_threads
playbook_engine.mastra_tool_provider_connections
playbook_engine.mastra_workflow_definitions
playbook_engine.mastra_workflow_snapshot
playbook_engine.mastra_workspace_versions
playbook_engine.mastra_workspaces
```

**Role grants outside the dedicated schema:**

```tbi-001-grants
none
```

**Notes:** Observed empirically, not read from source. Method: create a scratch database, apply all
246 Apex migrations so `public` holds the real 101 Apex tables, create role `playbook_engine_role`
owning only schema `playbook_engine`, `REVOKE ALL ON SCHEMA public` and `ON ALL TABLES IN SCHEMA
public` from it, then connect **as that role** and call `init()`. Tables were diffed from
`information_schema.tables` before and after; grants from `information_schema.role_table_grants`.

Result: 43 tables created, **0 in `public`**, and **0 grants held outside `playbook_engine`**. None
of the 101 Apex tables was touched.

Two observations worth carrying forward. First, the store creates 43 tables covering far more than
workflow state — agents, datasets, skills, knowledge, MCP servers and more — so the isolated schema
is doing real work, not cosmetic tidiness. Only `mastra_workflow_snapshot` and
`mastra_workflow_definitions` matter to Phase 0. Second, `disableInit: true` is documented as the
path for running migrations separately from runtime, which is the shape FEAT-002 wants: migrate the
schema deliberately, then run the application with DDL rights withheld.

This settles the ADR's stated risk — *"If Mastra cannot disable automatic DDL, it may use only a
migration-created, isolated Postgres schema and a role with no rights elsewhere. If it requires
application-role DDL in the public schema, phase 0 fails."* It does not require that, and both
escape hatches the ADR asked for are available.

---

## TBI-002 — In-process driving with no engine HTTP surface

**Status:** answered — fallback trigger two **not tripped**

Drive each operation from a plain function call with no server adapter constructed, then assert the
Express router stack contains no engine-contributed layer. Record each of the four operations
separately — a partial answer such as "start works in-process but cancel needs the adapter" is a
tripped trigger, not a pass.

| Operation | Driven in-process with zero mounted endpoints? |
|-----------|-----------------------------------------------|
| start | **Yes** — `run.start({ inputData })` returned status `suspended`. |
| suspend | **Yes** — raised from inside the step via the `suspend()` callback; no external call. |
| resume | **Yes** — `run.resume({ step, resumeData })` returned status `success` with result `{"decision":"approved"}`. |
| cancel | **Yes** — `run.cancel()` on a second run left it at status `canceled`. |

| Sub-question | Finding |
|--------------|---------|
| (c) Does the Express route table contain any engine-contributed path? | **No.** An Express 4 app's router stack held 0 layers before constructing the engine and 0 after driving a full workflow lifecycle through it. |

**Operations with no in-process equivalent:**

```tbi-002-gaps
none
```

**Notes:** Method: build a one-step approval-gate workflow with `createStep`/`createWorkflow` from
`@mastra/core/workflows`, register it in a `Mastra` container backed by the confined `PostgresStore`,
and drive the whole lifecycle through plain method calls on the `Run` object. No server adapter was
constructed and nothing was mounted.

The router stack was walked via `app._router.stack` on an Express 4 app. Express 4 creates `_router`
lazily, so a count of 0 before and after is the correct reading of "no layer was added" — note that
the `app.router` getter throws a 3.x deprecation error and must not be used for this check.

The full in-process surface lives on `Run.prototype`: `start`, `resume`, `cancel`, `watch`, `stream`
and `restart` are all plain methods. Suspension is expressed as a callback handed to the step's
`execute`, which means an approval gate never needs an inbound HTTP route to pause — it just returns.
That is precisely the shape the ADR's "no second public HTTP surface" constraint requires.

---

## TBI-003 — Database pool acceptance and connection budget

**Status:** answered

Attempt to hand Apex's existing `pg.Pool` to the store's configuration. If refused, read the
store's default pool size from the package rather than guessing.

| Sub-question | Finding |
|--------------|---------|
| (a) Does the store accept an injected Apex-managed pool or client? | **Yes.** Passing `{ pool }` gave `store.pool === injectedPool`, and all 43 tables were created through that pool. Acceptance is genuine, not a silently ignored option. |
| (b) If it creates its own, what is its default pool size? | **20.** Note this is not `pg`'s own default of 10 — Mastra sets its own. An explicit `max` is honoured (verified with `max: 3`). |

### Connection budget

Every pool in the process must be declared here. The conformance suite sums the pool rows and
fails if the total reaches `max_connections`, or if the engine has no line of its own.

| Pool | Declared max connections | Source |
|------|--------------------------|--------|
| Apex application pool | `5` | `src/server/db.ts` — `DB_POOL_MAX` env override, defaulting to 5 |
| Engine store pool | `20` | TBI-003 (b) — the store's default when it builds its own pool |
| Database `max_connections` | `100` | `SHOW max_connections` |

Worst case per instance is `5 + 20 = 25` of 100, a margin of 75. Because `max` is honoured, the
engine line is a decision rather than a constant: pinning it to 5 puts the per-instance total at 10.

**Notes:** There is a real trade-off here that FEAT-002 has to settle, and the two safe options pull
against each other.

Injecting Apex's existing pool costs **zero** additional connections, but the engine then runs as the
Apex application role — which forfeits the role confinement TBI-001 established, since that role has
rights across `public`. Schema confinement via `schemaName` survives; role confinement does not.

Giving the engine its own pool under the restricted `playbook_engine` role preserves both kinds of
confinement, at the cost of up to 20 connections unless `max` is set lower.

The recommendation is the separate pool with an explicit low `max`, because TBI-001 showed role
confinement is achievable and it is the stronger guarantee — the ADR's whole storage-isolation branch
depends on it. The ADR already anticipated the cost: *"Mastra adds a separately managed database
pool."* Raising the budget is the database owner's call; at a 75-connection margin it is not needed
now, but a per-instance engine pool multiplies across App Service instances and should be declared
before scale-out.

---

## TBI-004 — Enterprise entitlement diff

**Status:** answered

The ADR's entitlement list was supplied by the operator on 2026-09-18 from the Apex ADR module. Its
`## Decision Outcome` states: *"Apex will not configure Mastra's RBAC, FGA, SSO, agent-builder, or
other paid features."* That is the recorded list this diff compares against.

The current list was read from the pinned package itself rather than a pricing page, because the
package's own `LICENSE.md` names the commercial carve-out and is tied to the exact version under
verification. In `@mastra/core@1.67.0` the carve-out is every directory named `ee/`:

| Module | Contents | In the ADR's list? |
|--------|----------|--------------------|
| `@mastra/core/auth/ee` | `fga-check`, `capabilities`, `license`, `telemetry` | Yes — covers the ADR's FGA, RBAC and SSO |
| `@mastra/core/agent-builder/ee` | `allowlist`, `picker`, `policy`, `normalize-candidate` | Yes — the ADR's agent-builder |
| `@mastra/editor/ee` | Named in `LICENSE.md`; `@mastra/editor` is not installed | **No — not named in the ADR** |
| `@mastra/pg@1.25.0` | No `ee/` directories at all — wholly Apache-2.0 | n/a |

| Sub-question | Finding |
|--------------|---------|
| (a) Does the current entitlement list differ from what the ADR recorded? | Only by one addition. `agent-builder` and `FGA` are confirmed still commercial. `RBAC` and `SSO` are not separate modules but sit inside `auth/ee` via `capabilities`, so the ADR's naming is broader than the packaging, not wrong. `@mastra/editor/ee` is named in the licence and absent from the ADR — a new entry, though Apex does not install `@mastra/editor`. |
| (b) Has any feature Apex depends on moved behind a commercial licence since the ADR? | **No.** Apex depends on workflows, the Postgres store, and in-process driving. `workflows.d.ts` and `storage.d.ts` sit at the package root under Apache-2.0, and `@mastra/pg` contains no `ee/` content whatsoever. |

**Licence terms:** Mastra Enterprise Edition (EE) License v1.0, Copyright 2026 Kepler Software, Inc.
Production use requires a written agreement with Kepler; modification for internal development and
testing is permitted. Rights terminate automatically on non-compliance, curable within 30 days.

**The EE licence is marked "Effective August 24, 2026."** Resolved 2026-09-19: the repo owner
confirmed the ADR was written well after that date, so its entitlement statements describe the
licence revision recorded above rather than an earlier one. The ADR's own risk register still
applies to future revisions ("Open-core licensing can change in future releases despite current
configuration checks"), so this entitlement diff has to be re-run whenever the pin moves.

That re-run is enforced rather than remembered: `src/server/__tests__/playbookEnginePins.test.ts`
compares the versions named in this file's header against the versions pinned in `package.json` and
fails when they diverge. The conformance suite re-measures DDL behaviour, pool size, telemetry and
the contract tests against the live engine, but it cannot re-derive the licensed-key list above —
that still takes a person reading the new release's LICENSE.md and `ee/` directories.

**Source URL:** `node_modules/@mastra/core/LICENSE.md` at the pinned version, which cites
`https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE` — fetched and read in full.
**Retrieved on:** `2026-09-18`

### Commercially licensed feature keys

FEAT-002's TBI-009 reads this block directly as the input to its licence-configuration assertion
test. Record one key per line so a test can consume it. If the list is genuinely empty, record the
single line `none` — an empty block is treated as unanswered.

```licensed-keys
@mastra/core/auth/ee
@mastra/core/agent-builder/ee
@mastra/editor/ee
```

**Notes:** The keys above are module paths, not feature names, because that is what FEAT-002's
`no-restricted-imports` rule can actually enforce. The ADR named capabilities (RBAC, FGA, SSO,
agent-builder); the packaging groups RBAC, FGA and SSO under one `auth/ee` path. Blocking the three
paths above therefore covers every capability the ADR listed.

Cross-reference for TBI-005: `auth/ee/telemetry.d.ts` places a telemetry surface inside the
commercial carve-out. That is a packaging observation only — whether the Apache-2.0 engine emits
outbound calls is still an open question that TBI-005 must measure, not infer.

---

## TBI-005 — Telemetry kill switch

**Status:** answered — with an important qualification, read the notes

Run the same workflow twice, kill switch disengaged then engaged, observing at the egress boundary.

**The control run carries the weight.** If no calls are observed with telemetry *enabled*, the
observation method is broken and the test run proves nothing. The conformance suite fails when the
control observation is missing, even if the test observation looks clean.

| Run | Kill switch | Outbound calls observed | Count |
|-----|-------------|-------------------------|-------|
| Control | disengaged | `no` — only `tcp localhost:5432`, the scratch database | `0` external, `2` total |
| Test | engaged (`MASTRA_TELEMETRY_DISABLED=1`) | `no` — identical to control | `0` external, `2` total |

| Sub-question | Finding |
|--------------|---------|
| (c) Did suppression turn out to be log-line suppression only? | **Not applicable.** Nothing was suppressed because nothing was emitted. The in-process workflow path made no outbound call in either run, so there was no log-line-versus-network distinction to draw. |

**Observation method:** In-process recorder at `tests/integration/support/egress-recorder.ts`,
hooking `undici:request:create` via `diagnostics_channel`, the `http`/`https` client functions, and
`net.Socket.prototype.connect`. Chosen over a network proxy because a proxy only sees libraries that
honour `HTTP_PROXY`, whereas this observes every outbound attempt the process makes — including ones
that fail DNS, which are still attempts. Its own control run
(`tests/integration/egress-recorder-smoke.test.ts`) proves each layer sees traffic when traffic
exists. Residual limitation: a native addon bypassing Node's socket layer would go unrecorded; the
engine's control run is what rules that out.

**Notes:** Both runs drove a full start → suspend → resume workflow against the confined store, with
the recorder active for the whole window. Each recorded exactly two calls, both `tcp localhost:5432`,
and zero external destinations. The runs are indistinguishable.

**Read the control run carefully.** This section warns that a silent control run means a broken
instrument and a worthless result. That is not what happened here, and the distinction matters:

- The recorder was demonstrably live during the measurement — it captured the database connections in
  the same window, so it was not simply asleep.
- Its own control run (`tests/integration/egress-recorder-smoke.test.ts`) proves all four layers
  observe traffic when traffic exists, including a call to an unresolvable external host.

So "zero" is a measured absence, not a failed measurement. What the control run could **not** do is
exercise the kill switch, because the baseline was already zero — there was nothing for
`MASTRA_TELEMETRY_DISABLED` to suppress. The switch remains untested in the only sense that matters:
we never saw it change anything, because nothing needed changing.

The likely reason is visible in the package: `isTelemetryEnabled()` is documented as running at
*server startup* and respecting `MASTRA_TELEMETRY_DISABLED`. Apex never starts Mastra's server — it
drives the engine in-process, which is exactly the TBI-002 finding. The anonymous telemetry path
appears to belong to the server and CLI surfaces Apex does not use.

⚠ **Scope of this result.** It covers the in-process workflow path with a Postgres store and nothing
else. If Apex later mounts Mastra's server, enables observability exporters, or adopts agent
features, this measurement does not carry over and must be repeated. Setting
`MASTRA_TELEMETRY_DISABLED=1` regardless costs nothing and is worth doing as a belt-and-braces
default, on the understanding that this spike did not prove it works — only that it was not needed.

---

## TBI-006 — Conformance suite

**Status:** partially satisfied — see below

The suite lives at `tests/integration/playbook-engine-conformance.integration.test.ts` and runs
through `npm run test:integration`.

| DoD | State |
|-----|-------|
| DoD-0 — all six questions re-runnable as automated checks | **Satisfied.** All 13 checks (VT-01 … VT-13) are implemented and passing. The live-engine checks drive the real engine through `tests/integration/support/engine-probe.ts`; the rest assert this record. |
| DoD-1 — an unevaluable check fails rather than skips | Implemented and self-asserted by VT-12. Verified negatively: removing the instrument-validation citation from TBI-005 makes VT-11 fail rather than pass quietly. |
| DoD-2 — output attached to the pin-move pull-request template | Blocked. No pin-move template exists in `.github/`, and creating one is an unresolved scope question. |

Every live check asserts the engine's observed behaviour **against what this record claims**, so the
suite fails if the engine changes or if the record drifts away from it. That is the property that
makes it useful before a version-pin move.

**Deviation from the VT matrix, recorded deliberately.** VT-06 specifies "an Express app with Apex's
routes mounted". The check uses a bare Express app instead. Mounting Apex's real router would require
booting `src/server/index.ts`, and it would only add Apex's own layers, which the check would then
have to subtract. The operative claim — that the engine contributes no layer — is proven either way,
and the bare app proves it more directly: the stack is 0 before and 0 after.

### How to re-run before a pin move

```
docker start apex-postgres            # or: node .ai-pilot/start-pg.js
npx jest --config jest.config.integration.js tests/integration/playbook-engine-conformance.integration.test.ts
```

The suite builds and drops its own database. It needs a local Postgres and nothing else — no
production access, no credentials, no network.

### Open decisions recorded during synthesis

| Decision | Resolution |
|----------|------------|
| How the suite gets a database | Built at `tests/integration/support/scratch-db.ts`, adapted from `scripts/e2e/create-test-db.mjs`. Creates a uniquely named database, applies all 246 migrations via the `node-pg-migrate` CLI, and drops it afterwards. Refuses non-local hosts unless `ALLOW_REMOTE_SCRATCH_DB=1`, so the suite cannot issue DDL against a shared server. Verified 2026-09-18: 101 tables in ~3s, clean drop. |
| Engine version to verify | `@mastra/core@1.67.0` and `@mastra/pg@1.25.0`, both latest on npm as of 2026-09-18 and pinned exactly in `devDependencies`. Latest-at-spike-time was chosen because the engine-choice ADR was unreachable to confirm what version it assumed. Both require `node>=22.13.0`; the repo runs v22.23.1. |
| Pin-move pull-request template | Unresolved. `.github/PULL_REQUEST_TEMPLATE.md` exists but is generic, and `.github/` is a protected path. |

---

## Verdict summary

All six questions are answered. Neither fallback trigger is tripped, so the ADR's decision to adopt
Mastra stands and FEAT-002 through FEAT-006 are unblocked.

| Question | Outcome |
|----------|---------|
| TBI-001 — store DDL and confinement | 43 tables, all in `playbook_engine`, **0 in `public`**, **0 grants outside** its schema. `disableInit` suppresses DDL entirely. Trigger one **not tripped**. |
| TBI-002 — in-process driving | start, suspend, resume and cancel all driven as plain method calls; Express router stack 0 before and 0 after. Trigger two **not tripped**. |
| TBI-003 — pool and connection budget | Injected pool accepted outright; default own-pool is 20 and an explicit `max` is honoured. Worst case 25 of 100 connections. |
| TBI-004 — entitlement diff | Nothing Apex depends on is commercially licensed. The `ee/` carve-out is `auth` and `agent-builder` only; `@mastra/pg` has none. |
| TBI-005 — telemetry | Zero outbound calls in both the control and test runs. Measured, not assumed — but the kill switch was never exercised because the baseline was already zero. |
| TBI-006 — conformance suite | All 13 checks implemented and passing; unevaluable questions fail rather than skip. |

**Carry these into FEAT-002.** The governance scaffolding should encode the
migration-created-schema plus `disableInit: true` pattern, restrict imports to the three
`ee/` paths recorded under TBI-004, and declare the engine pool size explicitly rather than
inheriting the default of 20. TBI-003's notes set out the trade-off between injecting Apex's pool
and preserving role confinement; the recommendation there is a separate pool with a low `max`.

**Two open items, neither blocking.** The ADR's date should be checked against the Enterprise Edition
licence revision of 2026-08-24 (see TBI-004). And DoD-2 still has no pin-move pull-request template.

**Recommendation:** `proceed with Mastra`
**Decided by:** `verification spike on labs/mastra-poc — pending dependency-owner sign-off`
**Date:** `2026-09-18`

---

## Exit criterion E5 — dependency owner and deputy

**Status: RECORDED, 2026-09-22. Both roles are held by Reese.**

This is the place TBI-029 requires the names to live: the same document the re-runnable conformance
results are attached to when a pin-move pull request is raised, which is DoD-2's actual requirement.

| Role | Name | Recorded |
|------|------|----------|
| Dependency owner | Reese | 2026-09-20 |
| Deputy | Reese | 2026-09-22 |

E5 no longer blocks. The names are recorded, the duties below are assigned, and the criterion asked
for a table with both rows filled.

**What is still true, and belongs on the record rather than in an argument.** One person in both
rows is a table that is complete and a rota that is not. The deputy exists to cover the week the
owner is away — the conformance suite covers a version *changing*, and nothing covers a licence
revision landing while the only person who watches for it is on leave. That exposure is unchanged
by this entry; it is now an accepted risk rather than an open action, and naming a second person at
any point removes it without touching code. Phase 1 is a reasonable moment to revisit it, since
that is when Playbooks first become reachable by people other than their authors.

Each name carries all five duties, and they are listed here so that recording a name is not mistaken
for recording the job:

1. **Deciding the pin** — holding or moving the Mastra version, per BR-004.
2. **Reviewing the wrapper surface** — that nothing outside the wrapper reads an engine-owned table.
3. **Watching the entitlement list** — the `ee/` carve-out recorded under TBI-004, which a quiet
   licence revision can change without any code moving.
4. **Running the recurring conformance review** — re-running the suite and recording a hold-or-move
   verdict even when the version has not moved.
5. **Escalating a fallback-trigger finding** — the owner may hold or move the pin but may **not**
   decide the fallback alone; abandoning Mastra is an ADR supersession.

**Why this was open at all.** Checked 2026-09-20. The interview record states plainly that *"Owner and
deputy were never named. Any name appearing in a generated artifact for those roles was inferred, not
supplied"*, and the transcript shows the agreement recorded as `Owner: [NAME]. Deputy: [NAME].` —
placeholders that were never filled. Earlier design-spec artifacts described this as a copy-forward
from the ADR; that was an inference, and it was wrong.

**Why the deputy row was held open for two days.** The interview's reasoning was that the conformance
suite covers *replacement* while the deputy covers *absence*. Filling both rows with one name was
therefore put back to the team once, on 2026-09-20, rather than recorded silently — a table that
looks complete is otherwise indistinguishable from a rota that is. The team's answer on 2026-09-22
was Reese for both, and that is what stands. The reasoning is kept here so the next person to read
this row knows it was a decision and not an oversight.
