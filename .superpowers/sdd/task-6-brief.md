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
  refreshedDeadlines: InteractiveDeadlinePolicy;
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
also resolves the current existing first-event/tool/repository-preparation
configuration. It clones the failed attempt’s specification, replacing only
`toolGrant` and `deadlines`; message, attachments, transcript, skill, model,
class, and grounding stay frozen. It passes that immutable value as the new
attempt’s `spec_snapshot`.

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
