import { AI_RUN_V2_MAX_PROGRESS_TEXT_BYTES } from '../../../shared/types/aiRunV2';

export const STREAM_PROGRESS_INTERVAL_MS = 250;

type Timer = ReturnType<typeof setTimeout>;

export type StreamProgressBatcher = Readonly<{
  push(text: string): void;
  close(): Promise<void>;
}>;

export type StreamProgressBatcherOptions = Readonly<{
  publish(text: string, offset: number): Promise<void>;
  maxMessageBytes?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  schedule?: (callback: () => void, ms: number) => Timer;
  clearSchedule?: (timer: Timer) => void;
}>;

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let prefix = '';
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + nextBytes > maxBytes) break;
    prefix += character;
    bytes += nextBytes;
  }
  return prefix;
}

export function createStreamProgressBatcher(
  options: StreamProgressBatcherOptions,
): StreamProgressBatcher {
  const maxBytes =
    options.maxMessageBytes ?? AI_RUN_V2_MAX_PROGRESS_TEXT_BYTES;
  const intervalMs = options.intervalMs ?? STREAM_PROGRESS_INTERVAL_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('Stream progress maxMessageBytes must be at least 4');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error('Stream progress intervalMs must be positive');
  }

  const now = options.now ?? Date.now;
  const sleep =
    options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const schedule = options.schedule ?? setTimeout;
  const clearSchedule = options.clearSchedule ?? clearTimeout;

  let pending = '';
  let nextOffset = 0;
  let lastPublishedAt = now();
  let timer: Timer | null = null;
  let publishing: Promise<void> = Promise.resolve();
  let publishFailure: unknown;
  let closed = false;

  const waitForCadence = async (): Promise<void> => {
    const remaining = intervalMs - (now() - lastPublishedAt);
    if (remaining > 0) await sleep(remaining);
  };

  const flushOne = async (): Promise<void> => {
    if (publishFailure) throw publishFailure;
    if (!pending) return;
    const chunk = takeUtf8Prefix(pending, maxBytes);
    if (!chunk) {
      throw new Error('Stream progress message cannot fit one character');
    }
    await options.publish(chunk, nextOffset);
    pending = pending.slice(chunk.length);
    nextOffset += chunk.length;
    lastPublishedAt = now();
  };

  const scheduleNext = (): void => {
    if (closed || timer || !pending || publishFailure) return;
    const delay = Math.max(0, intervalMs - (now() - lastPublishedAt));
    timer = schedule(() => {
      timer = null;
      publishing = publishing
        .then(flushOne)
        .catch((error) => {
          publishFailure = error;
        })
        .then(() => {
          scheduleNext();
        });
    }, delay);
  };

  return {
    push(text) {
      if (closed) throw new Error('Stream progress batcher is closed');
      if (!text) return;
      pending += text;
      scheduleNext();
    },

    async close() {
      if (closed) {
        await publishing;
        if (publishFailure) throw publishFailure;
        return;
      }
      closed = true;
      if (timer) {
        clearSchedule(timer);
        timer = null;
      }
      await publishing;
      if (publishFailure) throw publishFailure;
      while (pending) {
        await waitForCadence();
        await flushOne();
      }
    },
  };
}
