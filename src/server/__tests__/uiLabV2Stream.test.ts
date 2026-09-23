import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import { observeUiLabV2Run } from '../services/uiLabV2Stream';

function token(
  eventId: string,
  sequence: number,
  offset: number,
  text: string,
): AgentRunEventEnvelope {
  return {
    eventId,
    threadId: 'ui-lab:design-1',
    runId: 'run-1',
    sourceInstance: 'ai-run-v2:attempt-1',
    sequence,
    timestamp: `2026-09-22T12:00:0${sequence}.000Z`,
    type: 'token',
    phase: 'implementation',
    status: 'running',
    event: {
      type: 'token',
      text,
      streamOffset: offset,
    },
  };
}

function done(): AgentRunEventEnvelope {
  return {
    eventId: '00000000-0000-4000-8000-000000000003',
    threadId: 'ui-lab:design-1',
    runId: 'run-1',
    sourceInstance: 'orchestrator',
    sequence: 3,
    timestamp: '2026-09-22T12:00:03.000Z',
    type: 'done',
    phase: 'completion',
    status: 'completed',
    event: { type: 'done', runId: 'run-1' },
  };
}

const INPUT = {
  designId: 'design-1',
  runId: 'run-1',
  threadId: 'ui-lab:design-1',
  generationStartedAt: '2026-09-22T12:00:00.000Z',
};

describe('observeUiLabV2Run', () => {
  it('replays durable deltas and harvests immediately on terminal success', async () => {
    const onToken = jest.fn();
    const harvestRun = jest.fn().mockResolvedValue({
      status: 'settled',
      outcome: 'ready',
      html: '<html>ok</html>',
    });

    await observeUiLabV2Run(
      { ...INPUT, onToken },
      {
        replayRunEvents: jest.fn().mockResolvedValue([
          token('00000000-0000-4000-8000-000000000001', 1, 0, '<html>'),
          token('00000000-0000-4000-8000-000000000002', 2, 6, 'ok</html>'),
          done(),
        ]),
        subscribeRunEvents: jest.fn(() => () => undefined),
        harvestRun,
      },
    );

    expect(onToken.mock.calls).toEqual([
      ['<html>', '00000000-0000-4000-8000-000000000001'],
      ['ok</html>', '00000000-0000-4000-8000-000000000002'],
    ]);
    expect(harvestRun).toHaveBeenCalledWith({
      designId: 'design-1',
      runId: 'run-1',
      generationStartedAt: INPUT.generationStartedAt,
    });
  });

  it('deduplicates and orders live deltas by stream offset', async () => {
    const onToken = jest.fn();
    let live: ((event: AgentRunEventEnvelope) => void) | undefined;
    const observing = observeUiLabV2Run(
      { ...INPUT, onToken },
      {
        replayRunEvents: jest.fn().mockResolvedValue([]),
        subscribeRunEvents: jest.fn((_threadId, callback) => {
          live = callback;
          return () => undefined;
        }),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: '<html>ok</html>',
        }),
      },
    );
    await Promise.resolve();

    const second = token(
      '00000000-0000-4000-8000-000000000002',
      2,
      6,
      'ok</html>',
    );
    live?.(second);
    live?.(second);
    live?.(token(
      '00000000-0000-4000-8000-000000000001',
      1,
      0,
      '<html>',
    ));
    live?.(done());
    await observing;

    expect(onToken.mock.calls.map(([text]) => text)).toEqual([
      '<html>',
      'ok</html>',
    ]);
  });

  it('resumes after Last-Event-ID without waiting for offset zero', async () => {
    const onToken = jest.fn();
    const afterEventId = '00000000-0000-4000-8000-000000000001';

    await observeUiLabV2Run(
      { ...INPUT, onToken, afterEventId },
      {
        replayRunEvents: jest.fn().mockResolvedValue([
          token('00000000-0000-4000-8000-000000000002', 2, 6, 'ok</html>'),
          done(),
        ]),
        subscribeRunEvents: jest.fn(() => () => undefined),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: '<html>ok</html>',
        }),
      },
    );

    expect(onToken).toHaveBeenCalledWith(
      'ok</html>',
      '00000000-0000-4000-8000-000000000002',
    );
  });
});
