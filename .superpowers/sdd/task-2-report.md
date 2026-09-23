# Task 2 implementation report

## Result

- Status: `DONE_WITH_CONCERNS`
- Branch: `tbi/infra-changes`
- Implementation commit: `486290a2`
  (`feat: persist interactive turns atomically`)
- No push, pull request, cloud operation, infrastructure change, deployment
  change, migration application to a deployed database, or protected
  configuration change was made.
- Only the Task 2 implementation/test paths were staged for the implementation
  commit. Pre-existing worktree changes remained unstaged.

## Implementation summary

- Added immutable Blob attachment upload using a content-addressed key,
  `If-None-Match: *`, decoded-byte size validation, supported-type validation,
  metadata verification on an existing object, and deterministic actor
  materialization paths.
- Added run-bound ADO tool grants using AES-256-GCM and an HKDF-SHA256 key
  derived from `SESSION_SECRET` with the approved salt and info values.
- Added the fixed five-minute/20-minute absolute deadline policy, preservation
  of the existing first-event/tool/repository preparation sources, and
  remaining-time clamping.
- Added the sole PostgreSQL writer for durable interactive admission. It writes
  the message, immutable attachment rows, queued run, first attempt/fence,
  interactive outbox row, queued event, and active thread state in one
  transaction.
- Added capability-only turn preparation. Model is resolved only after
  classification and remains a frozen execution input.
- Replaced the exported send boundary with the canonical
  `ai-runs-v2-transport` split. Flag false/evaluation error invokes the private
  legacy callback. Flag true invokes only durable admission; admission errors
  do not cross into App Service Cursor/model execution.
- Kept the interim `ai-runs-interactive` actor path intact and reachable only
  inside the private legacy send implementation.
- Changed the HTTP response boundary to await durable admission and return the
  accepted turn/run/class while keeping legacy `{ ok: true }` behavior and
  detached completion.

## Strict TDD evidence

### Attachment, crypto, deadline, and repository red

Command:

```text
npx jest src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/interactiveToolGrantCrypto.test.ts src/server/__tests__/interactiveDeadlinePolicy.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts --runInBand
```

Output before implementation:

```text
FAIL: 4 test suites
Cannot find module '../services/interactiveAttachmentStore'
Cannot find module '../services/interactiveToolGrantCrypto'
Cannot find module '../services/interactiveDeadlinePolicy'
Cannot find module '../services/durableInteractiveTurnRepository'
Exit code: 1
```

This was the expected failure: all four production modules were absent.

### Durable preparation service red

Command:

```text
npx jest src/server/__tests__/durableInteractiveTurnRepository.test.ts --runInBand
```

Output before service implementation:

```text
FAIL server src/server/__tests__/durableInteractiveTurnRepository.test.ts
Cannot find module '../services/durableInteractiveTurnService'
Exit code: 1
```

### Canonical routing red

Command:

```text
npx jest src/server/__tests__/interactiveWorkflowRouter.test.ts --runInBand
```

Output before the canonical split:

```text
FAIL: 5 tests
The old router called runInProcess, evaluated ai-runs-interactive, and reached
the legacy actor admission service instead of the durable callbacks.
Exit code: 1
```

The failures covered flag false, flag evaluation error, enabled admission,
enabled admission failure, and telemetry isolation.

### HTTP response boundary red

Command:

```text
npx jest src/server/__tests__/chatRoutes.test.ts --runInBand -t "durable admission boundary"
```

Output before route implementation:

```text
FAIL: 3 tests, 1 passed
- durable acceptance returned { ok: true }
- enabled-path validation still returned 202
- the running-thread check ran before durable admission
Exit code: 1
```

### Unified send wrapper red

Command:

```text
npx jest src/server/__tests__/chatAgentService.test.ts --runInBand -t "canonical durable send wrapper"
```

Output before wrapper implementation:

```text
FAIL: expected durable admission, received "CURSOR_API_KEY is not set"
Exit code: 1
```

This proved the old exported send still entered App Service model execution.

## Transaction invariants

Admission executes these operations under one `db.transaction`:

1. Acquire
   `pg_advisory_xact_lock(hashtextextended('interactive-user:' || userId, 0))`.
