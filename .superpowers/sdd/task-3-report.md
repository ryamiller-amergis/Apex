# Task 3 implementation report

## Result

- Status: `DONE`
- Branch: `tbi/infra-changes`
- Implementation commit: `201f470e`
  (`feat: dispatch interactive classes from the orchestrator`)
- No push, pull request, cloud operation, infrastructure change, deployment
  change, migration application, or protected configuration change was made.
- Only Task 3 source and test paths were staged for the implementation commit.
  Pre-existing worktree changes remained unstaged.

## Implementation summary

- Added a direct interactive actor client with separately injected fast and
  agentic URLs. It posts to only the endpoint selected by the persisted class,
  requires `2xx` plus `{ "accepted": true }`, and has no endpoint or App
  Service fallback.
- Added the 16-turn interactive ceiling, two fast floor slots, two agentic
  floor slots, and work-conserving shared burst.
- Added deterministic floor-aware FIFO planning. Model is not present on an
  admission candidate and is not read for eligibility or ordering.
- Added bounded interactive outbox claiming: oldest 16 globally plus oldest
  two fast and oldest two agentic rows, deduplicated and returned by
  `(created_at, id)`.
- Isolated background claims from `interactive_dispatch`, while preserving the
  existing Service Bus route for `dispatch_command`.
- Added direct-class utilization from persisted
  `agent_runs.interactive_class` for dispatched/running `dapr-actor-v2`
  attempts. Queued turns do not consume execution slots.
- Added fenced state reads, one-time dispatched persistence, durable dispatched
  phase events, idempotent replay of the same attempt/fence, and hard-timeout
  terminalization with durable error/done events.
- Kept PostgreSQL `NOTIFY` as the normal wake and the existing 30-second sweep
  as recovery.

## Strict TDD evidence

### Initial endpoint and floor red

Command:

```text
npx jest src/server/__tests__/aiOrchestrator/providerGovernor.test.ts src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts --runInBand
```

Before implementation:

```text
FAIL: 2 test suites
- interactiveActorDispatchClient module did not exist
- evaluateInteractiveCapacity did not exist
- fast floor remained four and interactiveCap was absent
Exit code: 1
```

### FIFO, claim, state, replay, and utilization red

Command:

```text
npx jest src/server/__tests__/aiOrchestrator/admissionController.test.ts src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts src/server/__tests__/aiOrchestrator/utilizationReader.test.ts src/server/__tests__/aiRunV2RunAttemptRepository.test.ts src/server/__tests__/aiRunV2OutboxRepository.test.ts --runInBand
```

Before implementation:

```text
FAIL: 5 test suites
Tests: 27 failed, 25 passed
Exit code: 1
```

The failures showed that FIFO floor planning, isolated interactive claims,
claim release, fenced interactive state methods, direct actor dispatch,
crash/lost-response replay, hard-timeout terminalization, and Dapr class
utilization were absent.

### Self-review red/green

Self-review found two replay edge cases and added regressions before their
fixes:

- event source sequences were run-wide and would collide on a later retry
  attempt
- an attempt could become terminal between the initial state read and an
  `already-dispatched` result

Red output:

```text
FAIL: 3 tests
- dispatched source omitted attempt identity
- timeout source omitted attempt identity
- terminal race performed no confirming state read
Exit code: 1
```

The repository now uses attempt-specific event sources, and replay rechecks
state before invoking. A focused mutation run also proved the terminal-race
test fails without that second read, then passes with it restored.

## FIFO and floor invariants

1. Interactive execution slots are counted only from persisted fast/agentic
   classes on dispatched/running direct-actor attempts.
2. Total interactive in-flight work never admits a seventeenth queued turn.
3. While slots remain, the planner selects the oldest `(createdAt, outbox.id)`
   candidate belonging to a class below its two-slot floor.
4. Once floor deficits are filled, or when a deficit class has no queued work,
   the planner selects the oldest remaining candidate regardless of class.
5. A released slot therefore serves a waiting floor-deficit class before older
   borrowed work, symmetrically for fast and agentic.
6. Equal timestamps use outbox ID as the only tie-breaker.
7. `available_at` is an eligibility filter, never an interactive sort key.
8. Model is absent from planner inputs, claim SQL, capacity evaluation, and
   ordering.
9. Dispatched/running recovery rows already consume a utilization slot and are
   reinvoked without charging another slot or applying the cap twice.

## Dispatch and recovery invariants

- Background `dispatch_command` rows use only the existing Service Bus
  publisher.
