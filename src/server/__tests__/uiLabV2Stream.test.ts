import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  observeUiLabV2Run,
  replayCompletedUiLabV2Run,
} from '../services/uiLabV2Stream';

function token(
  eventId: string,
  sequence: number,
  offset: number,
  text: string,
  streamSnapshot = false,
  streamEndOffset?: number,
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
      ...(streamEndOffset === undefined ? {} : { streamEndOffset }),
      ...(streamSnapshot ? { streamSnapshot: true } : {}),
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
        publishFinalSnapshot: jest.fn(async ({ html }) =>
          token('snapshot-1', 99, 0, html, true)),
      },
    );

    expect(onToken.mock.calls).toEqual([
      ['<html>', '00000000-0000-4000-8000-000000000001'],
      ['ok</html>', '00000000-0000-4000-8000-000000000002'],
      ['<html>ok</html>', 'snapshot-1', 'replace'],
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
        publishFinalSnapshot: jest.fn(async ({ html }) =>
          token('snapshot-1', 99, 0, html, true)),
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
      '<html>ok</html>',
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
        loadRunEvent: jest.fn().mockResolvedValue(
          token(afterEventId, 1, 0, '<html>'),
        ),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: '<html>ok</html>',
        }),
        publishFinalSnapshot: jest.fn(async ({ html }) =>
          token('snapshot-1', 99, 0, html, true)),
      },
    );

    expect(onToken).toHaveBeenCalledWith(
      'ok</html>',
      '00000000-0000-4000-8000-000000000002',
    );
    expect(onToken).toHaveBeenLastCalledWith(
      '<html>ok</html>',
      'snapshot-1',
      'replace',
    );
  });

  it('advances over a durable empty marker before the next visible live delta', async () => {
    const onToken = jest.fn();

    await observeUiLabV2Run(
      { ...INPUT, onToken },
      {
        replayRunEvents: jest.fn().mockResolvedValue([
          token('marker', 1, 0, '', false, 2),
          token('visible', 2, 2, 'ok'),
          done(),
        ]),
        subscribeRunEvents: jest.fn(() => () => undefined),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: 'ok',
        }),
        publishFinalSnapshot: jest.fn(async ({ html }) =>
          token('snapshot-1', 99, 0, html, true)),
      },
    );

    expect(onToken.mock.calls).toEqual([
      ['ok', 'visible'],
      ['ok', 'snapshot-1', 'replace'],
    ]);
  });

  it('persists and emits a replayable final snapshot tail with an event id', async () => {
    const onToken = jest.fn();
    const final = token(
      '00000000-0000-4000-8000-000000000099',
      99,
      0,
      '<html>ok</html>',
      true,
    );
    const publishFinalSnapshot = jest.fn().mockResolvedValue(final);

    await observeUiLabV2Run(
      { ...INPUT, onToken },
      {
        replayRunEvents: jest.fn().mockResolvedValue([
          token('00000000-0000-4000-8000-000000000001', 1, 0, '<html>'),
          done(),
        ]),
        subscribeRunEvents: jest.fn(() => () => undefined),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: '<html>ok</html>',
        }),
        publishFinalSnapshot,
      },
    );

    expect(publishFinalSnapshot).toHaveBeenCalledWith({
      threadId: INPUT.threadId,
      runId: INPUT.runId,
      html: '<html>ok</html>',
    });
    expect(onToken).toHaveBeenLastCalledWith(
      '<html>ok</html>',
      final.eventId,
      'replace',
    );
  });

  it('paginates more than 500 durable events until terminal', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      token(`event-${index}`, index + 1, index, 'x'));
    const finalToken = token('event-500', 501, 500, 'y');
    const replayRunEvents = jest.fn(async (
      _threadId: string,
      afterEventId?: string,
    ) => afterEventId ? [finalToken, done()] : firstPage);
    let live: ((event: AgentRunEventEnvelope) => void) | undefined;
    const observing = observeUiLabV2Run(
      { ...INPUT, onToken: jest.fn() },
      {
        replayRunEvents: replayRunEvents as never,
        subscribeRunEvents: jest.fn((_threadId, callback) => {
          live = callback;
          return () => undefined;
        }),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: `${'x'.repeat(500)}y`,
        }),
        publishFinalSnapshot: jest.fn(async () =>
          token('event-final', 999, 0, `${'x'.repeat(500)}y`, true)),
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    if (replayRunEvents.mock.calls.length < 2) live?.(done());
    await observing;

    expect(replayRunEvents).toHaveBeenCalledTimes(2);
    expect(replayRunEvents.mock.calls[1][1]).toBe('event-499');
  });
});