2. Lock the authoritative `chat_threads` row with `FOR UPDATE`.
3. Resolve `(thread_id, client_turn_id)` before limits or writes.
4. Return the existing run when the hash matches; return
   `TURN_ID_CONFLICT` when it differs.
5. Check one nonterminal interactive run per thread.
6. Count only indexed nonterminal `ai-runs-interactive` rows for the user.
7. Enforce two active turns per user and one active agentic turn per user.
8. Read one database acceptance timestamp and derive the absolute deadline in
   SQL.
9. Insert the user message with `message.id = turnId`.
10. Insert immutable attachment refs/hashes.
11. Insert the queued `dapr-actor-v2` run and frozen execution snapshot.
12. Insert attempt 1 with its generated dispatch fence and `spec_snapshot`.
13. Insert `interactive_dispatch` with idempotency key
    `${attemptId}:interactive-dispatch`.
14. Insert the durable queued phase event.
15. Set the thread to running with the active run ID, then notify the existing
    outbox channel before commit.

Message, run, event, outbox ordering, and thread timestamps use the returned
database timestamp. Global capacity is not queried during admission. Model is
absent from class, eligibility, limit, and FIFO queries.

Blob upload intentionally happens before the transaction. A failed or
conflicting admission can leave a Blob orphan for lifecycle cleanup, but it
cannot leave a partial PostgreSQL turn.

## Green verification

Required Task 2 unit command:

```text
npx jest src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/interactiveToolGrantCrypto.test.ts src/server/__tests__/interactiveDeadlinePolicy.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/chatRoutes.test.ts src/server/__tests__/chatAgentService.test.ts --runInBand
```

Final output:

```text
PASS: 7 test suites
PASS: 214 tests
Exit code: 0
```

PostgreSQL rollback/concurrency command:

```text
npx jest --config jest.config.integration.js tests/integration/durable-interactive-admission.integration.test.ts --runInBand
```

Final output:

```text
PASS: 1 test suite
PASS: 13 tests
Exit code: 0
```

The integration suite injects failure after message, attachments, run, attempt,
outbox, queued event, and thread update, and verifies zero admitted rows after
each rollback. It also proves concurrent idempotency/conflicts, one active turn
per thread, the two-turn user limit, the one-agentic user limit, and that 16
globally dispatched runs do not block an eligible queued admission.

Outbox/service regression:

```text
npx jest src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/aiRunV2OutboxRepository.test.ts --runInBand
```

```text
PASS: 2 test suites
PASS: 25 tests
Exit code: 0
```

Server type-check:

```text
npm run build:server
```

```text
> tsc -p tsconfig.server.json
Exit code: 0
```

Focused lint:

```text
Exit code: 0
0 errors, 1 pre-existing unused-import warning in chatAgentService.ts
```

Diff validation:

```text
git diff --check -- <Task 2 paths>
git diff --cached --check
Exit code: 0
```

## Files changed

- `src/server/services/interactiveAttachmentStore.ts`
- `src/server/services/interactiveToolGrantCrypto.ts`
- `src/server/services/interactiveDeadlinePolicy.ts`
- `src/server/services/durableInteractiveTurnRepository.ts`
- `src/server/services/durableInteractiveTurnService.ts`
- `src/server/services/interactiveWorkflowRouter.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/services/aiRunV2/outboxRepository.ts`
- `src/server/routes/chat.ts`
- `src/server/__tests__/interactiveAttachmentStore.test.ts`
- `src/server/__tests__/interactiveToolGrantCrypto.test.ts`
- `src/server/__tests__/interactiveDeadlinePolicy.test.ts`
- `src/server/__tests__/durableInteractiveTurnRepository.test.ts`
- `src/server/__tests__/interactiveWorkflowRouter.test.ts`
- `src/server/__tests__/chatRoutes.test.ts`
- `src/server/__tests__/chatAgentService.test.ts`
- `tests/integration/durable-interactive-admission.integration.test.ts`
- `.superpowers/sdd/task-2-report.md`

## Self-review

- Confirmed the durable preparation service has no Cursor SDK,
  `interactiveCursorExecution`, `Agent`, Bedrock, or model-client import.
- Confirmed model is not accepted by the classifier and is absent from
  transaction locks, user limits, thread limits, and outbox ordering.
