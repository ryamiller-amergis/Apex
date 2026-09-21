/**
 * The durable side of the harvest: which attempts are finished, and the
 * claim that lets exactly one instance consume each of them.
 */
import {
  createFinishedAttemptReader,
  harvestEventId,
} from '../services/aiRunV2/finishedAttemptReader';

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join(' ');
}

function inbox() {
  return {
    claimEvent: jest.fn(),
    markProcessed: jest.fn().mockResolvedValue(true),
    getEvent: jest.fn(),
  };
}

describe('finished V2 attempt reader', () => {
  it('returns the latest finished attempt keyed by thread', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        thread_id: 'prototype:proto-1',
        attempt_id: 'attempt-2',
        run_id: 'run-1',
        dispatch_message_id: 'dispatch-2',
        status: 'completed',
        manifest_ref: { container: 'ai-run-artifacts', key: 'runs/run-1/attempts/2/manifest.json' },
        failure_detail: null,
      },
    ]);
    const reader = createFinishedAttemptReader({ executor: { execute }, inbox: inbox() });

    const found = await reader.listFinishedByThread([
      'prototype:proto-1',
      'prototype:proto-2',
    ]);

    expect(found.get('prototype:proto-1')).toEqual({
      attemptId: 'attempt-2',
      runId: 'run-1',
      threadId: 'prototype:proto-1',
      dispatchMessageId: 'dispatch-2',
      status: 'completed',
      manifestRef: { container: 'ai-run-artifacts', key: 'runs/run-1/attempts/2/manifest.json' },
      failureDetail: null,
    });
    expect(found.has('prototype:proto-2')).toBe(false);
  });

  it('selects only V2 runs whose header and attempt are both terminal', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const reader = createFinishedAttemptReader({ executor: { execute }, inbox: inbox() });

    await reader.listFinishedByThread(['prototype:proto-1']);

    // A reconciler retry puts the header back to `dispatched` while the losing
    // attempt stays terminal; harvesting then would apply a superseded run.
    const text = sqlText(execute.mock.calls[0][0]);
    expect(text).toContain("r.transport_version = 'servicebus-blob-v2'");
    expect(text).toContain('r.status IN');
    expect(text).toContain('a.status IN');
  });

  it('asks the database nothing when no thread is waiting', async () => {
    const execute = jest.fn();
    const reader = createFinishedAttemptReader({ executor: { execute }, inbox: inbox() });

    await expect(reader.listFinishedByThread([])).resolves.toEqual(new Map());
    expect(execute).not.toHaveBeenCalled();
  });

  it('drops a row whose manifest reference is not a blob reference', async () => {
    const execute = jest.fn().mockResolvedValue([
      {
        thread_id: 'prototype:proto-1',
        attempt_id: 'attempt-1',
        run_id: 'run-1',
        dispatch_message_id: 'dispatch-1',
        status: 'completed',
        manifest_ref: { container: 'ai-run-artifacts' },
        failure_detail: null,
      },
    ]);
    const reader = createFinishedAttemptReader({ executor: { execute }, inbox: inbox() });

    const found = await reader.listFinishedByThread(['prototype:proto-1']);

    expect(found.get('prototype:proto-1')?.manifestRef).toBeNull();
  });

  const attempt = {
    attemptId: 'attempt-1',
    runId: 'run-1',
    threadId: 'prototype:proto-1',
    dispatchMessageId: 'dispatch-1',
    status: 'completed' as const,
    manifestRef: null,
    failureDetail: null,
  };

  it('claims an attempt the first time and refuses it once processed', async () => {
    const events = inbox();
    events.claimEvent
      .mockResolvedValueOnce({ status: 'inserted', eventId: harvestEventId('attempt-1') })
      .mockResolvedValueOnce({ status: 'duplicate_processed', eventId: harvestEventId('attempt-1') });
    const reader = createFinishedAttemptReader({
      executor: { execute: jest.fn() },
      inbox: events,
    });

    await expect(reader.claimHarvest(attempt)).resolves.toBe('claimed');
    await expect(reader.claimHarvest(attempt)).resolves.toBe('already_harvested');
    expect(events.claimEvent.mock.calls[0][0]).toMatchObject({
      eventId: 'artifact-harvest:attempt-1',
      kind: 'artifact_harvest',
      runId: 'run-1',
      attemptId: 'attempt-1',
      dispatchMessageId: 'dispatch-1',
    });
  });

  it('re-claims an attempt whose previous harvest never finished', async () => {
    const events = inbox();
    events.claimEvent.mockResolvedValue({
      status: 'duplicate_unprocessed',
      eventId: harvestEventId('attempt-1'),
    });
    const reader = createFinishedAttemptReader({
      executor: { execute: jest.fn() },
      inbox: events,
    });

    await expect(reader.claimHarvest(attempt)).resolves.toBe('claimed');
  });

  it('closes the claim by event id', async () => {
    const events = inbox();
    const reader = createFinishedAttemptReader({
      executor: { execute: jest.fn() },
      inbox: events,
    });

    await reader.completeHarvest('attempt-1');

    expect(events.markProcessed).toHaveBeenCalledWith('artifact-harvest:attempt-1');
  });
});
