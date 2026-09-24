/**
 * Durable interactive stream batcher — 250 ms / 16 KiB offset chunks.
 */
import {
  INTERACTIVE_DURABLE_STREAM_INTERVAL_MS,
  INTERACTIVE_DURABLE_STREAM_MAX_BYTES,
  createInteractiveDurableStreamBatcher,
} from '../services/interactiveDurableStreamBatcher';

describe('createInteractiveDurableStreamBatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not persist four pushes inside 249 ms', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: () => 'event-1',
    });

    await batcher.push('a');
    await batcher.push('b');
    await batcher.push('c');
    await batcher.push('d');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS - 1);

    expect(persist).not.toHaveBeenCalled();
  });

  it('writes one event on the 250 ms tick', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: () => 'event-1',
    });

    await batcher.push('hello');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);

    expect(persist).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'token',
          text: 'hello',
          streamOffset: 0,
          streamEndOffset: 5,
        }),
      }),
    );
    expect(batcher.nextOffset).toBe(5);
  });

  it('does not write a second event before the next 250 ms tick', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: (() => {
        let n = 0;
        return () => `event-${++n}`;
      })(),
    });

    await batcher.push('hello');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    expect(persist).toHaveBeenCalledTimes(1);

    await batcher.push(' world');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS - 1);
    expect(persist).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: expect.objectContaining({
          text: ' world',
          streamOffset: 5,
          streamEndOffset: 11,
        }),
      }),
    );
  });

  it('caps each UTF-8 payload at 16 KiB without splitting a code point', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: (() => {
        let n = 0;
        return () => `event-${++n}`;
      })(),
    });

    // U+1F600 is 4 UTF-8 bytes and one JS code point (length 2 as UTF-16).
    const emoji = '😀';
    const emojiBytes = new TextEncoder().encode(emoji).byteLength;
    const count = Math.floor(INTERACTIVE_DURABLE_STREAM_MAX_BYTES / emojiBytes) + 2;
    await batcher.push(emoji.repeat(count));

    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    expect(persist).toHaveBeenCalledTimes(1);
    const first = persist.mock.calls[0][0] as {
      event: { text: string };
    };
    expect(new TextEncoder().encode(first.event.text).byteLength).toBeLessThanOrEqual(
      INTERACTIVE_DURABLE_STREAM_MAX_BYTES,
    );
    expect([...first.event.text].every((ch) => ch === emoji)).toBe(true);

    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    expect(persist).toHaveBeenCalledTimes(2);
    const second = persist.mock.calls[1][0] as {
      event: { text: string; streamOffset: number };
    };
    expect(second.event.streamOffset).toBe(first.event.text.length);
  });

  it('keeps offsets contiguous across chunks', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: (() => {
        let n = 0;
        return () => `event-${++n}`;
      })(),
    });

    await batcher.push('abc');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    await batcher.push('def');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);

    expect(persist.mock.calls.map((call) => call[0].event)).toEqual([
      expect.objectContaining({
        text: 'abc',
        streamOffset: 0,
        streamEndOffset: 3,
      }),
      expect.objectContaining({
        text: 'def',
        streamOffset: 3,
        streamEndOffset: 6,
      }),
    ]);
  });

  it('flush drains multiple chunks at 250 ms spacing', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: (() => {
        let n = 0;
        return () => `event-${++n}`;
      })(),
    });

    const filler = 'x'.repeat(INTERACTIVE_DURABLE_STREAM_MAX_BYTES);
    await batcher.push(filler + filler + 'tail');

    const flushPromise = batcher.flush();
    // First chunk emits immediately on flush.
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    expect(persist).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    expect(persist).toHaveBeenCalledTimes(3);

    await flushPromise;
    expect(persist.mock.calls.map((call) => call[0].event.text.length)).toEqual([
      INTERACTIVE_DURABLE_STREAM_MAX_BYTES,
      INTERACTIVE_DURABLE_STREAM_MAX_BYTES,
      4,
    ]);
    expect(batcher.nextOffset).toBe(INTERACTIVE_DURABLE_STREAM_MAX_BYTES * 2 + 4);
  });

  it('does not advance offset or drop text when persist fails on flush', async () => {
    const persist = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(undefined);
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: () => 'event-1',
    });

    await batcher.push('hello');
    await expect(batcher.flush()).rejects.toThrow('db down');
    expect(batcher.nextOffset).toBe(0);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].event).toEqual(
      expect.objectContaining({
        text: 'hello',
        streamOffset: 0,
        streamEndOffset: 5,
      }),
    );

    // A fresh chain after the failed flush must still drain the same text
    // without creating an offset hole.
    await batcher.flush();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1][0].event).toEqual(
      expect.objectContaining({
        text: 'hello',
        streamOffset: 0,
        streamEndOffset: 5,
      }),
    );
    expect(batcher.nextOffset).toBe(5);
  });

  it('keeps timer persist failures on the write chain so flush rejects', async () => {
    const persist = jest.fn().mockRejectedValue(new Error('db down'));
    const batcher = createInteractiveDurableStreamBatcher({
      persist,
      createEventId: () => 'event-1',
    });

    await batcher.push('hello');
    await jest.advanceTimersByTimeAsync(INTERACTIVE_DURABLE_STREAM_INTERVAL_MS);
    await expect(batcher.flush()).rejects.toThrow('db down');
    expect(batcher.nextOffset).toBe(0);
    expect(persist).toHaveBeenCalled();
    expect(
      persist.mock.calls.every(
        (call) =>
          call[0].event.streamOffset === 0 && call[0].event.text === 'hello',
      ),
    ).toBe(true);
  });
});