- Confirmed `createDispatchedV2Run` is not called; admission remains queued.
- Confirmed attempt 1 and the outbox payload share the same dispatch fence.
- Confirmed the canonical enabled branch does not catch admission errors or
  invoke the legacy callback.
- Confirmed the private legacy body retains `tryDispatchInteractiveTurn` and
  the `ai-runs-interactive` split.
- Confirmed HTTP attachment parsing preserves base64 encoding so hashing uses
  decoded bytes.
- Confirmed external MCP descriptors retain environment references rather than
  resolved header secrets, and stdio MCP is rejected before Blob upload.
- Confirmed selected workspace skill content is read from the pinned grounding
  profile first and frozen with its SHA-256.
- Confirmed duplicate durable responses do not add another in-memory user
  bubble.
- Confirmed no unrelated pre-existing worktree change was staged.

## Concerns

The brief says the updated browser client always supplies `turnId`, but no
client file is in Task 2's named/staging list, and the current client does not
yet send one. I did not change unnamed client files. The canonical flag must
not be enabled for browser traffic until that client wiring is completed;
internal callers are compatible because the unified wrapper generates UUIDs.

The required tests also emit existing intentional error-path logs and the
known unset-test-database warning. Focused lint reports the existing unused
`ValidationScorecard` import in `chatAgentService.ts`; Task 2 introduced no
lint errors.

---

## Review remediation

### Result

- Status: `DONE_WITH_CONCERNS`
- Review-fix commit: `df9206fe`
  (`fix: harden durable interactive admission`)
- No push, cloud operation, infrastructure change, deployment change, or
  protected configuration change was made.
- Only review-fix source, migration, and test paths were staged. Pre-existing
  worktree changes remained unstaged.

### Fixes

- Replaced unrestricted local skill fallback with a closed loader:
  - rejects absolute paths, traversal, NULs, malformed segments, non-files,
    direct symlinks, and parent-symlink escapes
  - reads registered project skills only through the pinned `RepoReader`
  - reads built-in skills only from explicit `.cursor/skills` or
    `.agents/skills` roots after realpath containment checks
  - returns `422 INTERACTIVE_V2_SKILL_UNAVAILABLE` when a pinned read fails;
    it never falls through to another local file
- Relaxed requester identity from UUID-only to trimmed, nonempty, NUL-free text
  of at most 256 characters. UUID validation remains strict for turn, thread,
  message, attachment, attempt, fence, event, and calendar-session IDs.
- Added matching database/schema validation for `requested_by_user_id`.
- Expanded accepted response status to queued, dispatched, running, completed,
  failed, and cancelled. Duplicate admission returns the persisted status
  exactly.
- Prevented delayed terminal duplicates from putting the in-memory thread back
  into running state. Completed/cancelled responses settle idle; failed settles
  error; all clear `activeRunId`.
- Persisted durable canonical runs with `event_driven = TRUE`. Their frozen
  five-/20-minute `timeout_at` now owns queued lifetime even when the separate
  event-driven flag is false or unreadable.
- Added deterministic `01-`, `02-`, ... attachment materialization prefixes so
  duplicate and sanitized-colliding names cannot overwrite each other.
- Thread admission now carries the authorized requester's identity from the
  route through canonical flag context, thread access, user lock/quota,
  encrypted grant, run audit field, and outbox payload. Thread ownership remains
  thread metadata.
- Added MaxView capability resolution using the authorized requester and the
  `maxview-mcp` flag. Enabled+configured turns freeze a `maxview` internal proxy
  and classify agentic/tool-heavy. Enabled but unconfigured returns
  `422 INTERACTIVE_V2_MAXVIEW_UNAVAILABLE`.
- Mapped all thrown grounding-resolution failures to
  `422 INTERACTIVE_V2_GROUNDING_UNAVAILABLE`.
- Restored unit coverage for the complete legacy interactive actor router.
- Replaced the sequential same-turn/different-hash integration case with a
  genuinely concurrent race proving exactly one accepted result and one
  conflict.

### TDD red evidence

Skill safety:

```text
npx jest src/server/__tests__/durableInteractiveTurnService.test.ts --runInBand
FAIL: 8 tests
loadDurableInteractiveSkill was absent.
```