describe('replayCompletedUiLabV2Run', () => {
  const cursor = token('cursor-event', 1, 0, '<html>');
  const snapshot = token(
    'snapshot-event',
    2,
    0,
    '<html>ok</html>',
    true,
  );

  it('backfills missing final text before completing a ready reconnect', async () => {
    const onToken = jest.fn();

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: cursor.eventId,
        finalHtml: '<html>ok</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(cursor),
        replayRunEvents: jest.fn().mockResolvedValue([snapshot]),
      },
    );

    expect(onToken).toHaveBeenCalledWith(
      '<html>ok</html>',
      snapshot.eventId,
      'replace',
    );
  });

  it('does not duplicate final text after reconnecting from the snapshot id', async () => {
    const onToken = jest.fn();

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: snapshot.eventId,
        finalHtml: '<html>ok</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(snapshot),
        replayRunEvents: jest.fn().mockResolvedValue([]),
      },
    );

    expect(onToken).not.toHaveBeenCalled();
  });

  it('deduplicates a repeated final snapshot event id', async () => {
    const onToken = jest.fn();

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: cursor.eventId,
        finalHtml: '<html>ok</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(cursor),
        replayRunEvents: jest.fn().mockResolvedValue([snapshot, snapshot]),
      },
    );

    expect(onToken).toHaveBeenCalledTimes(1);
  });

  it('creates the final snapshot from ready HTML when the first publish was lost', async () => {
    const onToken = jest.fn();
    const publishFinalSnapshot = jest.fn().mockResolvedValue(snapshot);

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: cursor.eventId,
        finalHtml: '<html>ok</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(cursor),
        replayRunEvents: jest.fn().mockResolvedValue([]),
        publishFinalSnapshot,
      },
    );

    expect(publishFinalSnapshot).toHaveBeenCalledWith({
      threadId: INPUT.threadId,
      runId: cursor.runId,
      html: '<html>ok</html>',
    });
    expect(onToken).toHaveBeenCalledWith(
      '<html>ok</html>',
      snapshot.eventId,
      'replace',
    );
  });

  it('filters completed replay to the cursor run id', async () => {
    const onToken = jest.fn();
    const wrongRun = {
      ...token('wrong-run-event', 2, 6, 'WRONG'),
      runId: 'run-2',
    };
    const replayRunEvents = jest.fn().mockResolvedValue([
      wrongRun,
      snapshot,
    ]);

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: cursor.eventId,
        finalHtml: '<html>ok</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(cursor),
        replayRunEvents,
      },
    );

    expect(replayRunEvents).toHaveBeenCalledWith(
      INPUT.threadId,
      cursor.eventId,
      500,
      cursor.runId,
      'oldest',
    );
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith(
      '<html>ok</html>',
      snapshot.eventId,
      'replace',
    );
  });

  it('paginates more than 500 completed-run events with the same run filter', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) =>
      token(`completed-${index}`, index + 2, 6 + index, 'x'));
    const replayRunEvents = jest.fn(async (
      _threadId: string,
      afterEventId?: string,
      _limit?: number,
      runId?: string,
    ) => {
      expect(runId).toBe(INPUT.runId);
      return afterEventId === cursor.eventId ? firstPage : [snapshot];
    });
    const onToken = jest.fn();

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: cursor.eventId,
        finalHtml: '<html>ok</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(cursor),
        replayRunEvents: replayRunEvents as never,
      },
    );

    expect(replayRunEvents).toHaveBeenCalledTimes(2);
    expect(replayRunEvents.mock.calls[1][1]).toBe('completed-499');
    expect(onToken).toHaveBeenLastCalledWith(
      '<html>ok</html>',
      snapshot.eventId,
      'replace',
    );
  });

  it('replays mixed visible and NUL-compressed deltas with the original raw offset progression', async () => {
    const onToken = jest.fn();

    await replayCompletedUiLabV2Run(
      {
        threadId: INPUT.threadId,
        runId: INPUT.runId,
        afterEventId: cursor.eventId,
        finalHtml: '<html>abc</html>',
        onToken,
      },
      {
        loadRunEvent: jest.fn().mockResolvedValue(cursor),
        replayRunEvents: jest.fn().mockResolvedValue([
          token('mixed-1', 2, 6, 'ab', false, 9),
          token('mixed-2', 3, 9, 'c</html>'),
          token('snapshot-1', 4, 0, '<html>abc</html>', true),
        ]),
      },
    );

    expect(onToken.mock.calls).toEqual([
      ['ab', 'mixed-1'],
      ['c</html>', 'mixed-2'],
      ['<html>abc</html>', 'snapshot-1', 'replace'],
    ]);
  });

  it('replaces raw fenced and sanitizer-altered deltas with one authoritative snapshot', async () => {
    const onToken = jest.fn();
    const raw =
      '```html\n<html><a href="javascript:alert(1)">ready</a></html>\n```';
    const finalHtml =
      '<html><a href="removed:alert(1)">ready</a></html>';
    const finalSnapshot = token(
      'sanitized-snapshot',
      99,
      0,
      finalHtml,
      true,
    );

    await observeUiLabV2Run(
      { ...INPUT, onToken },
      {
        replayRunEvents: jest.fn().mockResolvedValue([
          token('raw-delta', 1, 0, raw),
          done(),
        ]),
        subscribeRunEvents: jest.fn(() => () => undefined),
        harvestRun: jest.fn().mockResolvedValue({
          status: 'settled',
          outcome: 'ready',
          html: finalHtml,
        }),
        publishFinalSnapshot: jest.fn().mockResolvedValue(finalSnapshot),
      },
    );

    expect(onToken).toHaveBeenNthCalledWith(1, raw, 'raw-delta');
    expect(onToken).toHaveBeenLastCalledWith(
      finalHtml,
      finalSnapshot.eventId,
      'replace',
    );
  });
});
