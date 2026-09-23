import { createOutboxRepository } from '../services/aiRunV2/outboxRepository';

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join(' ');
}

describe('AI-run V2 outbox repository', () => {
  it('enqueues idempotently and returns only newly inserted rows', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
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
        },
      ])
      .mockResolvedValueOnce([{ pg_notify: '' }]) // transactional wake
      .mockResolvedValueOnce([]); // duplicate idempotency key

    const repo = createOutboxRepository({ execute });
    const first = await repo.enqueue([
      {
        idempotencyKey: 'attempt-1:dispatch',
        kind: 'dispatch_command',
        runId: 'run-1',
        attemptId: 'attempt-1',
        payload: { hello: 'world' },
      },
    ]);
    const second = await repo.enqueue([
      {
        idempotencyKey: 'attempt-1:dispatch',
        kind: 'dispatch_command',
        runId: 'run-1',
        attemptId: 'attempt-1',
        payload: { hello: 'world' },
      },
    ]);

    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('outbox-1');
    expect(second).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('claims due rows for one holder and marks published only for that holder', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
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
        },
      ])
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
    await expect(repo.claimBatch(0, 'drainer-a', 1_000)).rejects.toThrow(
      /limit/
    );
    await expect(repo.claimBatch(1, 'drainer-a', 0)).rejects.toThrow(/claimMs/);

    const failed = await repo.markFailed('outbox-1', 'drainer-a', 'boom', 500);
    expect(failed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('claims interactive work before batch work without domain inspection', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = createOutboxRepository({ execute });

    await repo.claimBatch(10, 'drainer-a', 60_000);

    const query = sqlText(execute.mock.calls[0][0]);
    expect(query).toContain("payload->>'capacityClass'");
    expect(query).toContain("'batch'");
    expect(query).toContain('CASE');
    expect(query).not.toContain('ui-lab');
    expect(query).not.toContain('design-prototype');
  });

  it('keeps background claims isolated from interactive dispatch rows', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = createOutboxRepository({ execute });

    await repo.claimBatch(10, 'drainer-a', 60_000);

    const query = sqlText(execute.mock.calls[0][0]);
    expect(query).toContain("kind <> 'interactive_dispatch'");
  });

  it('claims the bounded FIFO union needed for interactive floors and burst', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = createOutboxRepository({ execute });

    await repo.claimInteractiveCandidates(16, 2, 'drainer-a', 60_000);

    const query = sqlText(execute.mock.calls[0][0]);
    expect(query).toContain("kind = 'interactive_dispatch'");
    expect(query).toContain("payload->>'interactiveClass' AS interactive_class");
    expect(query).toContain("interactive_class = 'fast'");
    expect(query).toContain("interactive_class = 'agentic'");
    expect(query).toContain('FOR UPDATE OF outbox SKIP LOCKED');
    expect(query).toContain('ORDER BY created_at ASC, id ASC');
    expect(query).not.toContain('ORDER BY available_at');
    expect(query).not.toContain('model');
  });

  it('releases an expected capacity deferral without publishing it', async () => {
    const execute = jest.fn().mockResolvedValueOnce([{ id: 'outbox-1' }]);
    const repo = createOutboxRepository({ execute });

    await expect(
      repo.releaseClaim(
        'outbox-1',
        'drainer-a',
        '2026-09-23T15:00:05.000Z',
        'interactive_cap',
      ),
    ).resolves.toBe(true);

    const query = sqlText(execute.mock.calls[0][0]);
    expect(query).toContain('claimed_by = NULL');
    expect(query).toContain('claimed_at = NULL');
    expect(query).toContain('claim_expires_at = NULL');
    expect(query).not.toContain('publish_attempts =');
    expect(query).not.toContain('published_at =');
  });
});
