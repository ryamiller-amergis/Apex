# Durable Interactive Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every accepted interactive turn atomically, queue it durably
by fast/agentic class, execute it only in Dapr actors, and make streaming and
retry recoverable without duplicate user messages.

**Architecture:** `ai-runs-v2-transport` selects one of two top-level branches:
the unchanged current path when off/unreadable, or a PostgreSQL-authoritative
`dapr-actor-v2` path when on. The enabled path uploads attachments, freezes the
turn, commits message/run/attempt/outbox/thread state in one transaction, and
returns queued. The existing orchestrator admits queued rows into two direct
Dapr actor endpoints; actors execute from the frozen specification and persist
offset token batches while Redis remains the low-latency fan-out.

**Tech Stack:** TypeScript, Express, React, PostgreSQL/Drizzle,
node-pg-migrate, Azure Blob Storage, Dapr actors, Cursor SDK, Redis,
WebSocket/SSE, Jest.

## Global Constraints

- The approved design is
  `docs/superpowers/specs/2026-09-23-durable-interactive-turns-design.md`.
  When this plan and the design differ, stop and correct the plan before code.
- `ai-runs-v2-transport` is the canonical flag. Do not add a Task 7 flag.
- Flag false or evaluation error uses the unchanged current path. Flag true
  never executes Cursor/model in App Service.
- `ai-runs-interactive` remains legacy-only while the canonical flag is off.
- Transport is exactly `dapr-actor-v2`.
- PostgreSQL outbox kind is exactly `interactive_dispatch`; do not add an
  interactive Service Bus queue.
- Persisted class values are exactly `fast` and `agentic`.
- Fast absolute deadline is 300,000 ms. Agentic absolute deadline is
  1,200,000 ms and includes queueing and repository preparation.
- First-event limits are 15,000 ms fast-warm, 30,000 ms fast-cold, and
  30,000 ms agentic. Tool limits are 60,000 ms fast and 90,000 ms agentic.
- Agentic repository preparation is capped at 300,000 ms.
- Warm floors are two fast and two agentic. Shared burst may raise total
  active interactive turns to 16, never above 16.
- One thread may have one nonterminal interactive run.
- One user may have two nonterminal interactive runs across threads and one
  nonterminal agentic run.
- Per-user violations are explicit 429 responses. Global saturation queues.
- Initial send and failed-run retry never estimate queue position.
- Durable token persistence is at most four writes per second per run and at
  most 16 KiB UTF-8 text per event.
- WebSocket is preferred under the canonical flag; SSE remains only a stream
  transport fallback.
- Every switch over a union or enum must contain a `never` default check.
- Imports stay at module scope.
- Do not edit `package.json`, `vite.config.ts`, `src/server/index.ts`,
  `.env.example`, `tsconfig*.json`, Jest configuration, Terraform, runners,
  deployment workflows, or any Azure resource file.
- Do not add dependencies.
- Do not apply a migration to dev, staging, or production in this task.
- Each task stages only the files named by that task.

---

## File structure

### Shared contracts and persistence

- `src/shared/types/durableInteractiveTurn.ts` — closed interactive class,
  capability, deadline, specification, dispatch, and API response contracts.
- `src/shared/types/aiRunV2.ts` — add `dapr-actor-v2` and interactive terminal
  failure categories.
- `src/shared/types/agentRunLifecycle.ts` — make the persisted execution
  snapshot an exhaustive legacy/document-or-interactive union.
- `src/shared/types/chat.ts` — client `turnId`, accepted response, Blob-backed
  attachment metadata, and offset-token contract.
- `src/server/db/schema.ts` — Drizzle representation of the additive columns,
  checks, indexes, and attempt-specific interactive specification snapshot.
- `migrations/20260923140000_durable-interactive-turns.sql` — additive up,
  guarded backfill/index creation, and refusal-first down migration.

### Classification and atomic admission

- `src/server/services/interactiveTurnClassifier.ts` — deterministic,
  metadata-based fast/agentic classifier.
- `src/server/services/interactiveAttachmentStore.ts` — immutable Blob upload
  and content validation before the transaction.
- `src/server/services/interactiveToolGrantCrypto.ts` — encrypt/decrypt
  run-bound delegated ADO credentials with a domain-separated existing secret.
- `src/server/services/durableInteractiveTurnRepository.ts` — the sole atomic
  send/retry writer.
- `src/server/services/durableInteractiveTurnService.ts` — resolve/freeze
  inputs, call attachment storage, classify, and map repository outcomes.
- `src/server/services/interactiveWorkflowRouter.ts` — canonical flag split;
  current path remains one branch, durable admission the other.
- `src/server/services/chatAgentService.ts` — expose current execution as the
  legacy callback and remove enabled-path preparation/execution from it.
- `src/server/services/aiRunV2/outboxRepository.ts` — accept
  `interactive_dispatch` and class-aware claim/release operations.
- `src/server/routes/chat.ts` — validate `turnId`, await durable acceptance,
  return the new response/errors, and expose retry.

### Orchestrator dispatch

- `src/server/services/aiOrchestrator/interactiveActorDispatchClient.ts` —
  direct class endpoint invocation.
- `src/server/services/aiOrchestrator/types.ts` — interactive total cap and
  direct destination types.
- `src/server/services/aiOrchestrator/providerGovernor.ts` — two/two floors,
  shared burst, and total 16.
- `src/server/services/aiOrchestrator/admissionController.ts` — fair,
  class-aware interactive planning.
- `src/server/services/aiOrchestrator/outboxDrainer.ts` — branch exhaustively
  between Service Bus background commands and direct Dapr dispatches.
- `src/server/services/aiOrchestrator/utilizationReader.ts` — count persisted
  interactive class utilization.
- `src/server/services/aiOrchestrator/entrypoint.ts` — compose the two direct
  clients without changing deployment configuration.

### Actor parity and internal proxy

- `src/server/services/interactiveActorHost/interactiveWorkspaceMaterializer.ts`
  — attempt-local pinned repository and attachment materialization.
- `src/server/services/interactiveActorHost/interactiveArtifactCollector.ts`
  — collect only approved `.ai-pilot` outputs.
- `src/server/services/interactiveActorHost/interactiveCursorExecution.ts` —
  warm/resume/recreate modes and no execution defaults.
- `src/server/services/interactiveActorHost/interactiveSessionActor.ts` —
  deadlines, cancellation, durable batches, artifact upload, and fencing.
- `src/server/services/interactiveActorHost/interactiveSessionActorClass.ts` —
  bootstrap the exact attempt and deduplicate dispatch replay.
- `src/server/services/interactiveActorHost/entrypoint.ts` — wire Blob,
  repo-read, signed tool endpoints, and direct class host behavior.
- `src/server/services/interactiveToolProxyToken.ts` — issue/verify
  attempt/fence/server/expiry-bound HMAC tokens.
- `src/server/services/interactiveToolProxyService.ts` — invoke allowed Apex
  and external HTTP MCP domain tools; never Cursor/model.
- `src/server/services/interactiveArtifactApplier.ts` — checksum-verify and
  persist actor `.ai-pilot` outputs.
- `src/server/routes/aiRunsInternal.ts` — bootstrap and signed MCP proxy routes.
- `src/server/services/aiRunIngestService.ts` — attempt-aware fenced
  progress/terminal ingest.
- `src/server/services/aiRunsWorker/callbackClient.ts` — typed bootstrap and
  proxy metadata.

### Durable stream and client

- `src/server/services/interactiveDurableStreamBatcher.ts` — 250 ms/16 KiB
  offset batches.
- `src/server/services/interactiveLiveBus.ts` — publish offset-aware live
  events and reuse durable IDs when batch boundaries match.
- `src/server/services/interactiveGatewayService.ts` — paginate replay and
  buffer live data through all pages.
- `src/server/services/pgNotifyService.ts` — page cursor and offset-preserving
  event persistence.
- `src/client/utils/threadEventStream.ts` — WebSocket preference and SSE
  transport fallback with one resume cursor.
- `src/client/hooks/useChatStream.ts` — `(eventId, streamOffset)` dedupe and
  ordered offset merge.
- `src/client/hooks/useAgentChatSession.ts` — stable `turnId`, accepted status,
  failed run identity, and run retry.
- `src/client/App.tsx` — canonical flag controls WebSocket preference.
- `src/client/components/ChatAgentPanel.tsx`,
  `src/client/components/InterviewChatView.tsx`, and
  `src/client/components/AdrChatView.tsx` — queued/dispatched labels, exact 429
  copy, and failed-run retry.

---

### Task 1: Add contracts, migration, and classifier

**Files:**

- Create: `src/shared/types/durableInteractiveTurn.ts`
- Create: `src/server/services/interactiveTurnClassifier.ts`
- Create: `migrations/20260923140000_durable-interactive-turns.sql`
- Modify: `src/shared/types/aiRunV2.ts`
- Modify: `src/shared/types/agentRunLifecycle.ts`
- Modify: `src/shared/types/chat.ts`
- Modify: `src/server/db/schema.ts`
- Test: `src/server/__tests__/durableInteractiveTurnTypes.test.ts`
- Test: `src/server/__tests__/interactiveTurnClassifier.test.ts`
- Test: `src/server/__tests__/durableInteractiveTurnsMigration.test.ts`
- Test: `tests/integration/durable-interactive-turns.integration.test.ts`

**Interfaces:**

- Consumes: `AiRunBlobRef`, `InteractiveWorkflowClass`, `EffortLevel`,
  `ChatAttachment`, and existing `agent_runs`/`ai_run_attempts` tables.
- Produces:
  `InteractiveClass`, `InteractiveCapability`,
  `InteractiveDeadlinePolicy`,
  `FrozenInteractiveToolGrant`,
  `DurableInteractiveTurnSpecification`,
  `InteractiveDispatchOutboxPayload`,
  `InteractiveTurnAcceptedResponse`,
  `AgentRunExecutionSnapshot`,
  `classifyInteractiveTurn(input): InteractiveClassification`, and the
  `dapr-actor-v2` persistence contract used by every later task.

