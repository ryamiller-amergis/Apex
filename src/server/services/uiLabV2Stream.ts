import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  replayRunEvents as replayDurableRunEvents,
  subscribeRunEvents as subscribeToRunEvents,
} from './pgNotifyService';
import {
  harvestUiLabV2Run,
  type UiLabRunHarvestResult,
} from './uiLabV2Harvest';

type ReplayRunEvents = typeof replayDurableRunEvents;
type SubscribeRunEvents = typeof subscribeToRunEvents;

export type ObserveUiLabV2RunInput = Readonly<{
  designId: string;
  runId: string;
  threadId: string;
  generationStartedAt: string;
  onToken: (text: string, eventId?: string) => void;
  afterEventId?: string;
}>;

export type ObserveUiLabV2RunDependencies = Readonly<{
  replayRunEvents?: ReplayRunEvents;
  subscribeRunEvents?: SubscribeRunEvents;
  harvestRun?: (
    input: Readonly<{
      designId: string;
      runId: string;
      generationStartedAt: string;
    }>,
  ) => Promise<UiLabRunHarvestResult>;
}>;

export type ObserveUiLabV2Run = (
  input: ObserveUiLabV2RunInput,
  dependencies?: ObserveUiLabV2RunDependencies,
) => Promise<void>;

type PendingDelta = Readonly<{
  text: string;
  eventId: string;
}>;

export const observeUiLabV2Run: ObserveUiLabV2Run = async (
  input,
  dependencies = {},
) => {
  const replay = dependencies.replayRunEvents ?? replayDurableRunEvents;
  const subscribe = dependencies.subscribeRunEvents ?? subscribeToRunEvents;
  const harvest = dependencies.harvestRun ?? harvestUiLabV2Run;

  const seenEventIds = new Set<string>();
  const pendingDeltas = new Map<number, PendingDelta>();
  let nextOffset: number | null = input.afterEventId ? null : 0;
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

  const flushDeltas = (): void => {
    while (nextOffset !== null) {
      const delta = pendingDeltas.get(nextOffset);
      if (!delta) return;
      pendingDeltas.delete(nextOffset);
      input.onToken(delta.text, delta.eventId);
      nextOffset += delta.text.length;
    }
  };

  const acceptDelta = (envelope: AgentRunEventEnvelope): void => {
    if (envelope.event.type !== 'token') return;
    const offset = envelope.event.streamOffset;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0) return;
    const numericOffset = offset as number;
    if (nextOffset === null) nextOffset = numericOffset;
    if (numericOffset < nextOffset || pendingDeltas.has(numericOffset)) return;
    pendingDeltas.set(numericOffset, {
      text: envelope.event.text,
      eventId: envelope.eventId,
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
      const offset = nextOffset ?? 0;
      const finalSuffix = result.html.slice(offset);
      if (finalSuffix) {
        // This suffix comes from the verified artifact, not a durable progress
        // event. Keeping the SSE id unchanged lets a reconnect replay `done`.
        input.onToken(finalSuffix);
        nextOffset = result.html.length;
      }
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
    const durable = await replay(
      input.threadId,
      input.afterEventId,
      500,
      input.runId,
    );
    for (const envelope of durable) {
      await handle(envelope);
    }
    replaying = false;
    for (const envelope of pendingLive) enqueue(envelope);
    await completion;
    await processing;
  } finally {
    unsubscribe();
  }
};