- `interactive_dispatch` rows use only the direct class client.
- A queued turn is marked dispatched under its attempt/fence, its run header
  and dispatched phase are persisted, and only then is the class endpoint
  invoked.
- The outbox row is marked published only after `{ accepted: true }`.
- A crash or lost response leaves the same attempt dispatched. Claim expiry
  reuses the same attempt, fence, class, and payload.
- A terminal replay is published without another actor invocation.
- Fence mismatch and missing attempt rows end the invalid outbox dispatch
  without invoking either transport.
- Capacity deferral releases the claim for five seconds without a failure
  metric. Invocation errors retry after ten seconds.
- A row at or beyond its absolute deadline is fencedly failed with
  `hard_timeout`; the run, attempt, thread, and durable error/done events are
  updated in one transaction.

## Green verification

Required Task 3 command:

```text
npx jest src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts src/server/__tests__/aiOrchestrator/providerGovernor.test.ts src/server/__tests__/aiOrchestrator/admissionController.test.ts src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts src/server/__tests__/aiOrchestrator/utilizationReader.test.ts src/server/__tests__/aiRunV2RunAttemptRepository.test.ts src/server/__tests__/aiRunV2OutboxRepository.test.ts --runInBand
```

Final output:

```text
PASS: 7 test suites
PASS: 66 tests
Exit code: 0
```

Server type-check:

```text
npm run build:server
> tsc -p tsconfig.server.json
Exit code: 0
```

Diff checks:

```text
git diff --check -- <Task 3 paths>
git diff --cached --check
Exit code: 0
```

Focused lint found no Task 3 implementation error. It still reports the
pre-existing `Function` type error in `entrypoint.ts` line 56 and the
pre-existing unused `AI_RUN_V2_WORKLOAD_LANES` warning in `types.ts`; neither
line was changed by Task 3. Unit runs also retain the known unset
`DATABASE_URL` and npm `devdir` warnings.

## Files changed

- `src/server/services/aiOrchestrator/interactiveActorDispatchClient.ts`
- `src/server/services/aiOrchestrator/types.ts`
- `src/server/services/aiOrchestrator/providerGovernor.ts`
- `src/server/services/aiOrchestrator/admissionController.ts`
- `src/server/services/aiOrchestrator/outboxDrainer.ts`
- `src/server/services/aiOrchestrator/utilizationReader.ts`
- `src/server/services/aiOrchestrator/entrypoint.ts`
- `src/server/services/aiRunV2/runAttemptRepository.ts`
- `src/server/services/aiRunV2/outboxRepository.ts`
- `src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts`
- `src/server/__tests__/aiOrchestrator/providerGovernor.test.ts`
- `src/server/__tests__/aiOrchestrator/admissionController.test.ts`
- `src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts`
- `src/server/__tests__/aiOrchestrator/utilizationReader.test.ts`
- `src/server/__tests__/aiRunV2RunAttemptRepository.test.ts`
- `src/server/__tests__/aiRunV2OutboxRepository.test.ts`
- `.superpowers/sdd/task-3-report.md`

The two existing repository test files are included because Task 3 adds their
public methods and the required green command explicitly runs those suites.

## Self-review

- Confirmed the branch remains `tbi/infra-changes`.
- Confirmed direct endpoint configuration uses exactly
  `AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL` and
  `AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL`.
- Confirmed no interactive path calls the Service Bus publisher.
- Confirmed no direct-dispatch path calls App Service execution.
- Confirmed no model reference exists in interactive admission, capacity,
  utilization, or claim code.
- Confirmed direct-actor endpoints and policy values are injected; no worker
  endpoint default was added.
- Confirmed all new class, outbox-kind, attempt-state, and dispatch-result
  switches have exhaustive `never` branches.
- Confirmed retry attempts use attempt-specific event source identities.
- Confirmed pre-existing unrelated worktree changes were not staged.
- Confirmed no infrastructure, deployment, environment example, or protected
  configuration file was changed or staged.

## Concerns

None specific to Task 3.

---

## Review remediation

### Result

- Status: `DONE`
- Review-fix commit: `97cb5f54`
  (`fix: harden interactive orchestrator dispatch`)
- No push, cloud operation, infrastructure change, deployment change,
  migration, environment example, or protected configuration change was made.
- Only Task 3 source and test paths were staged. Pre-existing worktree changes
  remained unstaged.

### Fixes

#### Mixed capacity

- Added a dedicated `interactiveClassInFlight` counter for direct Dapr fast and
  agentic work. Service Bus `laneInFlight.fast/agentic` no longer changes the
  Dapr 2/2 floors or direct ceiling.
