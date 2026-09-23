import { createCheckpointPublisher } from '../../services/aiRunsV2Worker/checkpointPublisher';

describe('checkpointPublisher', () => {
  it('keeps one monotonic sequence while carrying generic text progress', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const publisher = createCheckpointPublisher({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
      },
      now: () => new Date('2026-09-22T12:00:00.000Z'),
      newEventId: (() => {
        let next = 0;
        return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
      })(),
      send: async (_messageId, body) => {
        sent.push(body as unknown as Record<string, unknown>);
      },
    });

    await publisher.publishStarted('execution-1');
    await publisher.publishProgress(
      'generation',
      'running',
      undefined,
      { kind: 'text_delta', offset: 0, text: '<html>' },
    );
    await publisher.publishHeartbeat();

    expect(sent.map((checkpoint) => checkpoint.checkpointSequence)).toEqual([
      1,
      2,
      3,
    ]);
    expect(sent[1]).toMatchObject({
      kind: 'progress',
      progress: { kind: 'text_delta', offset: 0, text: '<html>' },
    });
  });

  it('serializes concurrent heartbeat and progress sends in sequence order', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: number[] = [];
    const send = jest.fn(async (_messageId, body) => {
      sent.push(body.checkpointSequence);
      if (body.checkpointSequence === 1) await firstPending;
    });
    const publisher = createCheckpointPublisher({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
      },
      send,
    });

    const progress = publisher.publishProgress('generation', 'running');
    const heartbeat = publisher.publishHeartbeat();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([progress, heartbeat]);
    expect(sent).toEqual([1, 2]);
  });
});