The red cases covered `../../`, nested traversal, absolute paths, parent
symlink escape, unknown registration, pinned-read failure with a tempting
local copy, valid built-in load, and valid pinned project load.

Contract/admission review cases:

```text
npx jest src/server/__tests__/durableInteractiveTurnTypes.test.ts src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts --runInBand
FAIL: 26 tests
```

Expected failures proved the old code:

- rejected non-UUID requester identities
- collapsed running/completed/failed/cancelled duplicates to dispatched
- persisted `event_driven = FALSE`
- omitted ordered attachment prefixes
- leaked grounding resolver errors as arbitrary failures
- did not freeze or reject MaxView capability

Requester and terminal reflection:

```text
npx jest src/server/__tests__/chatAgentService.test.ts src/server/__tests__/chatRoutes.test.ts --runInBand -t "authorized requester|non-owner requester|delayed .* duplicate"
FAIL: 5 tests
```

The route omitted the requester, the wrapper used the thread owner for
canonical routing/admission, and terminal duplicates re-entered running state.

MaxView resolver:

```text
npx jest src/server/__tests__/durableInteractiveTurnService.test.ts --runInBand -t "durable MaxView"
FAIL: 4 tests
resolveDurableMaxviewCapability was absent.
```

### Final verification

Focused Task 1 + Task 2 + reaper unit suite:

```text
Test Suites: 14 passed, 14 total
Tests:       434 passed, 434 total
Exit code: 0
```

Durable admission PostgreSQL integration:

```text
PASS: 1 suite
PASS: 20 tests
Exit code: 0
```

This includes seven rollback boundaries, all six delayed duplicate statuses,
same-turn/same-hash idempotency, concurrent same-turn/different-hash conflict,
two callers sharing one thread, per-thread/user/agentic limits, and absence of
a global-capacity admission limit.

Task 1 migration PostgreSQL integration:

```text
PASS: 1 suite
PASS: 1 test
Exit code: 0
```

Server type-check:

```text
> tsc -p tsconfig.server.json
Exit code: 0
```

Focused lint and diff:

```text
ESLint: 0 errors, 2 existing warnings
git diff --check: exit 0
git diff --cached --check: exit 0
```

The warnings are the existing unused `ValidationScorecard` import and
`requireDeferred` helper. Test output also retains existing intentional
error-path logs and the unset unit-test database warning.

### Review-fix files

- `migrations/20260923140000_durable-interactive-turns.sql`
- `src/shared/types/durableInteractiveTurn.ts`
- `src/server/db/schema.ts`
- `src/server/services/interactiveAttachmentStore.ts`
- `src/server/services/durableInteractiveTurnRepository.ts`
- `src/server/services/durableInteractiveTurnService.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/routes/chat.ts`
- `src/server/__tests__/durableInteractiveTurnService.test.ts`
- `src/server/__tests__/durableInteractiveTurnTypes.test.ts`
- `src/server/__tests__/durableInteractiveTurnsMigration.test.ts`
- `src/server/__tests__/interactiveAttachmentStore.test.ts`
- `src/server/__tests__/durableInteractiveTurnRepository.test.ts`
- `src/server/__tests__/chatAgentService.test.ts`
- `src/server/__tests__/chatRoutes.test.ts`
- `src/server/__tests__/agentRunReaperService.test.ts`
- `src/server/__tests__/interactiveWorkflowRouter.test.ts`
- `tests/integration/durable-interactive-turns.integration.test.ts`
- `tests/integration/durable-interactive-admission.integration.test.ts`
- `.superpowers/sdd/task-2-report.md`

### Review-fix self-review

- Confirmed no caller-controlled path reaches `path.resolve(process.cwd(), …)`.
- Confirmed a pinned read failure has no provider or local fallback.
- Confirmed requester identity—not thread owner—flows through all canonical
  admission and grant fields.
- Confirmed every accepted-status switch is exhaustive.
- Confirmed every canonical run is event-driven from its initial queued insert.
- Confirmed model remains absent from classification, locks, quotas, and FIFO.
- Confirmed no cloud, infrastructure, protected configuration, or unrelated
  worktree file was changed or staged.

### Remaining concern