```typescript
export type InteractiveClassificationInput = Readonly<{
  model: string;
  effort: EffortLevel | null;
  skillPath: string | null;
  capabilities: ReadonlyArray<InteractiveCapability>;
}>;

export type InteractiveClassification = Readonly<{
  interactiveClass: InteractiveClass;
  reasons: ReadonlyArray<string>;
}>;
```

- [ ] **Step 1: Write the failing shared-contract tests**

```typescript
import {
  deadlinePolicyFor,
  isDurableInteractiveTurnSpecification,
  isInteractiveDispatchOutboxPayload,
} from '../../shared/types/durableInteractiveTurn';
import { isAiRunTransportVersion } from '../../shared/types/aiRunV2';

it('recognizes the direct actor transport', () => {
  expect(isAiRunTransportVersion('dapr-actor-v2')).toBe(true);
});

it('freezes exact class deadlines', () => {
  expect(deadlinePolicyFor('fast')).toEqual({
    absoluteTurnMs: 300_000,
    repositoryPreparationMs: null,
    firstEventWarmMs: 15_000,
    firstEventColdMs: 30_000,
    toolCallMs: 60_000,
  });
  expect(deadlinePolicyFor('agentic')).toEqual({
    absoluteTurnMs: 1_200_000,
    repositoryPreparationMs: 300_000,
    firstEventWarmMs: 30_000,
    firstEventColdMs: 30_000,
    toolCallMs: 90_000,
  });
});

it('rejects a dispatch with a mismatched lane and class', () => {
  expect(
    isInteractiveDispatchOutboxPayload({
      schemaVersion: 2,
      kind: 'interactive_dispatch',
      transport: 'dapr-actor-v2',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'fence-1',
      threadId: 'thread-1',
      userId: 'user-1',
      interactiveClass: 'fast',
      workloadLane: 'agentic',
      capacityClass: 'interactive',
      deadlineAt: '2026-09-23T15:00:00.000Z',
    })
  ).toBe(false);
});
```

- [ ] **Step 2: Run the contract test and verify red**

Run:

```bash
npx jest src/server/__tests__/durableInteractiveTurnTypes.test.ts --runInBand
```

Expected: FAIL because
`../../shared/types/durableInteractiveTurn` does not exist and
`dapr-actor-v2` is not accepted.

- [ ] **Step 3: Write the failing classifier tests**

```typescript
import {
  classifyInteractiveTurn,
  type InteractiveClassificationInput,
} from '../services/interactiveTurnClassifier';

const plain = (
  overrides: Partial<InteractiveClassificationInput> = {}
): InteractiveClassificationInput => ({
  model: 'composer-2',
  effort: 'low',
  skillPath: null,
  capabilities: ['plain-chat'],
  ...overrides,
});

it('keeps a registered low-effort plain turn fast', () => {
  expect(classifyInteractiveTurn(plain()).interactiveClass).toBe('fast');
});

it.each([
  ['high effort', { effort: 'high' }],
  ['workspace', { capabilities: ['workspace'] }],
  ['attachments', { capabilities: ['attachments'] }],
  ['ado', { capabilities: ['ado'] }],
  ['mcp', { capabilities: ['mcp'] }],
  ['tool heavy', { capabilities: ['tool-heavy'] }],
] as const)('upgrades %s and never downgrades it', (_name, override) => {
  expect(classifyInteractiveTurn(plain(override)).interactiveClass).toBe(
    'agentic'
  );
});

it('defaults unknown model or skill metadata to agentic', () => {
  expect(
    classifyInteractiveTurn(plain({ model: 'future-model' })).interactiveClass
  ).toBe('agentic');
  expect(
    classifyInteractiveTurn(plain({ skillPath: '/unknown/SKILL.md' }))
      .interactiveClass
  ).toBe('agentic');
});
```

- [ ] **Step 4: Run the classifier test and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveTurnClassifier.test.ts --runInBand
```

Expected: FAIL because `interactiveTurnClassifier` does not exist.

- [ ] **Step 5: Implement the closed contracts and exhaustive guards**

Create these exported functions and constants in
`src/shared/types/durableInteractiveTurn.ts`:

```typescript
export const DURABLE_INTERACTIVE_SPEC_VERSION = 1 as const;
export const INTERACTIVE_CLASSES = ['fast', 'agentic'] as const;
export const INTERACTIVE_CAPABILITIES = [
  'plain-chat',
  'workspace',
  'attachments',
  'ado',
  'mcp',
  'tool-heavy',
] as const;

export function deadlinePolicyFor(
  interactiveClass: InteractiveClass
): InteractiveDeadlinePolicy {
  switch (interactiveClass) {
    case 'fast':
      return {
        absoluteTurnMs: 300_000,
        repositoryPreparationMs: null,
        firstEventWarmMs: 15_000,
        firstEventColdMs: 30_000,
        toolCallMs: 60_000,
      };
    case 'agentic':
      return {
        absoluteTurnMs: 1_200_000,
        repositoryPreparationMs: 300_000,
        firstEventWarmMs: 30_000,
        firstEventColdMs: 30_000,
        toolCallMs: 90_000,
      };
    default: {
      const unhandled: never = interactiveClass;
      throw new Error(`Unsupported interactive class: ${String(unhandled)}`);
    }
  }
}
```

Define every interface exactly as written in the design. Type guards must
validate ISO timestamps, UUID-like nonempty identifiers, matching
`interactiveClass`/`workloadLane`, the fixed transport/kind/capacity class,
Blob refs, allowed MCP discriminants, and exact deadline values.

Add `dapr-actor-v2` to `AI_RUN_TRANSPORT_VERSIONS` and add
`hard_timeout`, `tool_timeout`, `worker_start_failed`, and
`validation_failed` to `AI_RUN_V2_FAILURE_CATEGORIES`.

In `agentRunLifecycle.ts`, add:

```typescript
export type AgentRunExecutionSnapshot =
  | ExecutionSnapshot
  | DurableInteractiveTurnSpecification;
