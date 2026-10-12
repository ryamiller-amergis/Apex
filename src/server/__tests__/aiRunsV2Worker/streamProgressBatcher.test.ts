import { createStreamProgressBatcher } from '../../services/aiRunsV2Worker/streamProgressBatcher';

describe('streamProgressBatcher', () => {
  it('batches deltas to no more than four publishes per second', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    try {
      const published: Array<{ text: string; offset: number; at: number }> = [];
      const batcher = createStreamProgressBatcher({
        publish: async (text, offset) => {
          published.push({ text, offset, at: Date.now() });
        },
      });

      batcher.push('<html>');
      batcher.push('<body>');
      await jest.advanceTimersByTimeAsync(249);
      expect(published).toEqual([]);

      await jest.advanceTimersByTimeAsync(1);
      expect(published).toEqual([
        { text: '<html><body>', offset: 0, at: 250 },
      ]);

      batcher.push('next');
      await jest.advanceTimersByTimeAsync(249);
      expect(published).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(published[1]).toEqual({ text: 'next', offset: 12, at: 500 });

      await batcher.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('splits oversized progress without losing order or offsets', async () => {
    let now = 0;
    const published: Array<{ text: string; offset: number; at: number }> = [];
    const batcher = createStreamProgressBatcher({
      maxMessageBytes: 5,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      schedule: () => ({}) as ReturnType<typeof setTimeout>,
      clearSchedule: () => undefined,
      publish: async (text, offset) => {
        published.push({ text, offset, at: now });
      },
    });

    batcher.push('abcdefghi');
    await batcher.close();

    expect(published).toEqual([
      { text: 'abcde', offset: 0, at: 250 },
      { text: 'fghi', offset: 5, at: 500 },
    ]);
  });

  it('keeps a multibyte character whole at the message boundary', async () => {
    let now = 0;
    const published: string[] = [];
    const batcher = createStreamProgressBatcher({
      maxMessageBytes: 4,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      schedule: () => ({}) as ReturnType<typeof setTimeout>,
      clearSchedule: () => undefined,
      publish: async (text) => {
        published.push(text);
      },
    });

    batcher.push('a🙂b');
    await batcher.close();

    expect(published).toEqual(['a', '🙂', 'b']);
  });
});