The prior browser `turnId` concern remains: client paths were not part of Task
2's named scope and still need rollout wiring before enabling the canonical
flag for browser traffic.

---

## Final re-review remediation

### Result

- Status: `DONE`
- Re-review fix commit: `c22600d1`
  (`fix: close durable turn review gaps`)
- No push, cloud operation, infrastructure change, deployment change, or
  protected configuration change was made.
- The prior browser `turnId` concern is resolved by this commit.

### Fixes

- Skill source selection now branches on registration before any read:
  - `project` requires the exact pinned reader and requested path
  - `built-in` ignores any repository reader and uses only the allowlisted
    local built-in root
  - `unknown` returns explicit unavailable
  - same-path repository content cannot override a built-in, and same-path
    local content cannot override a registered project skill
- Browser sends now generate a UUID once per user send attempt. One automatic
  network retry reuses the serialized request and the same `turnId`; a new
  user send gets a new UUID.
- `SendMessageRequest.turnId` is required for typed browser callers.
- Added `turnId` to every direct chat message POST:
  - Agent Home/session hook
  - Home initial-message send
  - Interview kickoff
  - ADR kickoff
  - Design-doc discussion kickoff
  - typed `useSendMessage` callers
- Duplicate repository results now include an internal
  `shouldReflectThreadState` decision derived while holding the thread lock.
  An old terminal duplicate returns its original result but cannot replace or
  clear a newer active run in memory.
- Restored the legacy router's multi-workflow targeting regression and
  already-dispatched-drain regression after a flag change.

### TDD red evidence

Skill precedence:

```text
npx jest src/server/__tests__/durableInteractiveTurnService.test.ts --runInBand -t "override the same"
FAIL: built-in registration returned repository content instead of the
allowlisted local built-in.
```

Browser admission identity:

```text
npx jest src/client/hooks/__tests__/useAgentChatSession.test.ts --runInBand -t "send posts|turnId"
FAIL: 3 tests
```

The red cases proved that the body omitted `turnId`, a network failure was not
retried, and separate user sends had no independent identities.

Superseded terminal duplicate:

```text
npx jest src/server/__tests__/durableInteractiveTurnRepository.test.ts --runInBand -t "superseded|newer active"
FAIL: repository/service omitted reflection ownership metadata.

npx jest src/server/__tests__/chatAgentService.test.ts --runInBand -t "newer active run"
FAIL: old completed duplicate cleared newer-active-run and set the thread idle.
```

The restored legacy router tests passed immediately against the preserved
legacy implementation; no behavior change was needed there.

### Final verification

Server Task 1/Task 2/chat/router/reaper suite:

```text
Test Suites: 14 passed, 14 total
Tests:       441 passed, 441 total
Exit code: 0
```

Client Home/Interview/ADR/direct-send suite:

```text
Test Suites: 5 passed, 5 total
Tests:       88 passed, 88 total
Exit code: 0
```

Sequential PostgreSQL integration:

```text
Migration: 1 passed
Admission/concurrency: 21 passed
Exit code: 0
```

Builds:

```text
npm run build:server
Exit code: 0

npm run build:client
Exit code: 0
```

Focused lint/diff:

```text
ESLint: 0 errors
git diff --check: exit 0
git diff --cached --check: exit 0
```

Lint reports existing warnings in the touched large UI modules and the known
unused server import, but no errors. Builds retain the existing Vite/Application
Insights warnings.

### Final re-review files

- `src/shared/types/chat.ts`
- `src/shared/types/durableInteractiveTurn.ts`
- `src/server/services/durableInteractiveTurnRepository.ts`
- `src/server/services/durableInteractiveTurnService.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/__tests__/durableInteractiveTurnService.test.ts`
- `src/server/__tests__/durableInteractiveTurnRepository.test.ts`
- `src/server/__tests__/chatAgentService.test.ts`
- `src/server/__tests__/interactiveWorkflowRouter.test.ts`
- `tests/integration/durable-interactive-admission.integration.test.ts`
- `src/client/utils/chatTurnId.ts`
- `src/client/hooks/useAgentChatSession.ts`
- `src/client/hooks/useChatThreads.ts`
- `src/client/App.tsx`
- `src/client/components/InterviewChatView.tsx`
- `src/client/components/AdrChatView.tsx`
- `src/client/components/DesignDocReviewView.tsx`
- `src/client/hooks/__tests__/useAgentChatSession.test.ts`
- `src/client/components/__tests__/InterviewChatView.NewInterviewCompose.test.tsx`
- `src/client/components/__tests__/AdrChatView.NewAdrCompose.test.tsx`
- `.superpowers/sdd/task-2-report.md`

