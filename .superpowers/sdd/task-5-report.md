# Task 5 implementation report

## Result

- Status: `DONE`
- Branch: `tbi/infra-changes`
- Implementation commit: `038fd6716c5e315c1de8c15f620bf083ea45560e`
  (`feat: replay durable interactive token streams`)
- No push, pull request, cloud operation, infrastructure change, deployment
  change, migration application, or protected configuration change was made.
- Only Task 5 source/test paths plus this report were staged. Pre-existing
  dirty infra/migration files remained unstaged.

## Implementation summary

- Added `interactiveDurableStreamBatcher` with a 250 ms tick, 16 KiB UTF-8
  payload cap (no code-point splits), contiguous offsets, and flush drain at
  250 ms spacing.
- Wired `handleDurableTurn` to dual-publish: Redis live tokens immediately
  (incremental batcher + offsets) and durable offset chunks via fenced
  progress ingest; durable `flush()` completes before final message/terminal.
- When live and durable chunk boundaries match, Redis reuses the live event
  id; otherwise durable publishes its own offset envelope for resume.
- Added `replayRunEventPage` (`LIMIT 501` / return 500 + `hasMore`); kept
  `replayRunEvents` as a one-page wrapper.
- Gateway and chat SSE subscribe before page one, use `coldStart: 'oldest'`
  for active/resume replay, loop while `hasMore`, buffer live during pages,
  and flush after the final page.
- `shouldAssignRunEventSseId` assigns SSE/WS ids for tokens with a valid
  nonnegative `streamOffset`.
- Client: `durableTokenKey`, offset merge/dedupe/pending-gap map, seen-key
  bound raised to 2048; final `message`/`done` clear stream/pending state.
- `App.tsx` derives `interactiveWsEnabled` from
  `homeFlags['ai-runs-v2-transport'] === true`; `openWsWithSseFallback`
  remains transport-only.

## Strict TDD evidence

### Batcher (red → green)

```text
npx jest src/server/__tests__/interactiveDurableStreamBatcher.test.ts --runInBand
→ FAIL (module missing), then PASS (6 tests)
```

### Task 5 focused suite

```text
npx jest src/server/__tests__/interactiveDurableStreamBatcher.test.ts src/server/__tests__/interactiveLiveBus.test.ts src/server/__tests__/interactiveGatewayService.test.ts src/server/__tests__/chatRunEvents.test.ts src/client/utils/__tests__/threadEventStream.test.ts src/client/hooks/__tests__/useChatStream.test.ts --runInBand
```

Result:

```text
Test Suites: 6 passed, 6 total
Tests:       100 passed, 100 total
```

Includes 1,201-event gateway replay with live event buffered until after the
final page, WS reconnect, and SSE fallback coverage in the existing stream
transport tests.

### Builds

```text
npm run build:server
→ tsc -p tsconfig.server.json (exit 0)

npx tsc -p tsconfig.client.json --noEmit
→ exit 0
```

## Files changed

### Created

- `src/server/services/interactiveDurableStreamBatcher.ts`
- `src/server/__tests__/interactiveDurableStreamBatcher.test.ts`
- `.superpowers/sdd/task-5-report.md`

### Modified

- `src/server/services/interactiveActorHost/interactiveSessionActor.ts`
- `src/server/services/interactiveLiveBus.ts`
- `src/server/services/interactiveGatewayService.ts`
- `src/server/services/pgNotifyService.ts`
- `src/server/routes/chat.ts`
- `src/client/App.tsx`
- `src/client/utils/threadEventStream.ts` (no behavior change required beyond
  existing `openWsWithSseFallback`; preference now driven by App flag)
- `src/client/hooks/useChatStream.ts`
- `src/server/__tests__/interactiveLiveBus.test.ts`
- `src/server/__tests__/interactiveGatewayService.test.ts`
- `src/server/__tests__/chatRunEvents.test.ts`
- `src/client/hooks/__tests__/useChatStream.test.ts`
- `src/server/__tests__/chatRoutes.test.ts` (SSE id + `replayRunEventPage` mock)
- `src/server/__tests__/pgNotifyService.test.ts` (LIMIT 501 expectations)

## Plan steps / blockers

- No steps skipped. Protected files (`package.json`, `src/server/index.ts`,
  `vite.config.ts`, auth, tsconfig, Jest config, CI, Terraform) were not
  modified.
- `threadEventStream.ts` already preferred WS with SSE fallback; Task 5 only
  needed the App flag switch to `ai-runs-v2-transport`.

## Remediation (review REQUEST CHANGES)

- Status: `DONE`
- Remediation commit: `649333b8996b73c43991f1ff0dc7559b94f9003c`
- Branch: `tbi/infra-changes`
- Feature base: `038fd671`
- No push, PR, Azure, or protected config changes.

### High 1 — Batcher persist ordering

- `emitOneChunk` advances `buffer` / `nextOffset` only after successful `persist`.
- Timer path keeps rejections on `writeChain` (dangling `.catch` does not
  reassign the chain); `flush()` rejects so the actor can fail the turn.
- Tests: persist failure does not drop text or create offset holes; flush
  rejects after timer failure.

### High 2 — Shared eventId Redis ↔ Postgres

- `AiRunProgressIngest.eventId` optional; fenced ingest validates UUID and uses
  it in `buildProgressEnvelope` (Postgres insert already `ON CONFLICT DO NOTHING`).
- Durable batcher generates `eventId` and passes it into progress ingest.
- When live and durable chunk boundaries match, Redis eventId (allocated before
  publish) is reused for Postgres; otherwise durable id is published to both.

### High 3 — SSE Redis live subscribe

- `chat.ts` stream: under `ai-runs-v2-transport`, `interactiveLiveBus.subscribe`
  before page one; buffer during `hasMore` loop; flush after final page; dedupe
  by `eventId` and token `streamOffset`.

### Medium / Low

- Durable-path actor test: dual-publish Redis + durable progress with offsets;
  flush before message/terminal.
- Legacy `resolveReplayPage` requests `limit + 1` and slices like
  `replayRunEventPage` (no false `hasMore` without LIMIT+1).
- `shouldAssignRunEventSseId`: `streamOffset` `-1` / `NaN` → false.

### Verify

```text
npx jest … (9 suites) → 215 passed
npm run build:server → exit 0
npx tsc -p tsconfig.client.json --noEmit → exit 0
```
