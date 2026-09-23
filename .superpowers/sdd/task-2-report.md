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
