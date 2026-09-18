import { createOutboxRepository } from '../services/aiRunV2/outboxRepository';

describe('AI-run V2 outbox repository', () => {
  it('enqueues idempotently and returns only newly inserted rows', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce([{
        id: 'outbox-1',
        idempotency_key: 'attempt-1:dispatch',
        kind: 'dispatch_command',
        run_id: 'run-1',
        attempt_id: 'attempt-1',
        payload: { hello: 'world' },
        available_at: '2026-09-18T12:00:00.000Z',
        claimed_by: null,
        claimed_at: null,
        claim_expires_at: null,
        publish_attempts: 0,
        last_error: null,
        published_at: null,
        created_at: '2026-09-18T12:00:00.000Z',
      }])
      .mockResolvedValueOnce([]);

    const repo = createOutboxRepository({ execute });
    const first = await repo.enqueue([{
      idempotencyKey: 'attempt-1:dispatch',
      kind: 'dispatch_command',
      runId: 'run-1',
      attemptId: 'attempt-1',
      payload: { hello: 'world' },
    }]);
    const second = await repo.enqueue([{
      idempotencyKey: 'attempt-1:dispatch',
      kind: 'dispatch_command',
      runId: 'run-1',
      attemptId: 'attempt-1',
      payload: { hello: 'world' },
    }]);

    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('outbox-1');
    expect(second).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('claims due rows for one holder and marks published only for that holder', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce([{
        id: 'outbox-1',
        idempotency_key: 'attempt-1:dispatch',
        kind: 'dispatch_command',
        run_id: 'run-1',
        attempt_id: 'attempt-1',
        payload: { hello: 'world' },
        available_at: '2026-09-18T12:00:00.000Z',
        claimed_by: 'drainer-a',
        claimed_at: '2026-09-18T12:01:00.000Z',
        claim_expires_at: '2026-09-18T12:02:00.000Z',
        publish_attempts: 1,
        last_error: null,
        published_at: null,
        created_at: '2026-09-18T12:00:00.000Z',
      }])
      .mockResolvedValueOnce([{ id: 'outbox-1' }]);

    const repo = createOutboxRepository({ execute });
    const claimed = await repo.claimBatch(10, 'drainer-a', 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].claimedBy).toBe('drainer-a');

    const published = await repo.markPublished(['outbox-1'], 'drainer-a');
    expect(published).toBe(1);
  });

  it('rejects invalid claim limits and clears claims on failure', async () => {
    const execute = jest.fn().mockResolvedValueOnce([{ id: 'outbox-1' }]);
    const repo = createOutboxRepository({ execute });
    await expect(repo.claimBatch(0, 'drainer-a', 1_000)).rejects.toThrow(/limit/);
    await expect(repo.claimBatch(1, 'drainer-a', 0)).rejects.toThrow(/claimMs/);

    const failed = await repo.markFailed('outbox-1', 'drainer-a', 'boom', 500);
    expect(failed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
