import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import { v5 as uuidv5 } from 'uuid';
import {
  loadRunEvent as loadDurableRunEvent,
  notifyRunEvent,
  replayRunEvents as replayDurableRunEvents,
  subscribeRunEvents as subscribeToRunEvents,
} from './pgNotifyService';
import {
  harvestUiLabV2Run,
  type UiLabRunHarvestResult,
} from './uiLabV2Harvest';

type ReplayRunEvents = typeof replayDurableRunEvents;
type SubscribeRunEvents = typeof subscribeToRunEvents;
type LoadRunEvent = typeof loadDurableRunEvent;
const REPLAY_PAGE_SIZE = 500;

export type ObserveUiLabV2RunInput = Readonly<{
  designId: string;
  runId: string;
  threadId: string;
  generationStartedAt: string;
  onToken: (
    text: string,
    eventId?: string,
    mode?: 'append' | 'replace',
  ) => void;
  afterEventId?: string;
}>;

export type ObserveUiLabV2RunDependencies = Readonly<{
  replayRunEvents?: ReplayRunEvents;
  subscribeRunEvents?: SubscribeRunEvents;
  loadRunEvent?: LoadRunEvent;
  harvestRun?: (
    input: Readonly<{
      designId: string;
      runId: string;
      generationStartedAt: string;
    }>,
  ) => Promise<UiLabRunHarvestResult>;
  publishFinalSnapshot?: (input: Readonly<{
    threadId: string;
    runId: string;
    html: string;
  }>) => Promise<AgentRunEventEnvelope>;
}>;

export type ObserveUiLabV2Run = (
  input: ObserveUiLabV2RunInput,
  dependencies?: ObserveUiLabV2RunDependencies,
) => Promise<void>;

type PendingDelta = Readonly<{
  text: string;
  eventId: string;
  endOffset: number;
}>;

function tokenEndOffset(envelope: AgentRunEventEnvelope): number | null {
  if (envelope.event.type !== 'token') return null;
  if (envelope.event.streamSnapshot) return envelope.event.text.length;
  const offset = envelope.event.streamOffset;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) return null;
  const numericOffset = offset as number;
  const endOffset = envelope.event.streamEndOffset;
  if (Number.isSafeInteger(endOffset) && (endOffset as number) >= numericOffset) {
    return endOffset as number;
  }
  return numericOffset + envelope.event.text.length;
}

async function publishFinalSnapshot(
  input: Readonly<{ threadId: string; runId: string; html: string }>,
): Promise<AgentRunEventEnvelope> {
  const timestamp = new Date().toISOString();
  const eventId = uuidv5(
    `ui-lab-final-snapshot:${input.runId}`,
    uuidv5.URL,
  );
  const envelope: AgentRunEventEnvelope = {
    eventId,
    threadId: input.threadId,
    runId: input.runId,
    sourceInstance: `ui-lab-final-snapshot:${input.runId}`,
    sequence: 1,
    timestamp,
    type: 'token',
    phase: 'completion',
    status: 'completed',
    event: {
      type: 'token',
      text: input.html,
      streamOffset: 0,
      streamSnapshot: true,
      runId: input.runId,
      eventTimestamp: timestamp,
    },
  };
  await notifyRunEvent(envelope, { persist: true });
  return envelope;
}

async function replayAllPages(input: {
  replay: ReplayRunEvents;
  threadId: string;
  afterEventId?: string;
  runId?: string;
  onPage: (events: AgentRunEventEnvelope[]) => Promise<void>;
}): Promise<void> {
  let cursor = input.afterEventId;
  for (;;) {
    const page = await input.replay(
      input.threadId,
      cursor,
      REPLAY_PAGE_SIZE,
      input.runId,
      'oldest',
    );
    if (page.length === 0) return;
    await input.onPage(page);
    const nextCursor = page[page.length - 1]?.eventId;
    if (!nextCursor || nextCursor === cursor || page.length < REPLAY_PAGE_SIZE) {
      return;
    }
    cursor = nextCursor;
  }
}