- Both transports still contribute to `cursorInFlight`.
- Added one mutable capacity reservation shared by direct and background
  planners for the whole leased drain cycle.
- Direct floor planning runs first, then background planning uses the remaining
  provider capacity. A cycle cannot reserve more than 20 Cursor slots.
- Direct planning remains capped at 16, floor-aware, FIFO by
  `(created_at, id)`, and model-independent.

#### Deadline at invocation

- The drainer reads the injected clock immediately before each direct row and
  again immediately before HTTP.
- Expired rows are fencedly terminalized without HTTP.
- Direct calls now receive the absolute deadline and an `AbortSignal`; the
  deadline is also forwarded in `x-apex-dispatch-deadline`.
- Invocation races an absolute-deadline timer. At expiry it aborts fetch,
  persists `hard_timeout`, durably discards the outbox row with
  `deadline_expired`, releases the reservation, and continues to the next row.
- The race bounds the row even if an injected fetch implementation ignores
  abort.

#### Same-lease refill

- The drainer now reclaims bounded pages under the same distributed lease after
  stale, invalid, missing, or terminal rows are removed.
- The loop stops on no eligible rows, no progress, or the fixed eight-page
  limit.
- Seen outbox IDs prevent a broken repository fake or claim race from spinning
  on the same row.
- Background candidates remain claimed while direct stale windows refill, so a
  valid floor-eligible direct turn gets the shared Cursor slot before
  background planning.

#### Invalid durability

- Added `markDiscarded`, which terminally removes a row from eligibility while
  preserving `last_error`; it does not use the successful publication path.
- Malformed rows with a safe attempt/fence are fencedly failed as
  `validation_failed`, an existing Task 1 category, with durable error/done
  events.
- Malformed rows without a safe identity retain `invalid_payload` on the
  outbox row.
- Missing attempts and stale fences retain `attempt_not_found` and
  `fence_mismatch` respectively and never invoke either transport.
- Valid terminal replays remain idempotent successful acknowledgements; they
  do not emit another actor call or failure.

### Strict TDD evidence

Review regression command before fixes:

```text
npx jest src/server/__tests__/aiOrchestrator/providerGovernor.test.ts src/server/__tests__/aiOrchestrator/admissionController.test.ts src/server/__tests__/aiOrchestrator/utilizationReader.test.ts src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts src/server/__tests__/aiRunV2RunAttemptRepository.test.ts src/server/__tests__/aiRunV2OutboxRepository.test.ts --runInBand
```

Red output:

```text
FAIL: 7 test suites
Tests: 27 failed, 53 passed
Exit code: 1
```

The failures proved mixed transports shared lane counters instead of direct
class counters, planners could independently over-reserve Cursor, fetch had no
deadline signal, clock changes between rows were ignored, one page could hide
valid work for 30 seconds, and invalid rows were marked as successful with
their reason cleared.

### Final verification

Focused Task 3 suite:

```text
PASS: 7 test suites
PASS: 80 tests
Exit code: 0
```

Mixed orchestrator/V2 lifecycle suite:

```text
PASS: 5 test suites
PASS: 72 tests
Exit code: 0
```

The mixed suite covers consumers/reconciliation, V2 admission, completion
convergence, V2 contracts, and the shared agent-run lifecycle.

Server type-check:

```text
npm run build:server
> tsc -p tsconfig.server.json
Exit code: 0
```

Focused lint and diff:

```text
ESLint: 0 errors, 0 warnings
git diff --check: exit 0
git diff --cached --check: exit 0
```

Test output retains the existing unset `DATABASE_URL`, intentional lifecycle
log, npm `devdir`, and ESLint legacy-configuration warnings.

### Review-fix files

- `src/server/services/aiOrchestrator/interactiveActorDispatchClient.ts`
- `src/server/services/aiOrchestrator/types.ts`
- `src/server/services/aiOrchestrator/providerGovernor.ts`
- `src/server/services/aiOrchestrator/admissionController.ts`
- `src/server/services/aiOrchestrator/outboxDrainer.ts`
- `src/server/services/aiOrchestrator/utilizationReader.ts`
- `src/server/services/aiRunV2/runAttemptRepository.ts`
- `src/server/services/aiRunV2/outboxRepository.ts`
- `src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts`
- `src/server/__tests__/aiOrchestrator/providerGovernor.test.ts`
- `src/server/__tests__/aiOrchestrator/admissionController.test.ts`
- `src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts`
- `src/server/__tests__/aiOrchestrator/utilizationReader.test.ts`
- `src/server/__tests__/aiRunV2RunAttemptRepository.test.ts`
- `src/server/__tests__/aiRunV2OutboxRepository.test.ts`
- `.superpowers/sdd/task-3-report.md`

