import { createInboxRepository } from '../services/aiRunV2/inboxRepository';

describe('AI-run V2 inbox repository', () => {
  it('inserts a new event and distinguishes processed vs unprocessed duplicates', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ event_id: 'evt-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ event_id: 'evt-1', processed_at: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { event_id: 'evt-1', processed_at: '2026-09-18T12:01:00.000Z' },
      ]);

    const repo = createInboxRepository({ execute });
    await expect(
      repo.claimEvent({
        eventId: 'evt-1',
        kind: 'checkpoint',
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'dispatch-1',
        checkpointSequence: 1,
        payload: { kind: 'heartbeat' },
      })
    ).resolves.toEqual({ status: 'inserted', eventId: 'evt-1' });

    await expect(
      repo.claimEvent({
        eventId: 'evt-1',
        kind: 'checkpoint',
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'dispatch-1',
        checkpointSequence: 1,
        payload: { kind: 'heartbeat' },
      })
    ).resolves.toEqual({ status: 'duplicate_unprocessed', eventId: 'evt-1' });

    await expect(
      repo.claimEvent({
        eventId: 'evt-1',
        kind: 'checkpoint',
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'dispatch-1',
        checkpointSequence: 1,
        payload: { kind: 'heartbeat' },
      })
    ).resolves.toEqual({ status: 'duplicate_processed', eventId: 'evt-1' });
  });

  it('marks an unprocessed event processed exactly once', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([{ event_id: 'evt-1' }])
      .mockResolvedValueOnce([]);
    const repo = createInboxRepository({ execute });
    await expect(repo.markProcessed('evt-1')).resolves.toBe(true);
    await expect(repo.markProcessed('evt-1')).resolves.toBe(false);
  });

  it('rejects non-positive checkpoint sequences', async () => {
    const repo = createInboxRepository({ execute: jest.fn() });
    await expect(
      repo.claimEvent({
        eventId: 'evt-1',
        kind: 'checkpoint',
        runId: 'run-1',
        attemptId: 'attempt-1',
        dispatchMessageId: 'dispatch-1',
        checkpointSequence: 0,
        payload: {},
      })
    ).rejects.toThrow(/checkpointSequence/);
  });
});
