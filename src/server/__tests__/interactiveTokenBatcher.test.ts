import {
  batchTokensForNotify,
  chunkByBytes,
  createIncrementalTokenBatcher,
  createInteractiveTokenBatcher,
  INTERACTIVE_LIVE_FLUSH_BYTES,
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

describe('incremental token batcher (Redis live path)', () => {
  it('flushes on the byte budget without waiting for a timer', () => {
    const batcher = createIncrementalTokenBatcher({
      flushBytes: 8,
      flushIntervalMs: 10_000,
      now: () => 0,
    });
    const emitted: string[] = [];
    for (const token of ['1234', '5678', '90']) emitted.push(...batcher.push(token));

    // '12345678' reached the 8-byte budget and flushed; '90' is still buffered.
    expect(emitted).toEqual(['12345678']);
    expect(batcher.flush()).toBe('90');
  });

  it('flushes a trickle of small tokens once the time window elapses', () => {
    const batcher = createIncrementalTokenBatcher({
      flushBytes: 1_000,
      flushIntervalMs: 60,
      now: () => 0,
    });

    expect(batcher.push('a', 0)).toEqual([]);
    expect(batcher.push('b', 20)).toEqual([]);
    // 60ms since first token → time-based flush emits the buffered trickle.
    expect(batcher.push('c', 60)).toEqual(['abc']);
    expect(batcher.flush()).toBeNull();
  });

  it('never emits a batch larger than the hard maxBytes cap', () => {
    const batcher = createIncrementalTokenBatcher({
      flushBytes: 10_000,
      flushIntervalMs: 10_000,
      maxBytes: 6_000,
      now: () => 0,
    });
    const emitted: string[] = [];
    for (let i = 0; i < 50; i += 1) emitted.push(...batcher.push('x'.repeat(200)));
    const tail = batcher.flush();
    if (tail) emitted.push(tail);

    for (const batch of emitted) {
      expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(6_000);
    }
    expect(emitted.join('')).toBe('x'.repeat(10_000));
  });

  it('preserves order and loses no content across mixed flushes', () => {
    let clock = 0;
    const batcher = createIncrementalTokenBatcher({
      flushBytes: INTERACTIVE_LIVE_FLUSH_BYTES,
      flushIntervalMs: 60,
      now: () => clock,
    });
    const emitted: string[] = [];
    const tokens = ['hello ', 'world ', 'x'.repeat(300), ' tail'];
    for (const token of tokens) {
      clock += 10;
      emitted.push(...batcher.push(token, clock));
    }
    const tail = batcher.flush();
    if (tail) emitted.push(tail);
    expect(emitted.join('')).toBe(tokens.join(''));
  });

  it('reports dueForFlush when a buffered trickle has aged past the window', () => {
    let clock = 0;
    const batcher = createIncrementalTokenBatcher({
      flushBytes: 1_000,
      flushIntervalMs: 60,
      now: () => clock,
    });
    batcher.push('a', 0);
    expect(batcher.dueForFlush(30)).toBe(false);
    expect(batcher.dueForFlush(60)).toBe(true);
    clock = 60;
    expect(batcher.flush()).toBe('a');
    expect(batcher.dueForFlush(200)).toBe(false);
  });
});