### Final self-review

- Confirmed Service Bus fast/agentic rows affect global Cursor usage but never
  Dapr floor counts.
- Confirmed direct and background planning mutate the same reservation and
  direct floor eligibility receives the first shared slot.
- Confirmed every direct HTTP call receives the persisted class, deadline, and
  abort signal; there is no App Service or cross-class endpoint fallback.
- Confirmed timeout, invalid-payload, stale-fence, and missing-attempt rows
  retain durable reasons and do not increment successful-publication metrics.
- Confirmed bounded refill stays under the existing outbox lease and does not
  wait for the 30-second safety sweep.
- Confirmed no model reference exists in capacity, claim, FIFO, or endpoint
  selection.
- Confirmed no unrelated or protected file was staged.

### Concerns

None specific to these review findings.

---

## Review remediation (refill races)

### Result

- Status: `DONE`
- Review-fix commit: `099c4f42`
  (`fix: close interactive outbox refill races`)
- Previous reviewed range ended at `f9275c88`.
- No push, cloud operation, infrastructure change, deployment change,
  migration, environment example, or protected configuration change was made.
- Only Task 3 source, test, and this report path were staged. Pre-existing
  worktree changes remained unstaged.

### Fixes

#### Seen/deferred claim leak on refill

- `claimInteractiveCandidates` now accepts optional `excludeIds` and omits
  those rows from the eligible CTE (`NOT (id = ANY(...))`).
- The drainer passes the same-lease `seenOutboxIds` set into every interactive
  claim page so a deferred row that becomes due again during a slow invoke is
  not re-selected ahead of deeper work.
- As a safety net, any re-claimed seen row is immediately `releaseClaim`ed under
  the same holder instead of being dropped while still owned.

#### In-cycle reservation release before replanning

- Added a shared `releaseInteractiveClassReservation` helper on the mutable
  reservation ledger (class + Cursor + provider interactive counters, clamped
  at zero).
- Terminal publishes and malformed rows that fencedly terminalize an attempt
  with a known interactive class release one reserved slot before planning the
  remaining queued candidates in the same drain.
- Existing capacity-charged expire/replay release paths reuse the same helper
  so a row cannot double-subtract.

### Strict TDD evidence

Red (before fixes):

```text
FAIL: excludes seen deferred rows on refill after a slow invoke
FAIL: releases reserved utilization when terminal and malformed rows finalize
FAIL: excludes already-seen outbox ids from interactive claim selection
Exit code: 1
```

Green after fixes on the same three regressions.

### Final verification

Focused Task 3 suite:

```text
PASS: 7 test suites
PASS: 83 tests
Exit code: 0
```

Mixed orchestrator/V2 suite:

```text
PASS: 20 test suites (aiOrchestrator + aiRunV2)
PASS: 205 tests
Exit code: 0
```

Additional mixed lifecycle/admission suite:

```text
PASS: 5 test suites
PASS: 63 tests
Exit code: 0
```

Server type-check:

```text
npm run build:server
> tsc -p tsconfig.server.json
Exit code: 0
```

Focused lint/diff:

```text
ReadLints: 0 errors
git diff --check: exit 0
```

### Review-fix files

- `src/server/services/aiOrchestrator/outboxDrainer.ts`
- `src/server/services/aiRunV2/outboxRepository.ts`
- `src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts`
- `src/server/__tests__/aiRunV2OutboxRepository.test.ts`
- `.superpowers/sdd/task-3-report.md`

### Final self-review

- Confirmed deferred/seen rows cannot keep claim ownership after being skipped.
- Confirmed refill under the same lease can reach a deeper valid row without
  waiting for claim expiry or the 30-second sweep.
- Confirmed saturated snapshots free class/Cursor slots when terminal/malformed
  rows finalize before planning, and queued work can dispatch in the same drain.
- Confirmed reservation decrements are clamped and shared through one helper.
- Confirmed no unrelated or protected file was staged.

### Concerns

None specific to these two remaining races.

---

## Review remediation (capacity over-release)

### Result

- Status: `DONE`
- Review-fix commit: `da03b2ad`
  (`fix: prevent interactive capacity over-release`)
- Previous reviewed range ended at `a3dbbcc6`.
- No push, cloud operation, infrastructure change, deployment change,
  migration, environment example, or protected configuration change was made.
- Only Task 3 source, test, and this report path were staged. Pre-existing
  worktree changes remained unstaged.

### Problem