export const observeUiLabV2Run: ObserveUiLabV2Run = async (
  input,
  dependencies = {},
) => {
  const replay = dependencies.replayRunEvents ?? replayDurableRunEvents;
  const subscribe = dependencies.subscribeRunEvents ?? subscribeToRunEvents;
  const loadEvent = dependencies.loadRunEvent ?? loadDurableRunEvent;
  const harvest = dependencies.harvestRun ?? harvestUiLabV2Run;
  const publishSnapshot =
    dependencies.publishFinalSnapshot ?? publishFinalSnapshot;

  const seenEventIds = new Set<string>();
  const pendingDeltas = new Map<number, PendingDelta>();
  let nextOffset: number | null = 0;
  let terminalSeen = false;
  let replaying = true;
  const pendingLive: AgentRunEventEnvelope[] = [];
  let processing: Promise<void> = Promise.resolve();
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  if (input.afterEventId) {
    const cursor = await loadEvent(input.afterEventId, input.threadId);
    nextOffset = cursor ? tokenEndOffset(cursor) : null;
  }

  const flushDeltas = (): void => {
    while (nextOffset !== null) {
      const delta = pendingDeltas.get(nextOffset);
      if (!delta) return;
      pendingDeltas.delete(nextOffset);
      const currentOffset = nextOffset;
      if (delta.text) {
        input.onToken(delta.text, delta.eventId);
      }
      nextOffset = Math.max(currentOffset + delta.text.length, delta.endOffset);
    }
  };

  const acceptDelta = (envelope: AgentRunEventEnvelope): void => {
    if (envelope.event.type !== 'token') return;
    if (envelope.event.streamSnapshot) {
      input.onToken(envelope.event.text, envelope.eventId, 'replace');
      nextOffset = null;
      pendingDeltas.clear();
      return;
    }
    const offset = envelope.event.streamOffset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) return;
    const endOffset = tokenEndOffset(envelope);
    if (endOffset === null) return;
    const numericOffset = offset as number;
    if (nextOffset === null) nextOffset = numericOffset;
    if (numericOffset < nextOffset || pendingDeltas.has(numericOffset)) return;
    pendingDeltas.set(numericOffset, {
      text: envelope.event.text,
      eventId: envelope.eventId,
      endOffset,
    });
    flushDeltas();
  };

  const finish = async (envelope: AgentRunEventEnvelope): Promise<void> => {
    if (terminalSeen) return;
    terminalSeen = true;
    const result = await harvest({
      designId: input.designId,
      runId: input.runId,
      generationStartedAt: input.generationStartedAt,
    });
    if (result.status === 'pending') {
      throw new Error('UI Lab generation finished before its artifacts were available');
    }
    if (result.status === 'superseded') {
      throw new Error('UI Lab generation was superseded by a newer attempt');
    }
    if (result.status === 'settled' && result.outcome === 'failed') {
      throw new Error(result.error);
    }
    if (envelope.status === 'failed' || envelope.status === 'cancelled') {
      throw new Error(
        envelope.detail
        ?? `UI Lab generation ${envelope.status}`,
      );
    }
    if (result.status === 'settled' && result.outcome === 'ready') {
      const snapshot = await publishSnapshot({
        threadId: input.threadId,
        runId: input.runId,
        html: result.html,
      });
      seenEventIds.add(snapshot.eventId);
      acceptDelta(snapshot);
    }
    resolveCompletion();
  };

  const handle = async (envelope: AgentRunEventEnvelope): Promise<void> => {
    if (
      envelope.runId !== input.runId
      || envelope.threadId !== input.threadId
      || seenEventIds.has(envelope.eventId)
    ) {
      return;
    }
    seenEventIds.add(envelope.eventId);
    if (envelope.event.type === 'token') {
      acceptDelta(envelope);
      return;
    }
    if (envelope.event.type === 'done') {
      await finish(envelope);
    }
  };

  const enqueue = (envelope: AgentRunEventEnvelope): void => {
    processing = processing
      .then(() => handle(envelope))
      .catch((error) => {
        rejectCompletion(error instanceof Error ? error : new Error(String(error)));
      });
  };

  const unsubscribe = subscribe(input.threadId, (envelope) => {
    if (replaying) pendingLive.push(envelope);
    else enqueue(envelope);
  });

  try {
    await replayAllPages({
      replay,
      threadId: input.threadId,
      afterEventId: input.afterEventId,
      runId: input.runId,
      onPage: async (events) => {
        for (const envelope of events) await handle(envelope);
      },
    });
    replaying = false;
    for (const envelope of pendingLive) enqueue(envelope);
    await completion;
    await processing;
  } finally {
    unsubscribe();
  }
};

export async function replayCompletedUiLabV2Run(
  input: Readonly<{
    threadId: string;
    runId: string;
    afterEventId: string;
    finalHtml: string;
    onToken: (
      text: string,
      eventId?: string,
      mode?: 'append' | 'replace',
    ) => void;
  }>,
  dependencies: Readonly<{
    replayRunEvents?: ReplayRunEvents;
    loadRunEvent?: LoadRunEvent;
    publishFinalSnapshot?: (input: Readonly<{
      threadId: string;
      runId: string;
      html: string;
    }>) => Promise<AgentRunEventEnvelope>;
  }> = {},
): Promise<void> {
  const replay = dependencies.replayRunEvents ?? replayDurableRunEvents;
  const loadEvent = dependencies.loadRunEvent ?? loadDurableRunEvent;
  const publishSnapshot =
    dependencies.publishFinalSnapshot ?? publishFinalSnapshot;
  const cursor = await loadEvent(input.afterEventId, input.threadId);
  const runId = input.runId;
  let nextOffset = cursor ? tokenEndOffset(cursor) : null;
  let sawSnapshot =
    cursor?.event.type === 'token' && Boolean(cursor.event.streamSnapshot);
  const seen = new Set<string>();

  const accept = (envelope: AgentRunEventEnvelope): void => {
    if (
      (runId && envelope.runId !== runId)
      || seen.has(envelope.eventId)
      || envelope.event.type !== 'token'
    ) {
      return;
    }
    seen.add(envelope.eventId);
    if (envelope.event.streamSnapshot) {
      sawSnapshot = true;
      input.onToken(envelope.event.text, envelope.eventId, 'replace');
      nextOffset = null;
      return;
    }
    const offset = envelope.event.streamOffset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) return;
    const endOffset = tokenEndOffset(envelope);
    if (endOffset === null) return;
    if (nextOffset === null) nextOffset = offset as number;
    if (offset !== nextOffset) return;
    if (envelope.event.text) {
      input.onToken(envelope.event.text, envelope.eventId);
    }
    nextOffset = Math.max(
      nextOffset + envelope.event.text.length,
      endOffset,
    );
  };

  await replayAllPages({
    replay,
    threadId: input.threadId,
    afterEventId: input.afterEventId,
    runId,
    onPage: async (events) => {
      for (const envelope of events) accept(envelope);
    },
  });
  if (!sawSnapshot) {
    accept(await publishSnapshot({
      threadId: input.threadId,
      runId,
      html: input.finalHtml,
    }));
  }
}
