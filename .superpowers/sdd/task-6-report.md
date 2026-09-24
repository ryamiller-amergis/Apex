# Task 6 Report — Retry failed runs without resending text

**Branch:** `tbi/infra-changes`  
**HEAD before:** `599a2cf0`  
**Commit message:** `feat: retry failed interactive runs by identity`

## What shipped

Failed durable interactive runs can be retried by run identity. Retry never
inserts a second user message, never uploads attachments, and never resends
composer text. Home, Interview, and ADR share one hook contract.

### Server

- `durableInteractiveTurnRepository.retry` locks user/thread/run/latest
  attempt; requires same thread, `dapr-actor-v2`, failed run+attempt, and no
  active attempt; clones `spec_snapshot` replacing only `toolGrant` +
  `deadlines`; inserts attempt N+1 + `interactive_dispatch` with outbox
  idempotency `${attemptId}:interactive-dispatch`; refreshes `timeout_at`;
  repeated retry returns the active attempt.
- `durableInteractiveTurnService.retry` loads the failed attempt’s
  specification, refreshes deadlines and (when needed) the delegated tool
  grant, maps `not_retryable` → `409 RUN_NOT_RETRYABLE` and caps → `429`.
- `POST /api/chat/threads/:id/runs/:runId/retry` behind `requireThreadWrite`;
  no text/attachments body; 404 parity with send; stable 409/429 codes.

### Client

- `useChatStream` exposes `retryableRunId` from durable `error.runId` (and
  clears on thread change / successful `done` / cancel / new send).
- `useAgentChatSession.retryFailedRun` POSTs the retry route by run ID only.
- Home (`ChatAgentPanel`), Interview, and ADR retry buttons call
  `retryFailedRun` (no blind text resend). Initial send still generates
  `turnId = crypto.randomUUID()` once per in-memory send attempt.

## Verification

```text
npx jest …Task 6 unit files… --runInBand
→ 6 suites, 214 passed

npm run build:server
→ PASS

npx tsc -p tsconfig.client.json --noEmit
→ PASS

npx jest --config jest.config.integration.js \
  tests/integration/durable-interactive-retry.integration.test.ts --runInBand
→ 2 passed (DB available)
```

## Files changed

- `src/server/services/durableInteractiveTurnRepository.ts`
- `src/server/services/durableInteractiveTurnService.ts`
- `src/server/routes/chat.ts`
- `src/client/hooks/useChatStream.ts`
- `src/client/hooks/useAgentChatSession.ts`
- `src/client/components/ChatAgentPanel.tsx`
- `src/client/components/InterviewChatView.tsx`
- `src/client/components/AdrChatView.tsx`
- `src/shared/types/chat.ts` (`SseErrorEvent.runId`)
- Tests listed in the Task 6 plan, plus
  `tests/integration/durable-interactive-retry.integration.test.ts`
  and `AdrChatView.ExistingAdr.test.tsx` (new)

## Blockers

None. Integration DB was available and green.

---

## Remediation (REQUEST CHANGES)

**Base:** `e78cc1ce`  
**Commit message:** `fix: keep retryable run id through failure done`

### Changes

**Critical — `useChatStream.ts`**
- Stop clearing `retryableRunId` on clean `done` after a prior failure.
- Clear only on: accepted turn (via session), successful committed
  `message`, cancel, or thread change.
- Tests: `error → done` keeps `retryableRunId`; committed `message`
  clears it.

**High — `useAgentChatSession.ts`**
- Clear `retryableRunId` only after a 2xx retry POST (and after a 2xx
  send). Keep it on non-OK / catch so Retry stays available.
- `retryLast` left as legacy-only blind resend with an explicit comment.

**High — `durableInteractiveTurnRepository.ts`**
- Before promoting a failed run, recheck one-nonterminal-per-thread
  (same query as admit). Another active run returns
  `{ status: 'thread_active', activeRunId }`.
- Service maps that to `409 THREAD_ACTIVE_TURN`.
- Unit + route + integration coverage added.

### Verification

```text
npx jest …Task 6 unit files… --runInBand
→ 4 suites, 199 passed

npm run build:server
→ PASS

npx tsc -p tsconfig.client.json --noEmit
→ PASS

npx jest --config jest.config.integration.js \
  tests/integration/durable-interactive-retry.integration.test.ts --runInBand
→ 3 passed (DB available)
```

### Remaining gaps

None for the REQUEST CHANGES items. Blind `retryLast` remains available
for non-durable / legacy paths; UI surfaces use `retryFailedRun`.