The prior in-cycle reservation release treated first-read terminal leftover
ACKs and any successfully discarded malformed row with a known interactive
class as capacity owners. That freed mutable slots the utilization snapshot
never counted for those attempts, so a saturated drain could admit a 17th
interactive turn. `discardInvalidRow` also ignored `failInvalid` outcomes, so
fence-mismatch / not-found / queued terminalization could still release.

### Fixes

#### Explicit charged-capacity ownership

- `failExpiredInteractiveDispatch` / `failInvalidInteractiveDispatch` now
  return a discriminated result with `priorAttemptStatus` and
  `capacityCharged` when an attempt is newly terminalized.
- `capacityCharged` is true only for prior `dispatched` / `running` status
  (the same set utilization counts for Dapr interactive work).

#### Release only when charged ownership is proven

- First-read terminal leftover ACKs publish the outbox row and do **not**
  release a mutable slot.
- Malformed discard releases only when `failInvalid` returns
  `terminalized` with `capacityCharged: true`.
- Queued terminalization, fence mismatch, not-found, and already-terminal do
  **not** release.
- Genuinely charged expire / charged malformed terminalization frees exactly
  one slot so one waiter can dispatch in the same drain.
- Planner-charged selected queued turns still release on successful
  `terminalized` expire via the candidate's ledger `capacityCharged` flag.

#### Single release per attempt per drain

- `processInteractiveRows` tracks `releasedAttemptIds` and refuses a second
  decrement for the same attempt id in one drain cycle.

### Strict TDD evidence

Red (before fixes):

```text
FAIL: does not free a saturated slot for a first-read terminal leftover ACK
FAIL: does not free a slot when queued malformed terminalization succeeds
FAIL: does not free a slot on malformed fence mismatch with a live replacement
Exit code: 1
```

Green after fixes on those regressions plus:

- frees exactly one charged dispatched slot and dispatches one waiter
- does not double-release the same charged attempt in one drain
- repository reports `capacityCharged` for dispatched terminalization

### Final verification

Focused Task 3 suite:

```text
PASS: 7 test suites
PASS: 88 tests
Exit code: 0
```

Mixed orchestrator/V2 suite:

```text
PASS: 20 test suites (aiOrchestrator + aiRunV2)
PASS: 210 tests
Exit code: 0
```

Additional mixed lifecycle suite:

```text
PASS: 5 test suites
PASS: 237 tests
Exit code: 0
```

Server type-check:

```text
npm run build:server
> tsc -p tsconfig.server.json
Exit code: 0
```

Focused lint/diff:

```text
ReadLints: 0 errors
git diff --check: exit 0
```

### Review-fix files

- `src/server/services/aiOrchestrator/outboxDrainer.ts`
- `src/server/services/aiRunV2/runAttemptRepository.ts`
- `src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts`
- `src/server/__tests__/aiRunV2RunAttemptRepository.test.ts`
- `.superpowers/sdd/task-3-report.md`

### Final self-review

- Confirmed saturated 16 + terminal leftover ACK defers the waiter under
  `interactive_cap` and does not admit a 17th turn.
- Confirmed queued malformed terminalization and fence-mismatch discards do
  not free slots.
- Confirmed charged dispatched malformed terminalization frees exactly one
  slot and dispatches one waiter.
- Confirmed repeated expire + malformed rows for the same attempt release once.
- Confirmed no unrelated or protected file was staged.

### Concerns

None specific to this capacity-ownership fix.

## Review remediation: planner-owned reservation release

### Spec reference

Final Task 3 review (after charged-only release) found planner-owned
mutable reservation slots still leaked when:

- expire returned `already-terminal`
- mark returned `fence-mismatch` / `not-found`
- `markInteractiveDispatched` threw before durable ownership

Utilization-only recovery must still keep the slot on fence mismatch so a
live replacement is not over-admitted. Waiters deferred before dispatch could
not observe a slot freed during dispatch in the same drain.

### Implementation

- Track `reservationOwned` separately from utilization-backed `capacityCharged`.
- Terminal sync releases when either flag is set.
- Abandon paths (fence mismatch, not-found, mark throw, terminalize failure)
  release only when `reservationOwned`.
- Defer unselected waiters only after dispatch/refill so a freed planner slot
  can admit them in the same drain.

### Verification

```text
PASS: outboxDrainer 28 tests
PASS: aiOrchestrator 6 suites / 70 tests
npm run build:server → exit 0
ReadLints: 0 errors
```

### Review-fix files

- `src/server/services/aiOrchestrator/outboxDrainer.ts`
- `src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts`
- `.superpowers/sdd/task-3-report.md`