```

Use `AgentRunExecutionSnapshot` for `agent_runs.execution_snapshot` in Drizzle.
Callers must narrow on `kind === 'interactive-turn'`; legacy
`ExecutionSnapshot` has no `kind`.

In `chat.ts`, add rollout-compatible `turnId?: string` to
`SendMessageRequest`. Keep Blob refs server-side: `ChatAttachmentMeta` returned
to the browser remains name/type/size/path only. Keep the existing
offset/snapshot fields on `SseTokenEvent`.

- [ ] **Step 6: Implement deterministic classifier metadata**

Use these exact registered model defaults:

```typescript
const MODEL_CLASS: Readonly<Record<string, InteractiveClass>> = {
  'composer-2': 'fast',
  'claude-sonnet-4-6': 'fast',
  'gpt-5.5': 'fast',
  'gemini-3.1-pro': 'fast',
  'claude-opus-4-6': 'agentic',
};
```

Register these normalized skill markers as agentic:

```typescript
const AGENTIC_SKILL_MARKERS = [
  'app-knowledge',
  'daily-standup',
  'grill-with-docs',
  'grill-design',
  'adr-interview',
  'adr-finalize',
  'to-prd',
  'prd-spec-review',
  'prd-design-spec',
  'design-spec-review',
  'create-test-case',
  'design-module-scoping',
  'walkthrough-',
  'k6-load-test-generation',
  'feature-request-analysis',
  'issue-analysis',
  'technical-analysis',
] as const;
```

No skill means “plain chat” and starts from the model default. A nonempty skill
path matching no registered marker is unknown and therefore agentic. Apply
`high` effort and the five expensive capabilities as one-way upgrades. Return:

```typescript
export type InteractiveClassification = Readonly<{
  interactiveClass: InteractiveClass;
  reasons: ReadonlyArray<string>;
}>;
```

Sort and deduplicate `reasons` so classification and request hashing are
deterministic.

- [ ] **Step 7: Write the migration contract test**

Read the migration text and assert it contains:

```typescript
expect(sql).toContain("'dapr-actor-v2'");
expect(sql).toContain('interactive_class');
expect(sql).toContain('client_turn_id');
expect(sql).toContain('client_turn_hash');
expect(sql).toContain('requested_by_user_id');
expect(sql).toContain('spec_snapshot');
expect(sql).toContain('uq_agent_runs_client_turn');
expect(sql).toContain('uq_agent_runs_interactive_active_thread');
expect(sql).toContain('idx_agent_runs_interactive_user_active');
expect(sql).toContain('idx_ai_run_outbox_interactive_due');
expect(sql).toContain('Cannot create uq_agent_runs_interactive_active_thread');
expect(sql).toContain('Cannot remove durable interactive turn schema');
```

- [ ] **Step 8: Run the migration test and verify red**

Run:

```bash
npx jest src/server/__tests__/durableInteractiveTurnsMigration.test.ts --runInBand
```

Expected: FAIL because the migration file does not exist.

- [ ] **Step 9: Implement the additive up/down migration and Drizzle schema**

The up migration must:

1. Drop and recreate `agent_runs_transport_version_check` with
   `http-files-v1`, `servicebus-blob-v2`, and `dapr-actor-v2`.
2. Add `requested_by_user_id TEXT`, `interactive_class TEXT`,
   `client_turn_id UUID`, and `client_turn_hash TEXT` to `agent_runs`; add
   `blob_ref JSONB` and `sha256 TEXT` to `chat_message_attachments`; add
   nullable `spec_snapshot JSONB` to `ai_run_attempts`.
3. Backfill legacy interactive class to `agentic` and user ID by joining
   `chat_threads`; leave legacy turn ID/hash null.
4. Add the class, lowercase 64-hex hash, and `dapr-actor-v2` required-field
   checks.
5. Abort if any thread has multiple nonterminal interactive rows.
6. Create the four indexes named in the design.

The down migration must run this precondition before dropping anything:

```sql
DO $down_guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_runs WHERE transport_version = 'dapr-actor-v2'
  ) OR EXISTS (
    SELECT 1
      FROM ai_run_outbox
     WHERE kind = 'interactive_dispatch'
       AND published_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot remove durable interactive turn schema while dapr-actor-v2 data exists';
  END IF;
END
$down_guard$;
```

Then drop Task 7 indexes/checks/columns and restore the prior transport check.
Mirror all columns, checks, and indexes in `src/server/db/schema.ts`; do not
edit the Task 3 migration.

- [ ] **Step 10: Prove migration up, backfill, uniqueness, and guarded down**

The integration test must:

- insert one legacy interactive run and prove class/user backfill
- insert one complete `dapr-actor-v2` row
- prove its first attempt retains the exact interactive `spec_snapshot`
- prove duplicate `(thread_id, client_turn_id)` fails
- prove a second active interactive run on one thread fails
- prove two active runs on different threads for the same user remain legal at
  the schema layer
- prove down refuses while the V2 row exists
- delete the fixture, run down, and verify the new columns are absent

Run:

```bash
npx jest --config jest.config.integration.js tests/integration/durable-interactive-turns.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 11: Run Task 1 green checks**

Run:

```bash
npx jest src/server/__tests__/durableInteractiveTurnTypes.test.ts src/server/__tests__/interactiveTurnClassifier.test.ts src/server/__tests__/durableInteractiveTurnsMigration.test.ts src/server/__tests__/aiRunV2Types.test.ts --runInBand
npm run build:server
```

Expected: all tests PASS and server type-check exits 0.

- [ ] **Step 12: Commit Task 1**

```bash
git add src/shared/types/durableInteractiveTurn.ts src/shared/types/aiRunV2.ts src/shared/types/agentRunLifecycle.ts src/shared/types/chat.ts src/server/services/interactiveTurnClassifier.ts src/server/db/schema.ts migrations/20260923140000_durable-interactive-turns.sql src/server/__tests__/durableInteractiveTurnTypes.test.ts src/server/__tests__/interactiveTurnClassifier.test.ts src/server/__tests__/durableInteractiveTurnsMigration.test.ts tests/integration/durable-interactive-turns.integration.test.ts
git commit -m "feat: define durable interactive turn contracts"
```

---

### Task 2: Persist and queue a turn atomically

**Files:**

- Create: `src/server/services/interactiveAttachmentStore.ts`
- Create: `src/server/services/interactiveToolGrantCrypto.ts`
- Create: `src/server/services/durableInteractiveTurnRepository.ts`
- Create: `src/server/services/durableInteractiveTurnService.ts`
- Modify: `src/server/services/interactiveWorkflowRouter.ts`
- Modify: `src/server/services/chatAgentService.ts`
- Modify: `src/server/services/aiRunV2/outboxRepository.ts`
- Modify: `src/server/routes/chat.ts`
- Test: `src/server/__tests__/interactiveAttachmentStore.test.ts`
- Test: `src/server/__tests__/interactiveToolGrantCrypto.test.ts`
- Test: `src/server/__tests__/durableInteractiveTurnRepository.test.ts`
- Test: `src/server/__tests__/interactiveWorkflowRouter.test.ts`
- Test: `src/server/__tests__/chatRoutes.test.ts`
- Test: `tests/integration/durable-interactive-admission.integration.test.ts`

**Interfaces:**

- Consumes: Task 1 contracts; `resolveThreadAccess`; current `sendMessage` as
  the legacy callback; Task 3–6 outbox notification channel and Blob client.
- Produces:
  `createInteractiveAttachmentStore`,
  `encryptInteractiveToolGrant`,
  `decryptInteractiveToolGrant`,
  `DurableInteractiveTurnRepository.admit`,
  `createDurableInteractiveTurnService().admit`,
  a unified `sendMessage` wrapper for HTTP and internal callers, and canonical
  router decisions:

```typescript
export type AdmitDurableInteractiveTurnResult =
  | (InteractiveTurnAcceptedResponse & { idempotent: boolean })
  | Readonly<{ status: 'thread_active'; activeRunId: string }>
  | Readonly<{
      status: 'user_limit';
      code: 'USER_INTERACTIVE_LIMIT' | 'USER_AGENTIC_LIMIT';
    }>
  | Readonly<{ status: 'turn_conflict' }>;

export interface DurableInteractiveTurnRepository {
  admit(
    input: PreparedDurableInteractiveTurn
  ): Promise<AdmitDurableInteractiveTurnResult>;
}

export type InteractiveWorkflowRouteDecision =
  | Readonly<{
      route: 'legacy';
      reason: 'flag-disabled' | 'flag-evaluation-error';
    }>
  | Readonly<{
      route: 'durable';
      response: InteractiveTurnAcceptedResponse;
    }>;

export type InteractiveMessageSubmission =
  | Readonly<{ route: 'legacy' }>
  | Readonly<{
      route: 'durable';
      response: InteractiveTurnAcceptedResponse;
    }>;

export type InteractiveSendOptions = Readonly<{
  hidden?: boolean;
  turnSkill?: ChatTurnSkill;
  turnId?: string;
  turnIdPolicy?: 'required' | 'generate';
  legacyCompletion?: 'await' | 'detach';
}>;

export function sendMessage(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments?: ChatAttachment[],
  options?: InteractiveSendOptions
): Promise<InteractiveMessageSubmission>;
```

- [ ] **Step 1: Write failing attachment and repository tests**

Cover:

```typescript
it('uses one immutable key per attachment hash', async () => {
  const stored = await store.upload({
    threadId: THREAD_ID,
    turnId: TURN_ID,
    attachment: {
      id: ATTACHMENT_ID,
      name: 'notes.txt',
      type: 'text/plain',
      size: 5,
      content: 'hello',
    },
  });
  expect(stored.blobRef.key).toMatch(
    new RegExp(
      `^interactive/${THREAD_ID}/${TURN_ID}/${ATTACHMENT_ID}/[a-f0-9]{64}$`
    )
  );
  expect(stored.materializedPath).toBe(
    `.ai-pilot/attachments/${TURN_ID}/notes.txt`
  );
});

it('returns the original run for the same turn hash', async () => {
  const first = await repository.admit(preparedTurn());
  const duplicate = await repository.admit(preparedTurn());
  expect(duplicate).toMatchObject({
    status: 'queued',
    runId: first.runId,
    turnId: TURN_ID,
    idempotent: true,
  });
});

it('does not insert a second bubble for a duplicate turn', async () => {
  await repository.admit(preparedTurn());
  await repository.admit(preparedTurn());
  expect(
    sqlStatements.filter((statement) =>
      statement.includes('INSERT INTO chat_messages')
    )
  ).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/interactiveToolGrantCrypto.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts --runInBand
```

Expected: FAIL because the three implementation modules are absent.

- [ ] **Step 3: Implement immutable attachment upload**

Export:

```typescript
export interface InteractiveAttachmentStore {
  upload(input: {
    threadId: string;
    turnId: string;
    attachment: ChatAttachment;
  }): Promise<ImmutableInteractiveAttachmentRef>;
}

export function createInteractiveAttachmentStore(options?: {
  container?: ContainerClient;
}): InteractiveAttachmentStore;
```

Decode base64 before hashing. Verify decoded byte length equals declared size.
Allow text MIME types, `image/*`, and DOCX. Reject other inputs with the exact
415 code from the design. Sanitize the materialized file name with the same
rules as the current attachment writer. Upload with `conditions:
{ ifNoneMatch: '*' }`. On an existing object, compare metadata SHA-256 and size;
reuse only an exact match.

- [ ] **Step 4: Encrypt the run-bound tool grant**

Implement tool-grant encryption with AES-256-GCM. Derive its key with
HKDF-SHA256 from `SESSION_SECRET`, salt
`apex-interactive-tool-proxy-v1`, and info `ado-turn-grant`. The encrypt
function accepts user/project/allowed operations/delegated token/expiry and
returns `FrozenInteractiveToolGrant`; decrypt verifies user, project, expiry,
and GCM tag. A missing secret returns
`503 INTERACTIVE_V2_TOOL_GRANT_UNAVAILABLE`.

Write tests proving ciphertext does not contain the token, an exact round trip
works, an expired grant fails, and a changed IV/ciphertext/tag each fail.

- [ ] **Step 5: Implement the sole atomic writer**

Define:

```typescript
export type PreparedDurableInteractiveTurn = Readonly<{
  turnId: string;
  requestHash: string;
  threadId: string;
  userId: string;
  projectId: string;
  interactiveClass: InteractiveClass;
  messageText: string;
  hidden: boolean;
  attachments: ReadonlyArray<ImmutableInteractiveAttachmentRef>;
  specification: DurableInteractiveTurnSpecification;
}>;
```

`admit` must execute the 15 ordered operations from “Atomic turn admission” in
the design in one `db.transaction`. Use
`pg_advisory_xact_lock(hashtextextended('interactive-user:' || userId, 0))`,
then `SELECT ... FROM chat_threads WHERE id = ... FOR UPDATE`.

Compute active counts from indexed `agent_runs` rows:

```sql
WHERE requested_by_user_id = $1
  AND lane = 'ai-runs-interactive'
  AND status IN ('queued', 'dispatched', 'running')
```

The outbox payload uses attempt 1 and the same generated fence stored in
`ai_run_attempts`; that attempt also stores the immutable specification in
`spec_snapshot`. Its idempotency key is
`${attemptId}:interactive-dispatch`. Insert the queued phase event before
commit. Use the database timestamp returned by one `SELECT now()` for message,
run, event, and thread timestamps, and derive `deadlineAt` by adding the
specification’s frozen `absoluteTurnMs` in SQL. The service does not supply an
application-clock deadline.

Do not call `createDispatchedV2Run`: interactive admission must stay queued
until the orchestrator owns capacity.

- [ ] **Step 6: Implement turn preparation without model execution**

`createDurableInteractiveTurnService` must:

1. validate `turnId` as a UUID
2. load the authoritative thread and registered skill/model metadata
3. determine capability inputs without scanning prompt prose
4. reject stdio MCP with the exact 422 code
5. upload all attachments before the transaction
6. resolve pinned grounding for a workspace-bound turn or return
   `INTERACTIVE_V2_GROUNDING_UNAVAILABLE`; freeze `grounding: null` for a
   plain-chat turn
7. freeze visible transcript, current/recreation prompts, skill content/hash,
   MCP descriptors, the encrypted run-bound tool grant, model, effort, and
   deadlines
8. calculate canonical SHA-256 over normalized text/model/skill and ordered
   attachment IDs/hashes
9. call repository `admit`
10. map thread conflict to 409 and user caps to the exact 429 codes

It must not import `@cursor/sdk`, `interactiveCursorExecution`, `Agent`, or any
model client.

- [ ] **Step 7: Write canonical routing tests**

Add these cases to `interactiveWorkflowRouter.test.ts`:

```typescript
it('uses current execution when the canonical flag is false', async () => {
  evaluate.mockResolvedValue(false);
  await router.route(input);
  expect(runLegacy).toHaveBeenCalledTimes(1);
  expect(admitDurable).not.toHaveBeenCalled();
});

it('uses current execution when canonical evaluation throws', async () => {
  evaluate.mockRejectedValue(new Error('flag store unavailable'));
  await router.route(input);
  expect(runLegacy).toHaveBeenCalledTimes(1);
  expect(admitDurable).not.toHaveBeenCalled();
});

it('never invokes current execution after the canonical flag is true', async () => {
  evaluate.mockResolvedValue(true);
  admitDurable.mockRejectedValue(new Error('blob unavailable'));
  await expect(router.route(input)).rejects.toThrow('blob unavailable');
  expect(runLegacy).not.toHaveBeenCalled();
});
```

- [ ] **Step 8: Run routing tests and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveWorkflowRouter.test.ts --runInBand
```

Expected: FAIL because the router still evaluates `ai-runs-interactive` and
routes admission failures in-process.

- [ ] **Step 9: Add the cleanup-ready canonical split**

Evaluate `ai-runs-v2-transport` first with feature-flag markers whose enabled
branch is the winner. Put the complete current send behavior behind the
disabled branch callback. The enabled branch may call only
`durableInteractiveTurnService.admit`.

Extract the current `sendMessage` body to a module-private
`sendMessageLegacy`. The exported `sendMessage` evaluates the canonical router
for every HTTP, auto-kickoff, Interview/ADR assistant, and service caller.
Options add `turnId?: string` and `legacyCompletion?: 'await' | 'detach'`.
They also add `turnIdPolicy?: 'required' | 'generate'`. Internal callers
default to `await` plus `generate`, preserving their current completion
semantics and receiving a server UUID on the durable path. The chat route uses
`detach` plus `required`, preserving its current 202 timing while enforcing the
client idempotency key only when the canonical flag is enabled.
No module outside `chatAgentService.ts` may import `sendMessageLegacy`.

Keep the current `tryDispatchInteractiveTurn` and `ai-runs-interactive` logic
inside `sendMessageLegacy`. Do not remove it in Task 2.

- [ ] **Step 10: Change the send route response boundary**

Use Task 1's optional `SendMessageRequest.turnId` for rollout compatibility and
make the canonical enabled branch reject a missing/invalid value with 400. The
updated client always sends it; the legacy branch continues accepting older
clients that omit it. In the canonical enabled branch, await admission and
return:

```typescript
res.status(202).json({
  turnId: accepted.turnId,
  runId: accepted.runId,
  status: accepted.status,
  interactiveClass: accepted.interactiveClass,
} satisfies InteractiveTurnAcceptedResponse);
```

In the legacy branch, preserve the current `{ ok: true }` response and
fire-and-forget behavior by calling unified `sendMessage` with
`legacyCompletion: 'detach'` and `turnIdPolicy: 'required'`. Apply the
pre-existing running-thread recovery check only to that legacy branch; the
durable repository owns its own active-run check.

- [ ] **Step 11: Prove transaction rollback and concurrent limits**

The integration test must inject a failure after each of these statements:
message, attachments, run, attempt, outbox, queued event, and thread update.
After each failure, assert none of those rows committed.

Then run concurrent admissions and prove:

- same turn ID/hash yields one message and one run
- same turn ID/different hash returns conflict
- two different turns on one thread yield one accepted and one thread conflict
- one user gets two turns on different threads
- a third gets `USER_INTERACTIVE_LIMIT`
- a second concurrent agentic turn gets `USER_AGENTIC_LIMIT`
- sixteen already-dispatched global runs do not block another eligible user’s
  queued admission

Run:

```bash
npx jest --config jest.config.integration.js tests/integration/durable-interactive-admission.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 12: Run Task 2 green checks**

Run:

```bash
npx jest src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/interactiveToolGrantCrypto.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/chatRoutes.test.ts src/server/__tests__/chatAgentService.test.ts --runInBand
npm run build:server
```

Expected: PASS with no canonical-enabled call to current execution.

- [ ] **Step 13: Commit Task 2**

```bash
git add src/server/services/interactiveAttachmentStore.ts src/server/services/interactiveToolGrantCrypto.ts src/server/services/durableInteractiveTurnRepository.ts src/server/services/durableInteractiveTurnService.ts src/server/services/interactiveWorkflowRouter.ts src/server/services/chatAgentService.ts src/server/services/aiRunV2/outboxRepository.ts src/server/routes/chat.ts src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/interactiveToolGrantCrypto.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/chatRoutes.test.ts tests/integration/durable-interactive-admission.integration.test.ts
git commit -m "feat: persist interactive turns atomically"
```

---

### Task 3: Dispatch queued classes through the orchestrator

**Files:**

- Create: `src/server/services/aiOrchestrator/interactiveActorDispatchClient.ts`
- Modify: `src/server/services/aiOrchestrator/types.ts`
- Modify: `src/server/services/aiOrchestrator/providerGovernor.ts`
- Modify: `src/server/services/aiOrchestrator/admissionController.ts`
- Modify: `src/server/services/aiOrchestrator/outboxDrainer.ts`
- Modify: `src/server/services/aiOrchestrator/utilizationReader.ts`
- Modify: `src/server/services/aiOrchestrator/entrypoint.ts`
- Modify: `src/server/services/aiRunV2/runAttemptRepository.ts`
- Modify: `src/server/services/aiRunV2/outboxRepository.ts`
- Test: `src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts`
- Test: `src/server/__tests__/aiOrchestrator/providerGovernor.test.ts`
- Test: `src/server/__tests__/aiOrchestrator/admissionController.test.ts`
- Test: `src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts`
- Test: `src/server/__tests__/aiOrchestrator/utilizationReader.test.ts`

**Interfaces:**

- Consumes: queued `interactive_dispatch` rows, Task 1 payload guard, existing
  outbox lease/NOTIFY/safety sweep, and `runAttemptRepository`.
- Produces:

```typescript
export interface InteractiveActorDispatchClient {
  dispatch(payload: InteractiveDispatchOutboxPayload): Promise<void>;
}

export type DispatchDestination =
  | Readonly<{ kind: 'service-bus'; queueName: string }>
  | Readonly<{ kind: 'dapr-actor'; interactiveClass: InteractiveClass }>;
```

- [ ] **Step 1: Write failing floor, burst, and endpoint tests**

```typescript
it('reserves two slots for each class and borrows through sixteen', () => {
  expect(
    evaluateInteractiveCapacity(utilization({ fast: 2, agentic: 0 }), 'agentic')
  ).toEqual({ status: 'allow', borrowed: false });
  expect(
    evaluateInteractiveCapacity(
      utilization({ fast: 14, agentic: 1 }),
      'agentic'
    )
  ).toEqual({ status: 'allow', borrowed: false });
  expect(
    evaluateInteractiveCapacity(utilization({ fast: 14, agentic: 2 }), 'fast')
  ).toEqual({ status: 'deny', reason: 'interactive_cap' });
});

it('calls only the endpoint matching persisted class', async () => {
  await client.dispatch(payload({ interactiveClass: 'agentic' }));
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://agentic.example/dispatch',
    expect.objectContaining({ method: 'POST' })
  );
  expect(fetchImpl).not.toHaveBeenCalledWith(
    'https://fast.example/dispatch',
    expect.anything()
  );
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run:

```bash
npx jest src/server/__tests__/aiOrchestrator/providerGovernor.test.ts src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts --runInBand
```

Expected: FAIL because the client and interactive cap do not exist and the fast
floor is still four.

- [ ] **Step 3: Add direct dispatch client with no endpoint fallback**

`createInteractiveActorDispatchClient` accepts injected `fastUrl`,
`agenticUrl`, and `fetchImpl`. Normalize each URL once. Switch exhaustively on
`payload.interactiveClass`, POST to `/dispatch`, and require
`2xx + {accepted:true}`. A missing URL throws
`Interactive <class> dispatch endpoint is not configured`; it never uses the
other class endpoint.

The entrypoint reads exact variables:

```text
AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL
AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL
```

Do not add them to `.env.example` or deployment files in Task 7.

- [ ] **Step 4: Implement class-aware utilization and capacity**

Add `interactiveCap: 16` to `ProviderCapacityConfig`; change fast/agentic
floors to two each. Preserve document/visual behavior.

`utilizationReader` must count class from `agent_runs.interactive_class` for
`dapr-actor-v2` rows in dispatched/running status. Queued rows consume user
limits but not execution slots.

Capacity evaluation order is:

1. deny expired payload
2. deny at total interactive 16
3. allow a class below its floor
4. allow either class in remaining shared burst

Do not preempt or relabel a persisted class.

- [ ] **Step 5: Add fair interactive outbox claiming**

Add:

```typescript
claimInteractiveBatch(
  perClassLimit: number,
  holderId: string,
  claimMs: number,
): Promise<OutboxRow[]>;
```

Use `row_number() OVER (PARTITION BY payload->>'interactiveClass' ORDER BY
available_at, created_at, id)` and select up to `perClassLimit` from each class.
Order the claimed union by oldest due time. Rows below their two-slot floor are
planned before rows that borrow shared burst.

Add `releaseClaim(id, holderId, availableAt, detail)` for expected capacity
deferral. It clears claim fields without incrementing a failure metric or
marking the row published.

- [ ] **Step 6: Make dispatch state and direct invocation recoverable**

Add repository operations:

```typescript
readInteractiveDispatchState(input: {
  attemptId: string;
  expectedDispatchMessageId: string;
}): Promise<
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'terminal'
  | 'fence-mismatch'
  | 'not-found'
>;

markInteractiveDispatched(input: {
  attemptId: string;
  expectedDispatchMessageId: string;
}): Promise<'dispatched' | 'already-dispatched' | 'fence-mismatch' | 'not-found'>;

failExpiredInteractiveDispatch(input: {
  attemptId: string;
  expectedDispatchMessageId: string;
  detail: string;
}): Promise<void>;
```

For an allowed row:

1. mark the current attempt/run dispatched under the fence
2. write the durable dispatched phase
3. call the direct class client
4. mark the outbox row published after `{accepted:true}`

Before capacity planning, read each claimed interactive attempt’s state. A
queued attempt requests a new slot. A dispatched/running attempt already
occupies the slot counted by `utilizationReader`, so the planner permits its
recovery invocation without incrementing utilization or applying the cap a
second time. A terminal attempt marks its outbox row published without another
invoke. Fence mismatch/not-found terminalizes the outbox row as an invalid
dispatch.

If the row is reclaimed after step 1, `already-dispatched` therefore reuses the
same attempt/fence and invokes again without charging a second capacity slot.
Actor dedupe in Task 4 makes that replay safe.

If `deadlineAt <= now`, terminalize with `hard_timeout` and publish error/done
events without invoking either endpoint.

- [ ] **Step 7: Branch the outbox drainer exhaustively**

Background `dispatch_command` rows retain their current Service Bus publisher.
Interactive rows use the direct client. Implement:

```typescript
switch (row.kind) {
  case 'dispatch_command':
    // existing Service Bus path
    break;
  case 'interactive_dispatch':
    // direct actor path
    break;
  case 'checkpoint_notify':
  case 'terminal_result':
    // existing non-command behavior
    break;
  default: {
    const unhandled: never = row.kind;
    throw new Error(`Unsupported outbox kind: ${String(unhandled)}`);
  }
}
```

Capacity denial calls `releaseClaim` with a five-second `availableAt`.
Invocation errors call `markFailed` with ten-second retry. Neither path invokes
App Service execution. NOTIFY remains the normal wake; the existing 30-second
sweep remains unchanged.

- [ ] **Step 8: Run orchestrator green checks**

Run:

```bash
npx jest src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts src/server/__tests__/aiOrchestrator/providerGovernor.test.ts src/server/__tests__/aiOrchestrator/admissionController.test.ts src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts src/server/__tests__/aiOrchestrator/utilizationReader.test.ts src/server/__tests__/aiRunV2RunAttemptRepository.test.ts src/server/__tests__/aiRunV2OutboxRepository.test.ts --runInBand
npm run build:server
```

Expected: PASS; tests prove no interactive call reached the Service Bus
publisher and the 17th active turn stayed queued.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/server/services/aiOrchestrator/interactiveActorDispatchClient.ts src/server/services/aiOrchestrator/types.ts src/server/services/aiOrchestrator/providerGovernor.ts src/server/services/aiOrchestrator/admissionController.ts src/server/services/aiOrchestrator/outboxDrainer.ts src/server/services/aiOrchestrator/utilizationReader.ts src/server/services/aiOrchestrator/entrypoint.ts src/server/services/aiRunV2/runAttemptRepository.ts src/server/services/aiRunV2/outboxRepository.ts src/server/__tests__/aiOrchestrator/interactiveActorDispatchClient.test.ts src/server/__tests__/aiOrchestrator/providerGovernor.test.ts src/server/__tests__/aiOrchestrator/admissionController.test.ts src/server/__tests__/aiOrchestrator/outboxDrainer.test.ts src/server/__tests__/aiOrchestrator/utilizationReader.test.ts
git commit -m "feat: dispatch interactive classes from the orchestrator"
```

---

### Task 4: Reach actor parity and enforce deadlines

**Files:**

- Create: `src/server/services/interactiveActorHost/interactiveWorkspaceMaterializer.ts`
- Create: `src/server/services/interactiveActorHost/interactiveArtifactCollector.ts`
- Create: `src/server/services/interactiveToolProxyToken.ts`
- Create: `src/server/services/interactiveToolProxyService.ts`
- Create: `src/server/services/interactiveArtifactApplier.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveCursorExecution.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveSessionActor.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveSessionActorClass.ts`
- Modify: `src/server/services/interactiveActorHost/entrypoint.ts`
- Modify: `src/shared/types/aiRunIngest.ts`
- Modify: `src/server/services/chatAgentService.ts`
- Modify: `src/server/routes/aiRunsInternal.ts`
- Modify: `src/server/services/aiRunIngestService.ts`
- Modify: `src/server/services/aiRunsWorker/callbackClient.ts`
- Test: `src/server/__tests__/interactiveWorkspaceMaterializer.test.ts`
- Test: `src/server/__tests__/interactiveToolProxyToken.test.ts`
- Test: `src/server/__tests__/interactiveToolProxyService.test.ts`
- Test: `src/server/__tests__/interactiveArtifactApplier.test.ts`
- Test: `src/server/__tests__/interactiveCursorExecution.test.ts`
- Test: `src/server/__tests__/interactiveSessionActor.test.ts`
- Test: `src/server/__tests__/interactiveActorHostEntrypoint.test.ts`
- Test: `src/server/__tests__/interactiveActorNoDatabaseImports.test.ts`
- Test: `src/server/__tests__/chatAgentService.test.ts`
- Test: `src/server/__tests__/aiRunsInternalRoutes.test.ts`
- Test: `src/server/__tests__/aiRunIngestService.test.ts`

**Interfaces:**

- Consumes: frozen specification from Task 2; Task 3 dispatch IDs/fence;
  existing repo-read, Blob artifact, runner auth, Cursor core, and MCP servers.
- Produces:

```typescript
export type InteractiveAgentAcquisition =
  | Readonly<{ mode: 'warm'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'resumed'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'recreated'; handle: InteractiveCursorAgentHandle }>;

export type InteractiveActorBootstrap = Readonly<{
  specification: DurableInteractiveTurnSpecification;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  attemptStatus: AiRunV2AttemptStatus;
  dispatchMessageId: string;
  absoluteDeadlineAt: string;
  cursorAgentId: string | null;
  mcpServers: Readonly<Record<string, McpServerConfig>>;
}>;
```

- [ ] **Step 1: Write failing materialization and recreation tests**

Prove:

```typescript
it('materializes only paths returned for the pinned SHA', async () => {
  await materializeInteractiveWorkspace({
    reader: pinnedReader,
    destination,
    attachments: [attachmentRef],
    readAttachment,
    signal,
  });
  expect(await fs.readFile(path.join(destination, 'src/a.ts'), 'utf8')).toBe(
    'export const a = 1;'
  );
  expect(
    await fs.readFile(
      path.join(destination, '.ai-pilot/attachments/turn-1/notes.txt'),
      'utf8'
    )
  ).toBe('hello');
});

it('uses recreationPrompt after agent_not_found', async () => {
  resume.mockRejectedValue(
    Object.assign(new Error('gone'), { code: 'agent_not_found' })
  );
  const acquired = await acquireInteractiveCursorAgent(spec, reader, {
    resumeAgentId: 'old-agent',
    mcpServers,
  });
  expect(acquired.mode).toBe('recreated');
  await acquired.handle.send(
    acquired.mode === 'recreated' ? spec.recreationPrompt : spec.currentPrompt
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(spec.recreationPrompt);
});
```

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveCursorExecution.test.ts --runInBand
```

Expected: FAIL because materialization and acquisition modes do not exist.

- [ ] **Step 3: Implement safe pinned workspace materialization**

When `specification.grounding` is present, recursively walk
`RepoReader.listDir`, reject absolute/parent traversal and symlinks, create
files with mode `0600`, and skip `.git`. When it is null, create an empty
attempt-local workspace and do not call repo-read. Check the abort signal
before each list/read/write. Remove the whole attempt directory on any error.

For each attachment:

1. download its Blob ref
2. verify SHA-256 and byte size
3. resolve `materializedPath` beneath the attempt directory
4. write with `wx`
5. for DOCX, extract text beside the source using the current chat behavior

The caller supplies the repository-preparation timeout from the specification;
this module has no timer default.

- [ ] **Step 4: Make acquisition return warm/resumed/recreated**

`acquireInteractiveCursorAgent` receives the exact model, effort, workspace,
native tools, and bootstrapped `mcpServers`. Remove `mcpServers: {}`. It must
not resolve model, effort, deadline, skill, or MCP policy locally.

Return `mode: 'resumed'` after a successful resume and `mode: 'recreated'`
after `agent_not_found` followed by create. The session actor owns `mode:
'warm'` for a compatible cache hit.

- [ ] **Step 5: Write failing signed-proxy tests**

Test expiry, changed run/attempt/fence/server, and tampering:

```typescript
const token = issueInteractiveToolProxyToken(
  {
    runId: 'run-1',
    attemptId: 'attempt-1',
    dispatchMessageId: 'fence-1',
    serverName: 'ado-skills',
    expiresAt: '2026-09-23T16:00:00.000Z',
  },
  SECRET
);

expect(verifyInteractiveToolProxyToken(token, SECRET, NOW)).toMatchObject({
  runId: 'run-1',
  serverName: 'ado-skills',
});
expect(() => verifyInteractiveToolProxyToken(`${token}x`, SECRET, NOW)).toThrow(
  'Invalid interactive tool proxy signature'
);
```

- [ ] **Step 6: Implement domain-separated signed proxy endpoints**

Derive an HMAC key with HKDF-SHA256 using:

```text
salt: apex-interactive-tool-proxy-v1
info: run-bound-mcp
input key material: SESSION_SECRET
```

There is no fallback secret. Encode canonical JSON as base64url and sign with
HMAC-SHA256. Compare signatures with `timingSafeEqual`.

Add:

```text
POST /api/internal/ai-runs/:runId/tools/:serverName
```

The route verifies token, expiry, path claims, active attempt, and dispatch
fence before calling `interactiveToolProxyService`. Map descriptors
exhaustively:

- `ado-skills`, `calendar-assistant`, `maxview` use existing Apex MCP/domain
  handlers
- external HTTP descriptors relay only to the frozen HTTPS URL and resolve
  frozen header environment references on App Service

Repository tools stay actor-local. No proxy branch imports Cursor/model.

For an ADO-write turn, freeze a run-bound authorization grant after the
existing permission check. Encrypt any delegated ADO token with AES-256-GCM
using a second HKDF key (`info: ado-turn-grant`) and store only ciphertext,
IV, tag, user, project, allowed operation, and expiry in the execution
snapshot. The proxy decrypts it only for the matching signed run/attempt/fence.
Never log or return the credential.

- [ ] **Step 7: Extend bootstrap and ingest around attempts**

`getBootstrap` must select the active attempt by run ID and exact
`dispatch_message_id`, validate transport `dapr-actor-v2`, parse the frozen
specification from `ai_run_attempts.spec_snapshot` (never from a newer
attempt), and return `InteractiveActorBootstrap`.

The callback client keeps its existing runner-auth retry behavior and adds
typed parsing for the bootstrap response.

Dapr serializes calls for one thread actor. At method entry, inspect
`attemptStatus`: queued/dispatched/running with the exact fence may execute or
resume; completed/failed/cancelled returns the matching prior outcome without
calling Cursor. Thus a reclaimed outbox invocation queued behind the original
call observes terminal state and cannot execute the turn twice.

Progress and terminal ingest must validate both current attempt ID and fence.
A fence mismatch returns 409 before event, thread, artifact, or agent-ID writes.
Terminal ingest:

1. drains/accepts already-persisted stream events
2. verifies/applies an optional actor artifact manifest
3. persists final assistant message
4. terminalizes attempt/run
5. clears only the matching thread active run
6. persists error/done events

All six writes occur in one transaction.

- [ ] **Step 8: Enforce all deadlines from bootstrap**

Use one absolute `AbortController` timer ending at
`absoluteDeadlineAt`. Agentic materialization is additionally raced against
`repositoryPreparationMs`. Arm first-event immediately before `agent.send`,
choosing warm/cold from acquisition mode. Arm each tool call with
`toolCallMs`.

On expiry:

- abort repository/Blob work
- cancel the active SDK run
- dispose the agent
- stop future events
- post exactly one fenced failed terminal with `hard_timeout` or
  `tool_timeout`

On user cancel, use the same cleanup but terminalize cancelled. On fence
conflict, clean up locally and write nothing.

For `dapr-actor-v2`, `chatAgentService.cancelRun` sets
`agent_runs.cancel_requested = true` only on the active run/fence and does not
look for or dispose an App Service agent. The next actor progress/heartbeat
observes the flag in its ingest response, cancels the SDK run, and posts a
fenced cancel acknowledgement. Legacy cancellation remains unchanged.

- [ ] **Step 9: Collect and apply workspace outputs**

The actor collector may include only regular files under:

```text
.ai-pilot/output/**
.ai-pilot/kickoff-transcript.md
```

Reject symlinks, hard links, parent traversal, and files outside those paths.
Upload through the existing attempt-scoped artifact uploader and write the
manifest last. App Service verifies checksums and applies files beneath the
thread workspace before terminal success. This persistence is allowed;
App Service still never runs Cursor/model.

- [ ] **Step 10: Add the actor database-import guard**

Traverse static imports from
`interactiveActorHost/entrypoint.ts`,
`interactiveActorHost/interactiveSessionActorClass.ts`, and
`interactiveActorHost/interactiveSessionActor.ts`. Fail when the reachable
graph imports `db`, `drizzle`, `pg`, `schema`, or any
`src/server/services/aiRunV2` module that imports them. Allow callback clients,
Blob, Redis, repo-read, MCP types, and pure shared contracts.

- [ ] **Step 11: Run Task 4 green checks**

Run:

```bash
npx jest src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveToolProxyToken.test.ts src/server/__tests__/interactiveToolProxyService.test.ts src/server/__tests__/interactiveArtifactApplier.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts src/server/__tests__/interactiveActorNoDatabaseImports.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/aiRunsInternalRoutes.test.ts src/server/__tests__/aiRunIngestService.test.ts --runInBand
npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts --runInBand
npm run build:server
```

Expected: PASS. The actor import graph has no database module; App Service
proxy modules have no Cursor/model import.

- [ ] **Step 12: Commit Task 4**

```bash
git add src/server/services/interactiveActorHost/interactiveWorkspaceMaterializer.ts src/server/services/interactiveActorHost/interactiveArtifactCollector.ts src/server/services/interactiveToolProxyToken.ts src/server/services/interactiveToolProxyService.ts src/server/services/interactiveArtifactApplier.ts src/server/services/interactiveActorHost/interactiveCursorExecution.ts src/server/services/interactiveActorHost/interactiveSessionActor.ts src/server/services/interactiveActorHost/interactiveSessionActorClass.ts src/server/services/interactiveActorHost/entrypoint.ts src/shared/types/aiRunIngest.ts src/server/services/chatAgentService.ts src/server/routes/aiRunsInternal.ts src/server/services/aiRunIngestService.ts src/server/services/aiRunsWorker/callbackClient.ts src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveToolProxyToken.test.ts src/server/__tests__/interactiveToolProxyService.test.ts src/server/__tests__/interactiveArtifactApplier.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts src/server/__tests__/interactiveActorNoDatabaseImports.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/aiRunsInternalRoutes.test.ts src/server/__tests__/aiRunIngestService.test.ts
git commit -m "feat: rehydrate durable turns in interactive actors"
```

---

### Task 5: Persist and replay interactive streams

**Files:**

- Create: `src/server/services/interactiveDurableStreamBatcher.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveSessionActor.ts`
- Modify: `src/server/services/interactiveLiveBus.ts`
- Modify: `src/server/services/interactiveGatewayService.ts`
- Modify: `src/server/services/pgNotifyService.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/utils/threadEventStream.ts`
- Modify: `src/client/hooks/useChatStream.ts`
- Test: `src/server/__tests__/interactiveDurableStreamBatcher.test.ts`
- Test: `src/server/__tests__/interactiveLiveBus.test.ts`
- Test: `src/server/__tests__/interactiveGatewayService.test.ts`
- Test: `src/server/__tests__/chatRunEvents.test.ts`
- Test: `src/client/utils/__tests__/threadEventStream.test.ts`
- Test: `src/client/hooks/__tests__/useChatStream.test.ts`

**Interfaces:**

- Consumes: existing `SseTokenEvent.streamOffset`,
  `streamEndOffset`, and `streamSnapshot`; Task 4 fenced ingest.
- Produces:

```typescript
export interface InteractiveDurableStreamBatcher {
  push(text: string): Promise<void>;
  flush(): Promise<void>;
  readonly nextOffset: number;
}

export type RunEventPage = Readonly<{
  events: ReadonlyArray<AgentRunEventEnvelope>;
  nextEventId: string | null;
  hasMore: boolean;
}>;
```

- [ ] **Step 1: Write failing batching tests**

Use fake timers to prove:

- four pushes inside 249 ms cause no durable write
- the 250 ms tick writes one event
- a second write cannot occur before the next 250 ms tick
- each UTF-8 payload is at most 16 KiB
- offsets are contiguous
- `flush` drains multiple chunks at 250 ms spacing

Expected envelope:

```typescript
expect(persist).toHaveBeenNthCalledWith(
  1,
  expect.objectContaining({
    event: expect.objectContaining({
      type: 'token',
      text: 'hello',
      streamOffset: 0,
      streamEndOffset: 5,
    }),
  })
);
```

- [ ] **Step 2: Run batching tests and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveDurableStreamBatcher.test.ts --runInBand
```

Expected: FAIL because the batcher does not exist.

- [ ] **Step 3: Implement the durable batcher and dual publish**

The batcher uses `TextEncoder` to enforce 16 KiB without splitting a Unicode
code point. It creates one event ID for each chunk. The actor:

1. publishes each short live chunk to Redis immediately
2. appends the same text to the durable batcher
3. persists durable offset chunks through fenced ingest
4. waits for `flush()` before final message/terminal

When a live chunk and durable chunk boundaries match, reuse the durable event
ID/offset for Redis. When live boundaries are smaller, Redis events still carry
their own exact offset; overlap is resolved by client offsets. The final
assistant message remains the full authoritative snapshot.

- [ ] **Step 4: Write failing replay pagination tests**

Generate 1,201 durable events and assert gateway order:

```typescript
expect(replayRunEventPage.mock.calls.map((call) => call[1])).toEqual([
  undefined,
  'event-500',
  'event-1000',
]);
expect(sentDurableIds).toEqual(
  Array.from({ length: 1_201 }, (_value, index) => `event-${index + 1}`)
);
```

Publish a live event during page two and prove it is sent after event 1,201,
not between replay pages.

- [ ] **Step 5: Run gateway tests and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveGatewayService.test.ts src/server/__tests__/chatRunEvents.test.ts --runInBand
```

Expected: FAIL because replay stops after one 500-event page.

- [ ] **Step 6: Add an explicit page API and use it in WS and SSE**

`replayRunEventPage(threadId, {afterEventId, limit: 500, runId, coldStart})`
returns ascending events, `nextEventId`, and `hasMore`. A page of exactly 500
has more only when an additional row exists; query with `LIMIT 501` and return 500.

Both `interactiveGatewayService` and the chat SSE route must:

1. subscribe before page one
2. request `coldStart: 'oldest'` for an active run
3. loop while `hasMore`
4. update cursor from `nextEventId`
5. buffer Redis/NOTIFY/thread events throughout the loop
6. flush after the final page

`shouldAssignRunEventSseId` must return true for a token event only when it has
a valid nonnegative `streamOffset`. The SSE `id:` and WebSocket frame `id` are
that envelope’s event ID; legacy id-less token behavior remains unchanged.

Keep the existing one-page `replayRunEvents` wrapper for callers that need it;
implement it through the new page function.

- [ ] **Step 7: Implement client offset merge and dedupe**

Replace event-ID-only token handling with:

```typescript
export function durableTokenKey(eventId: string, event: SseTokenEvent): string {
  return `${eventId}:${event.streamOffset ?? 'legacy'}`;
}
```

For offset events:

- duplicate key: ignore
- offset equals current length: append
- offset below current length with equal overlapping text: ignore overlap and
  append only the unseen suffix
- offset below current length with different text: replace from that offset
- offset above current length: hold in an offset-keyed pending map until the
  gap arrives
- final `message`: clear stream/pending state

Legacy tokens without offsets continue append-only. Keep bounded seen-key
retention at 2,048 entries.

- [ ] **Step 8: Prefer WebSocket under the canonical flag**

In `App.tsx`, derive `interactiveWsEnabled` from
`homeFlags['ai-runs-v2-transport'] === true`. Keep
`openWsWithSseFallback`. Do not call a send/retry method while switching to
SSE; it is transport-only.

- [ ] **Step 9: Run Task 5 green checks**

Run:

```bash
npx jest src/server/__tests__/interactiveDurableStreamBatcher.test.ts src/server/__tests__/interactiveLiveBus.test.ts src/server/__tests__/interactiveGatewayService.test.ts src/server/__tests__/chatRunEvents.test.ts src/client/utils/__tests__/threadEventStream.test.ts src/client/hooks/__tests__/useChatStream.test.ts --runInBand
npm run build:server
npx tsc -p tsconfig.client.json --noEmit
```

Expected: PASS, including 1,201-event replay, Redis interruption, WS reconnect,
and SSE fallback.

- [ ] **Step 10: Commit Task 5**

```bash
git add src/server/services/interactiveDurableStreamBatcher.ts src/server/services/interactiveActorHost/interactiveSessionActor.ts src/server/services/interactiveLiveBus.ts src/server/services/interactiveGatewayService.ts src/server/services/pgNotifyService.ts src/server/routes/chat.ts src/client/utils/threadEventStream.ts src/client/hooks/useChatStream.ts src/client/App.tsx src/server/__tests__/interactiveDurableStreamBatcher.test.ts src/server/__tests__/interactiveLiveBus.test.ts src/server/__tests__/interactiveGatewayService.test.ts src/server/__tests__/chatRunEvents.test.ts src/client/utils/__tests__/threadEventStream.test.ts src/client/hooks/__tests__/useChatStream.test.ts
git commit -m "feat: replay durable interactive token streams"
```

---

### Task 6: Retry failed runs without resending text

**Files:**

- Modify: `src/server/services/durableInteractiveTurnRepository.ts`
- Modify: `src/server/services/durableInteractiveTurnService.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/client/hooks/useChatStream.ts`
- Modify: `src/client/hooks/useAgentChatSession.ts`
- Modify: `src/client/components/ChatAgentPanel.tsx`
- Modify: `src/client/components/InterviewChatView.tsx`
- Modify: `src/client/components/AdrChatView.tsx`
- Test: `src/server/__tests__/durableInteractiveTurnRepository.test.ts`
- Test: `src/server/__tests__/chatRoutes.test.ts`
- Test: `src/client/hooks/__tests__/useAgentChatSession.test.ts`
- Test: `src/client/components/__tests__/ChatAgentPanel.sharedShell.test.tsx`
- Test: `src/client/components/__tests__/InterviewChatView.ExistingInterview.test.tsx`
- Test: `src/client/components/__tests__/AdrChatView.ExistingAdr.test.tsx`
- Test: `tests/integration/durable-interactive-retry.integration.test.ts`

**Interfaces:**

- Consumes: failed run ID from durable error events and the original run
  specification/message/Blob refs.
- Produces:

```typescript
export type RetryDurableInteractiveRunInput = Readonly<{
  threadId: string;
  runId: string;
  userId: string;
  refreshedToolGrant: FrozenInteractiveToolGrant | null;
}>;

export interface DurableInteractiveTurnRepository {
  admit(
    input: PreparedDurableInteractiveTurn
  ): Promise<AdmitDurableInteractiveTurnResult>;
  retry(
    input: RetryDurableInteractiveRunInput
  ): Promise<InteractiveTurnAcceptedResponse>;
}

export interface AgentChatSession {
  // existing fields stay
  retryableRunId: string | null;
  retryFailedRun(): Promise<void>;
}
```

- [ ] **Step 1: Write failing repository retry tests**

Prove:

```typescript
it('creates a fresh attempt and reuses the original message', async () => {
  const retried = await repository.retry({
    threadId: THREAD_ID,
    runId: FAILED_RUN_ID,
    userId: USER_ID,
  });
  expect(retried).toMatchObject({
    runId: FAILED_RUN_ID,
    status: 'queued',
  });
  expect(latestAttempt.attemptNumber).toBe(2);
  expect(latestAttempt.dispatchMessageId).not.toBe(firstFence);
  expect(messageCountForTurn).toBe(1);
});

it('returns the active retry when the request is repeated', async () => {
  const first = await repository.retry(input);
  const second = await repository.retry(input);
  expect(second.runId).toBe(first.runId);
  expect(attemptCount).toBe(2);
});
```

- [ ] **Step 2: Run repository tests and verify red**

Run:

```bash
npx jest src/server/__tests__/durableInteractiveTurnRepository.test.ts --runInBand
```

Expected: FAIL because `retry` is absent.

- [ ] **Step 3: Implement retry transaction**

Lock user, thread, run, and latest attempt. Require:

- run belongs to `threadId`
- `requested_by_user_id` equals caller or caller already passed the thread
  write rule
- transport is `dapr-actor-v2`
- run and latest attempt are failed
- there is no active attempt

The retry service resolves a fresh delegated grant from the authenticated
request when the failed attempt’s specification allowed ADO operations. It
clones the failed attempt’s specification, replacing only `toolGrant`, and
passes that immutable value as the new attempt’s `spec_snapshot`.

Recheck per-user limits. Set a new `timeout_at` using the database clock plus
the persisted class’s exact absolute duration. Insert attempt N+1 and
`interactive_dispatch`; update the same run/thread to queued/running; emit a
queued phase. Do not touch `chat_messages` or attachment rows.

Use outbox idempotency `${attemptId}:interactive-dispatch`. A repeated retry
after attempt N+1 exists returns it.

- [ ] **Step 4: Add route and 404 parity tests**

Test:

- missing/inaccessible thread returns `404 {error:'Thread not found'}`
- run from another thread returns the same 404
- run owned by another inaccessible conversation returns the same 404
- nonfailed run returns `409 RUN_NOT_RETRYABLE`
- user caps return exact 429 codes
- success returns `InteractiveTurnAcceptedResponse`

Then add:

```text
POST /api/chat/threads/:threadId/runs/:runId/retry
```

behind `requireThreadWrite`. Do not accept text or attachments.

- [ ] **Step 5: Capture failed run identity in the stream hook**

On durable `error`, set `retryableRunId` from `event.runId`. Clear it on a new
accepted turn, successful final message, cancel, or thread change. A local
network/send error without a durable run ID is not retryable through this
method.

- [ ] **Step 6: Replace all blind resend callbacks**

`useAgentChatSession.retryFailedRun` POSTs the retry route using the exact
captured run ID. It does not call `send`, create an optimistic message, or
reuse text.

Update Home and Interview retry buttons to call it. Add the same terminal
error/retry treatment to ADR so all three surfaces use one hook contract.

Generate `turnId = crypto.randomUUID()` once before each initial send and
include it in the request and optimistic message ID. A fetch retry must reuse
that value for the same in-memory send attempt.

- [ ] **Step 7: Prove integration identity and limits**

The integration test creates a failed run with one message, retries it twice
concurrently, and asserts:

- one `agent_runs` row
- one `chat_messages` row
- exactly two attempts total
- attempt 2 has a new fence
- one unpublished retry outbox row
- thread points to the original run
- user cap rejection adds no attempt/outbox

Run:

```bash
npx jest --config jest.config.integration.js tests/integration/durable-interactive-retry.integration.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 8: Run Task 6 green checks**

Run:

```bash
npx jest src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/chatRoutes.test.ts src/client/hooks/__tests__/useAgentChatSession.test.ts src/client/components/__tests__/ChatAgentPanel.sharedShell.test.tsx src/client/components/__tests__/InterviewChatView.ExistingInterview.test.tsx src/client/components/__tests__/AdrChatView.ExistingAdr.test.tsx --runInBand
npm run build:server
npx tsc -p tsconfig.client.json --noEmit
```

Expected: PASS; every retry request contains a run ID and no message text.

- [ ] **Step 9: Commit Task 6**

```bash
git add src/server/services/durableInteractiveTurnRepository.ts src/server/services/durableInteractiveTurnService.ts src/server/routes/chat.ts src/client/hooks/useChatStream.ts src/client/hooks/useAgentChatSession.ts src/client/components/ChatAgentPanel.tsx src/client/components/InterviewChatView.tsx src/client/components/AdrChatView.tsx src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/chatRoutes.test.ts src/client/hooks/__tests__/useAgentChatSession.test.ts src/client/components/__tests__/ChatAgentPanel.sharedShell.test.tsx src/client/components/__tests__/InterviewChatView.ExistingInterview.test.tsx src/client/components/__tests__/AdrChatView.ExistingAdr.test.tsx tests/integration/durable-interactive-retry.integration.test.ts
git commit -m "feat: retry failed interactive runs by identity"
```

---

### Task 7: Remove every enabled-path execution fallback

**Files:**

- Modify: `src/server/services/interactiveWorkflowRouter.ts`
- Modify: `src/server/services/interactiveActorAdmissionService.ts`
- Modify: `src/server/services/chatAgentService.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/client/hooks/useAgentChatSession.ts`
- Modify: `src/client/components/ChatAgentPanel.tsx`
- Modify: `src/client/components/InterviewChatView.tsx`
- Modify: `src/client/components/AdrChatView.tsx`
- Modify: `tests/e2e/specs/ai-runs-interactive-transport.spec.ts`
- Test: `src/server/__tests__/interactiveV2NoFallback.test.ts`
- Test: `src/server/__tests__/interactiveWorkflowRouter.test.ts`
- Test: `src/server/__tests__/chatAgentService.test.ts`
- Test: `src/server/__tests__/chatRoutes.test.ts`

**Interfaces:**

- Consumes: all completed Task 1–6 paths.
- Produces: a source/runtime guard proving canonical enabled traffic has no
  App Service Cursor/model fallback, while the canonical disabled/error branch
  still owns the current behavior.

- [ ] **Step 1: Write the enabled-path no-fallback guard**

The test must inspect imports and inject every failure point:

```typescript
it.each([
  'attachment-validation',
  'attachment-upload',
  'classification',
  'grounding',
  'database',
  'outbox',
] as const)('does not execute current path after %s failure', async (stage) => {
  canonicalFlag.mockResolvedValue(true);
  failStage(stage);
  await expect(router.route(input)).rejects.toBeDefined();
  expect(runLegacy).not.toHaveBeenCalled();
  expect(runInProcess).not.toHaveBeenCalled();
  expect(postLegacyActor).not.toHaveBeenCalled();
});
```

Scan `durableInteractiveTurnService.ts`,
`durableInteractiveTurnRepository.ts`, the route handler, and retry call graph;
fail if those import `@cursor/sdk`, `bedrockService`, `Agent`, or the in-process
execution function. `chatAgentService.ts` still contains the legacy
implementation for flag-off, so prove through injected callbacks that its
canonical enabled branch never calls it. Scan every server reference to
`sendMessageLegacy` and fail unless its containing file is
`chatAgentService.ts`.

- [ ] **Step 2: Run the guard and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveV2NoFallback.test.ts --runInBand
```

Expected: FAIL while old router/admission types still describe shed/race
fallback as the active contract.

- [ ] **Step 3: Isolate legacy admission instead of deleting it**

Keep `interactiveActorAdmissionService` and its `4 + 12` behavior callable only
from the canonical disabled/error branch. Rename comments/types that imply it
governs Task 7. Mark BR-014 and BR-017 as legacy-only and point to the approved
design.

Remove these outcomes from the canonical enabled branch:

- dispatch URL unset
- attachments bypass
- workspace-bound skill bypass
- custom MCP bypass
- ADO/tool-heavy bypass
- over-capacity shed
- actor post failure fallback

Each is now supported by Tasks 2–4 or returns the exact explicit validation
error. No canonical-enabled catch block calls current execution.

- [ ] **Step 4: Add user-visible queued/dispatched and cap copy**

After `InteractiveTurnAcceptedResponse`, show “Queued”. On durable dispatched
phase, show “Dispatched”. Do not show a numeric position or wait estimate.

Map:

- `USER_INTERACTIVE_LIMIT` → “You already have two active AI turns. Finish or
  stop one before starting another.”
- `USER_AGENTIC_LIMIT` → “You already have an agentic AI turn running. Finish
  or stop it before starting another.”

Keep the composer disabled for the active run in the current thread. Switching
to another thread permits a second turn.

- [ ] **Step 5: Update the transport E2E contract**

The E2E test must prove:

1. canonical flag false preserves the current response/path
2. canonical flag true returns `{turnId,runId,status,interactiveClass}`
3. queued then dispatched labels appear
4. WebSocket failure switches to SSE but does not send another message
5. failed-run retry keeps one user bubble
6. unsupported stdio MCP returns 422 and starts no App Service AI work
7. global saturation leaves the request queued
8. a third per-user turn returns 429

Use mocked actor/Redis boundaries; do not require or change Azure.

- [ ] **Step 6: Run Task 7 green checks**

Run:

```bash
npx jest src/server/__tests__/interactiveV2NoFallback.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/interactiveActorAdmissionService.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/chatRoutes.test.ts src/client/hooks/__tests__/useAgentChatSession.test.ts --runInBand
npx playwright test tests/e2e/specs/ai-runs-interactive-transport.spec.ts --project=chromium
npm run build
```

Expected: PASS. The legacy admission suite remains green, but every canonical
enabled case proves no fallback.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/server/services/interactiveWorkflowRouter.ts src/server/services/interactiveActorAdmissionService.ts src/server/services/chatAgentService.ts src/server/routes/chat.ts src/client/hooks/useAgentChatSession.ts src/client/components/ChatAgentPanel.tsx src/client/components/InterviewChatView.tsx src/client/components/AdrChatView.tsx tests/e2e/specs/ai-runs-interactive-transport.spec.ts src/server/__tests__/interactiveV2NoFallback.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/chatRoutes.test.ts
git commit -m "fix: remove enabled interactive execution fallback"
```

---

### Task 8: Run the final verification and record evidence

**Files:**

- Modify:
  `docs/superpowers/plans/2026-09-17-apex-ai-workload-reliability-implementation.md`
- Review only: every file changed by Tasks 1–7

**Interfaces:**

- Consumes: complete Task 7 implementation.
- Produces: one reproducible verification record in the master reliability
  plan, with Task 7 marked complete only if every required command passes.

- [ ] **Step 1: Run focused server suites**

```bash
npx jest src/server/__tests__/durableInteractiveTurnTypes.test.ts src/server/__tests__/interactiveTurnClassifier.test.ts src/server/__tests__/durableInteractiveTurnsMigration.test.ts src/server/__tests__/interactiveAttachmentStore.test.ts src/server/__tests__/interactiveToolGrantCrypto.test.ts src/server/__tests__/durableInteractiveTurnRepository.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/interactiveV2NoFallback.test.ts src/server/__tests__/interactiveDurableStreamBatcher.test.ts src/server/__tests__/interactiveLiveBus.test.ts src/server/__tests__/interactiveGatewayService.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts src/server/__tests__/interactiveToolProxyToken.test.ts src/server/__tests__/interactiveToolProxyService.test.ts src/server/__tests__/interactiveArtifactApplier.test.ts src/server/__tests__/aiRunsInternalRoutes.test.ts src/server/__tests__/aiRunIngestService.test.ts src/server/__tests__/chatRoutes.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/aiOrchestrator --runInBand
```

Expected: PASS.

- [ ] **Step 2: Run focused client suites**

```bash
npx jest src/client/hooks/__tests__/useChatStream.test.ts src/client/hooks/__tests__/useAgentChatSession.test.ts src/client/utils/__tests__/threadEventStream.test.ts src/client/components/__tests__/ChatAgentPanel.sharedShell.test.tsx src/client/components/__tests__/InterviewChatView.ExistingInterview.test.tsx src/client/components/__tests__/AdrChatView.ExistingAdr.test.tsx --runInBand
```

Expected: PASS.

- [ ] **Step 3: Run integration suites against the approved test database**

```bash
npx jest --config jest.config.integration.js tests/integration/durable-interactive-turns.integration.test.ts tests/integration/durable-interactive-admission.integration.test.ts tests/integration/durable-interactive-retry.integration.test.ts tests/integration/ai-run-v2-persistence.integration.test.ts --runInBand
```

Expected: PASS. Never point these commands at dev, staging, or production.

- [ ] **Step 4: Run isolation, builds, and diff checks**

```bash
npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts src/server/__tests__/interactiveActorNoDatabaseImports.test.ts --runInBand
npm run build:server
npm run build:client
git diff --check
git status --short
```

Expected: PASS; status contains no generated `dist/` files staged for the
implementation commits.

- [ ] **Step 5: Perform the contradiction and type-name review**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement[[:space:]]+later|fill[[:space:]]+in[[:space:]]+details|ai-runs-interactive-v2|servicebus.*interactive|in-process fallback" src docs/superpowers/specs/2026-09-23-durable-interactive-turns-design.md docs/superpowers/plans/2026-09-23-durable-interactive-turns.md
rg -n "InteractiveClass|InteractiveDeadlinePolicy|DurableInteractiveTurnSpecification|InteractiveDispatchOutboxPayload|InteractiveTurnAcceptedResponse" src
rg -n "switch \\(" src/shared/types/durableInteractiveTurn.ts src/server/services/interactiveTurnClassifier.ts src/server/services/aiOrchestrator src/server/services/interactiveActorHost
```

Expected:

- no new Task 7 flag
- no interactive Service Bus publisher
- no enabled-path App Service model execution
- names exactly match Task 1 contracts
- every relevant switch has a `never` branch
- only legacy comments/tests mention in-process fallback

- [ ] **Step 6: Review scope and migration behavior**

Inspect:

```bash
git diff --name-only HEAD~7..HEAD
git diff --stat HEAD~7..HEAD
git diff HEAD~7..HEAD -- migrations/20260923140000_durable-interactive-turns.sql src/server/db/schema.ts
```

Expected: no Terraform, runner, deployment, environment, package, TypeScript
configuration, Jest configuration, or `src/server/index.ts` change. Confirm the
down migration refuses live durable data and the up migration never invents a
winner for duplicate active threads.

- [ ] **Step 7: Record exact evidence in the master plan**

Under Task 7 in
`docs/superpowers/plans/2026-09-17-apex-ai-workload-reliability-implementation.md`,
record:

- commit range for Tasks 1–7
- focused server/client pass counts
- integration pass counts and test database name
- server/client build results
- no-database-import guard result
- E2E result
- statement that no Azure/Terraform/deploy change or migration apply occurred
- deferred endpoint/deployment/identity work

Mark Task 7 complete only when every preceding command passed.

- [ ] **Step 8: Commit the verification record**

```bash
git add docs/superpowers/plans/2026-09-17-apex-ai-workload-reliability-implementation.md
git commit -m "docs: record durable interactive turn verification"
```

---

## Deferred operations

After Task 7 code is reviewed and merged, a separate approved operations plan
must provide the two class endpoint values, actor Blob/tool identity, deploy
wiring, canary sequence, migration apply, and rollback observation. It must not
be folded into any task above.

`ai-runs-interactive` retirement is also separate. Retire it only after the
canonical enabled path passes staging, production canary, mixed traffic, and
the required observation window.