### Final self-review

- Confirmed built-in registration never calls the pinned reader.
- Confirmed project registration never resolves or reads a local built-in.
- Confirmed each browser send serializes its turn ID once before fetch retry.
- Confirmed all direct `/api/chat/threads/:id/messages` callers include
  `turnId`.
- Confirmed the HTTP response omits internal reflection metadata.
- Confirmed the thread lock supplies `active_run_id` before duplicate response
  ownership is decided.
- Confirmed a superseded old terminal run does not mutate message cache,
  `status`, `activeRunId`, or `lastActivityAt`.
- Confirmed canonical routing remains one-way and legacy routing behavior is
  preserved under canonical flag off/error.

### Concerns

None specific to these re-review findings.

---

## Idempotent reflection race remediation

### Result

- Status: `DONE`
- Race-fix commit: `3cddfb92`
  (`fix: ignore idempotent duplicate reflections`)
- No push, cloud, infrastructure, deployment, or protected configuration
  changes were made.

### Fix

The repository's transaction result remains useful for the persisted response,
but it is no longer treated as permission to mutate process-local thread state
when the result is idempotent.

- Repository `idempotent` metadata now flows through the durable service and
  canonical router as internal response metadata.
- `reflectDurableAdmission` returns immediately for every idempotent duplicate,
  before touching messages, status, active run, activity time, or subscribers.
- The HTTP route continues to return only the public persisted response; it
  omits both `idempotent` and thread-reflection metadata.
- Fresh admissions still reflect immediately. The first same-process send
  therefore adds its bubble/status once, while a repeated network send is a
  process-local no-op.
- The prior `active_run_id` ownership hint remains a second guard for fresh
  non-idempotent reflection.

### TDD red evidence

Command:

```text
npx jest src/server/__tests__/chatAgentService.test.ts --runInBand -t "newer active run|ordinary network duplicate"
```

Before the fix:

```text
FAIL: 2 tests
- a stale completed duplicate changed newer-active-run to idle/undefined
- an ordinary queued network duplicate emitted another running status event
```

The race test constructs the duplicate result, then deterministically assigns
`newer-active-run` before the mocked admission resolves to the wrapper. This
models the exact transaction-return/reflection gap.

### Verification

Focused server admission/chat/router suite:

```text
Test Suites: 5 passed, 5 total
Tests:       237 passed, 237 total
Exit code: 0
```

Focused Home/Interview/ADR browser suite:

```text
Test Suites: 3 passed, 3 total
Tests:       63 passed, 63 total
Exit code: 0
```

PostgreSQL admission integration:

```text
Test Suites: 1 passed, 1 total
Tests:       21 passed, 21 total
Exit code: 0
```

Type-check/build:

```text
npm run build:server
Exit code: 0

npx tsc -p tsconfig.client.json --noEmit
Exit code: 0

npm run build:client
Exit code: 0
```

Focused lint/diff:

```text
ESLint: 0 errors
git diff --check: exit 0
git diff --cached --check: exit 0
```

The touched large UI files retain existing lint warnings; no new lint error was
introduced.

### Race-fix files

- `src/shared/types/durableInteractiveTurn.ts`
- `src/server/services/durableInteractiveTurnService.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/__tests__/durableInteractiveTurnRepository.test.ts`
- `src/server/__tests__/chatAgentService.test.ts`
- `.superpowers/sdd/task-2-report.md`

### Final self-review

- Confirmed idempotent duplicate reflection is unconditional no-op, so no
  ownership decision can become stale between database commit and reflection.
- Confirmed ordinary network duplication returns the persisted response while
  adding no bubble and emitting no second status event.
- Revalidated strict built-in/project skill precedence, stable browser turn
  IDs, direct browser send coverage, and both restored legacy router
  regressions.
- Confirmed all scoped source/test files are committed and no unrelated
  worktree file was staged.

### Concerns

None.
