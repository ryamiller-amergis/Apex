import { createCheckpointPublisher } from '../../services/aiRunsV2Worker/checkpointPublisher';
import {
  AI_RUN_V2_MAX_PROGRESS_TEXT_BYTES,
  isAiRunV2Checkpoint,
  type AiRunV2Checkpoint,
} from '../../../shared/types/aiRunV2';

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

  it('publishes a summarized Cursor event as durable activity progress', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const publisher = createCheckpointPublisher({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
      },
      send: async (_messageId, body) => {
        sent.push(body as unknown as Record<string, unknown>);
      },
    });

    await publisher.publishActivity?.({
      eventId: 'event-1',
      threadId: 'thread-1',
      runId: 'run-1',
      sourceInstance: 'worker',
      sequence: 1,
      timestamp: '2026-09-22T12:00:00.000Z',
      type: 'tool',
      phase: 'implementation',
      status: 'running',
      detail: 'grep_search started',
      event: {
        type: 'tool_call',
        toolName: 'grep_search',
        input: { target: 'TimecardController' },
      },
    });

    expect(sent[0]).toMatchObject({
      kind: 'progress',
      phase: 'implementation',
      status: 'running',
      progress: {
        kind: 'activity_event',
        eventType: 'tool',
        event: {
          type: 'tool_call',
          toolName: 'grep_search',
        },
      },
    });
  });

  it('truncates a long activity event so the consumer still accepts it', async () => {
    const sent: AiRunV2Checkpoint[] = [];
    const publisher = createCheckpointPublisher({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
      },
      send: async (_messageId, body) => {
        sent.push(body);
      },
    });

    await publisher.publishActivity?.({
      eventId: 'event-1',
      threadId: 'thread-1',
      runId: 'run-1',
      sourceInstance: 'worker',
      sequence: 1,
      timestamp: '2026-09-22T12:00:00.000Z',
      type: 'token',
      phase: 'implementation',
      status: 'running',
      event: {
        type: 'token',
        text: 'x'.repeat(AI_RUN_V2_MAX_PROGRESS_TEXT_BYTES * 2),
      } as never,
    });

    const progress = sent[0]?.kind === 'progress' ? sent[0].progress : undefined;
    expect(progress).toMatchObject({ kind: 'activity_event', eventType: 'token' });
    expect(isAiRunV2Checkpoint(sent[0])).toBe(true);
  });
});
