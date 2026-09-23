/**
 * Durable interactive stream batcher.
 *
 * Persists at most one PostgreSQL-backed token event per 250 ms per run, with at
 * most 16 KiB UTF-8 text per event. Oversize buffers drain at the same cadence.
 * Offsets are contiguous JavaScript string indices; chunking never splits a
 * Unicode code point.
 */
import { randomUUID } from 'crypto';

export const INTERACTIVE_DURABLE_STREAM_INTERVAL_MS = 250;
export const INTERACTIVE_DURABLE_STREAM_MAX_BYTES = 16 * 1024;

export type DurableStreamTokenEvent = Readonly<{
  type: 'token';
  text: string;
  streamOffset: number;
  streamEndOffset: number;
}>;

export type DurableStreamPersistInput = Readonly<{
  event: DurableStreamTokenEvent;
  eventId: string;
}>;

export interface InteractiveDurableStreamBatcher {
  push(text: string): Promise<void>;
  flush(): Promise<void>;
  readonly nextOffset: number;
}

export interface InteractiveDurableStreamBatcherOptions {
  persist: (input: DurableStreamPersistInput) => Promise<void>;
  createEventId?: () => string;
  maxBytes?: number;
  intervalMs?: number;
  now?: () => number;
}

const textEncoder = new TextEncoder();

/** Take the longest UTF-8-safe prefix whose encoded size is <= maxBytes. */
export function takeUtf8Prefix(
  value: string,
  maxBytes: number,
): { chunk: string; rest: string } {
  if (!value) return { chunk: '', rest: '' };
  if (maxBytes <= 0) return { chunk: '', rest: value };
  if (textEncoder.encode(value).byteLength <= maxBytes) {
    return { chunk: value, rest: '' };
  }

  let chunk = '';
  for (const char of value) {
    const next = chunk + char;
    if (textEncoder.encode(next).byteLength > maxBytes) break;
    chunk = next;
  }
  return { chunk, rest: value.slice(chunk.length) };
}

/** Offset-aware token payload shared by Redis live fan-out and durable batches. */
export function buildOffsetLiveTokenEvent(input: {
  text: string;
  streamOffset: number;
  streamEndOffset: number;
}): DurableStreamTokenEvent {
  return {
    type: 'token',
    text: input.text,
    streamOffset: input.streamOffset,
    streamEndOffset: input.streamEndOffset,
  };
}

export function createInteractiveDurableStreamBatcher(
  options: InteractiveDurableStreamBatcherOptions,
): InteractiveDurableStreamBatcher {
  const persist = options.persist;
  const createEventId = options.createEventId ?? (() => randomUUID());
  const maxBytes = options.maxBytes ?? INTERACTIVE_DURABLE_STREAM_MAX_BYTES;
  const intervalMs = options.intervalMs ?? INTERACTIVE_DURABLE_STREAM_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let buffer = '';
  let nextOffset = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteAt: number | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let closed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const emitOneChunk = async (): Promise<boolean> => {
    if (!buffer) return false;
    const { chunk, rest } = takeUtf8Prefix(buffer, maxBytes);
    if (!chunk) return false;
    buffer = rest;
    const streamOffset = nextOffset;
    const streamEndOffset = streamOffset + chunk.length;
    nextOffset = streamEndOffset;
    const eventId = createEventId();
    lastWriteAt = now();
    await persist({
      eventId,
      event: {
        type: 'token',
        text: chunk,
        streamOffset,
        streamEndOffset,
      },
    });
    return true;
  };

  const scheduleTick = (): void => {
    if (closed || timer !== null || !buffer) return;
    const delay =
      lastWriteAt === null
        ? intervalMs
        : Math.max(0, intervalMs - (now() - lastWriteAt));
    timer = setTimeout(() => {
      timer = null;
      writeChain = writeChain
        .then(async () => {
          const wrote = await emitOneChunk();
          if (wrote && buffer) scheduleTick();
        })
        .catch(() => {
          // Persist failures propagate to callers awaiting push/flush chains.
        });
    }, delay);
  };

  return {
    get nextOffset() {
      return nextOffset;
    },

    async push(text: string): Promise<void> {
      if (closed || !text) return;
      buffer += text;
      scheduleTick();
      await writeChain;
    },

    async flush(): Promise<void> {
      clearTimer();
      const drain = async (): Promise<void> => {
        while (buffer) {
          const sinceLast =
            lastWriteAt === null ? intervalMs : now() - lastWriteAt;
          if (sinceLast < intervalMs && lastWriteAt !== null) {
            const waitMs = intervalMs - sinceLast;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, waitMs);
            });
          }
          const wrote = await emitOneChunk();
          if (!wrote) break;
        }
      };
      writeChain = writeChain.then(drain);
      await writeChain;
    },
  };
}
