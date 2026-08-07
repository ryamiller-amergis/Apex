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
