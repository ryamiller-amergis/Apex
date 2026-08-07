import {
  batchTokensForNotify,
  chunkByBytes,
  createInteractiveTokenBatcher,
} from '../services/interactiveTokenBatcher';

describe('interactive token batching (TBI-011 / BR-016)', () => {
  it('coalesces small tokens into one batch under the byte budget', () => {
    const batches = batchTokensForNotify(['a', 'b', 'c'], 6_000);
    expect(batches).toEqual(['abc']);
  });

  it('BR-016: splits a long stream so every batch stays within the NOTIFY payload budget', () => {
    const tokens = Array.from({ length: 50 }, () => 'x'.repeat(200)); // ~10 KB
    const batches = batchTokensForNotify(tokens, 6_000);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(6_000);
    }
    expect(batches.join('')).toBe(tokens.join(''));
  });

  it('chunks a single oversized token by bytes without losing content', () => {
    const huge = 'y'.repeat(20_000);
    const batches = batchTokensForNotify([huge], 6_000);
    for (const batch of batches) {
      expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(6_000);
    }
    expect(batches.join('')).toBe(huge);
  });

  it('never splits a multi-byte UTF-8 sequence across chunk boundaries', () => {
    const emoji = '😀'; // 4 bytes each
    const chunks = chunkByBytes(emoji.repeat(10), 6);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(6);
      // A valid string round-trips without replacement characters.
      expect(chunk).not.toContain('\uFFFD');
    }
    expect(chunks.join('')).toBe(emoji.repeat(10));
  });

  it('stateful batcher flushes completed batches on push and drains the tail on flush', () => {
    const batcher = createInteractiveTokenBatcher(8);
    const emitted: string[] = [];
    for (const token of ['1234', '5678', '90']) {
      emitted.push(...batcher.push(token));
    }
    const tail = batcher.flush();
    if (tail) emitted.push(tail);

    for (const batch of emitted) {
      expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(8);
    }
    expect(emitted.join('')).toBe('1234567890');
    expect(batcher.flush()).toBeNull();
  });
});
