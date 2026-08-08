/**
 * FEAT-007 / TBI-011 — interactive token batching.
 *
 * Live actor→client fan-out rides the durable `agent_run_events` spine, whose
 * PostgreSQL `NOTIFY` payload is bounded (~8 KB). Batched token events must be
 * coalesced so each serialized envelope stays within that limit (BR-016). The
 * batcher never splits a UTF-8 multi-byte sequence across chunk boundaries.
 */

/**
 * Conservative byte budget for the token text carried in a single NOTIFY
 * envelope. Kept below the ~8000-byte PG limit (matches
 * pgNotifyService.PAYLOAD_MAX_BYTES) to leave room for envelope metadata.
 */
export const INTERACTIVE_TOKEN_BATCH_MAX_BYTES = 6_000;

/** Split a string so each chunk's UTF-8 byte length is <= maxBytes. */
export function chunkByBytes(value: string, maxBytes: number): string[] {
  if (maxBytes <= 0) return value ? [value] : [];
  if (Buffer.byteLength(value) <= maxBytes) return value ? [value] : [];

  const chunks: string[] = [];
  let current = '';
  for (const char of value) {
    // Iterating by code point keeps surrogate pairs / combining sequences whole.
    if (Buffer.byteLength(current + char) > maxBytes) {
      if (current) chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Coalesce an ordered token stream into the fewest batches whose serialized
 * text each fits within `maxBytes`, preserving order. An individual token that
 * alone exceeds the budget is safely chunked by bytes.
 */
export function batchTokensForNotify(
  tokens: readonly string[],
  maxBytes: number = INTERACTIVE_TOKEN_BATCH_MAX_BYTES,
): string[] {
  const batches: string[] = [];
  let current = '';

  for (const token of tokens) {
    if (!token) continue;
    for (const chunk of chunkByBytes(token, maxBytes)) {
      if (current && Buffer.byteLength(current + chunk) > maxBytes) {
        batches.push(current);
        current = '';
      }
      current += chunk;
    }
  }

  if (current) batches.push(current);
  return batches;
}

/**
 * Redis live-path flush thresholds. The live fan-out has no ~8 KB `NOTIFY` cap,
 * so tokens are flushed incrementally for a real-time feel: whichever of a small
 * byte budget or a short time window comes first. The hard {@link
 * INTERACTIVE_TOKEN_BATCH_MAX_BYTES} cap is still respected so a single batch
 * never grows unbounded.
 */
export const INTERACTIVE_LIVE_FLUSH_BYTES = 256;
export const INTERACTIVE_LIVE_FLUSH_MS = 60;

export interface IncrementalTokenBatcher {
  /** Buffer a token; returns any batch(es) ready to flush now (ordered). */
  push(token: string, nowMs?: number): string[];
  /** Drain the buffered tail (turn end / idle-timer flush). */
  flush(): string | null;
  /** True when a time-based flush is due — for an idle timer tick with no new token. */
  dueForFlush(nowMs: number): boolean;
}

export interface IncrementalTokenBatcherOptions {
  /** Emit once the buffer reaches this many bytes (default 256). */
  flushBytes?: number;
  /** Emit a trickle of small tokens after this many ms (default 60). */
  flushIntervalMs?: number;
  /** Hard per-batch byte cap (default {@link INTERACTIVE_TOKEN_BATCH_MAX_BYTES}). */
  maxBytes?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Stateful incremental batcher for the Redis live path. Flushes on the earlier
 * of a small byte budget or a short time window so tokens stream smoothly, while
 * never emitting a batch larger than `maxBytes` and never splitting a UTF-8
 * sequence across a boundary.
 */
export function createIncrementalTokenBatcher(
  options: IncrementalTokenBatcherOptions = {},
): IncrementalTokenBatcher {
  const flushBytes = options.flushBytes ?? INTERACTIVE_LIVE_FLUSH_BYTES;
  const flushIntervalMs = options.flushIntervalMs ?? INTERACTIVE_LIVE_FLUSH_MS;
  const maxBytes = options.maxBytes ?? INTERACTIVE_TOKEN_BATCH_MAX_BYTES;
  const now = options.now ?? Date.now;

  let current = '';
  let lastEmitAt: number | null = null;

  const emit = (batches: string[], at: number): void => {
    if (!current) return;
    batches.push(current);
    current = '';
    lastEmitAt = at;
  };

  return {
    push(token: string, nowMs: number = now()): string[] {
      if (!token) return [];
      if (lastEmitAt === null) lastEmitAt = nowMs;
      const batches: string[] = [];
      for (const chunk of chunkByBytes(token, maxBytes)) {
        // Respect the hard cap before appending the next chunk.
        if (current && Buffer.byteLength(current + chunk) > maxBytes) {
          emit(batches, nowMs);
        }
        current += chunk;
        // Size-based incremental flush.
        if (Buffer.byteLength(current) >= flushBytes) {
          emit(batches, nowMs);
        }
      }
      // Time-based flush for a trickle of small tokens.
      if (current && lastEmitAt !== null && nowMs - lastEmitAt >= flushIntervalMs) {
        emit(batches, nowMs);
      }
      return batches;
    },
    flush(): string | null {
      if (!current) return null;
      const tail = current;
      current = '';
      lastEmitAt = now();
      return tail;
    },
    dueForFlush(nowMs: number): boolean {
      return (
        Boolean(current)
        && lastEmitAt !== null
        && nowMs - lastEmitAt >= flushIntervalMs
      );
    },
  };
}

/**
 * Stateful batcher for a live stream: `push` returns any completed batches that
 * must be flushed before the new token; `flush` drains the tail at turn end.
 */
export function createInteractiveTokenBatcher(
  maxBytes: number = INTERACTIVE_TOKEN_BATCH_MAX_BYTES,
): {
  push(token: string): string[];
  flush(): string | null;
} {
  let current = '';

  return {
    push(token: string): string[] {
      if (!token) return [];
      const completed: string[] = [];
      for (const chunk of chunkByBytes(token, maxBytes)) {
        if (current && Buffer.byteLength(current + chunk) > maxBytes) {
          completed.push(current);
          current = '';
        }
        current += chunk;
      }
      return completed;
    },
    flush(): string | null {
      if (!current) return null;
      const tail = current;
      current = '';
      return tail;
    },
  };
}
