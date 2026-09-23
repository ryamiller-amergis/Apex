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
