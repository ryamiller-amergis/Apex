import { AI_RUN_V2_SCHEMA_VERSION } from '../../shared/types/aiRunV2';
import {
  createRunAttemptRepository,
  type CreateDispatchedV2RunInput,
  type CreateDispatchedV2RunResult,
} from '../services/aiRunV2/runAttemptRepository';

const specRef = {
  container: 'ai-run-artifacts',
  key: 'runs/run-1/attempts/1/spec.json',
};

function boundStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>)
    .flatMap((entry) => boundStrings(entry, seen));
}

describe('AI-run V2 run attempt repository', () => {
  it('returns an active-run conflict instead of creating a duplicate', async () => {
    const execute = jest.fn().mockResolvedValueOnce([
      {
        id: 'run-existing',
        status: 'running',
        transport_version: 'http-files-v1',
      },
    ]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.createQueuedV2Run({
        threadId: 'thread-1',
        projectId: 'project-1',
        lane: 'background',
        timeoutAt: '2026-09-18T13:00:00.000Z',
        specRef,
      })
    ).resolves.toEqual({
      status: 'active_run_conflict',
      existingRunId: 'run-existing',
      existingTransportVersion: 'http-files-v1',
      existingStatus: 'running',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('creates a queued V2 run and first attempt when the thread is free', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    const created = await repo.createQueuedV2Run({
      runId: 'run-1',
      threadId: 'thread-1',
      projectId: 'project-1',
      lane: 'background',
      timeoutAt: '2026-09-18T13:00:00.000Z',
      specRef,
    });

    expect(created.status).toBe('created');
    if (created.status === 'created') {
      expect(created.runId).toBe('run-1');
      expect(created.attemptNumber).toBe(1);
      expect(created.dispatchMessageId).toBeTruthy();
    }
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('creates the initial run, dispatch fence, and outbox command in one transaction', async () => {
    let transactionCount = 0;
    const execute = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-1',
          status: 'queued',
          transport_version: 'servicebus-blob-v2',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          attempt_number: 1,
          status: 'queued',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'outbox-1',
          idempotency_key: 'attempt-1:dispatch',
          kind: 'dispatch_command',
          run_id: 'run-1',
          attempt_id: 'attempt-1',
          payload: {},
          available_at: new Date('2026-09-18T12:00:00.000Z'),
          publish_attempts: 0,
          created_at: new Date('2026-09-18T12:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => {
        transactionCount += 1;
        return work({ execute });
      },
    });
    const createDispatchedV2Run = Reflect.get(
      repo,
      'createDispatchedV2Run',
    ) as
      | ((
          input: CreateDispatchedV2RunInput,
        ) => Promise<CreateDispatchedV2RunResult>)
      | undefined;

    expect(createDispatchedV2Run).toEqual(expect.any(Function));
    if (!createDispatchedV2Run) return;

    await expect(
      createDispatchedV2Run({
        runId: 'run-1',
        threadId: 'thread-1',
        projectId: 'project-1',
        lane: 'background',
        workloadLane: 'visual',
        capacityClass: 'batch',
        timeoutAt: '2026-09-18T13:00:00.000Z',
        specRef,
      }),
    ).resolves.toMatchObject({
      status: 'dispatched',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      outboxId: 'outbox-1',
    });
    expect(transactionCount).toBe(1);
    expect(
      execute.mock.calls
        .flatMap(([query]) => boundStrings(query))
        .some((value) =>
          value.includes('"deadlineAt":"2026-09-18T13:00:00.000Z"')),
    ).toBe(true);
  });

  it('rolls back the queued row when the initial outbox write fails', async () => {
    const committedStatements: unknown[] = [];
    let transactionCount = 0;
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => {
        transactionCount += 1;
        const pendingStatements: unknown[] = [];
        let statement = 0;
        const execute = jest.fn(async (query: unknown) => {
          pendingStatements.push(query);
          statement += 1;
          if (statement === 1) return [];
          if (statement === 4) {
            return [
              {
                id: 'run-1',
                status: 'queued',
                transport_version: 'servicebus-blob-v2',
              },
            ];
          }
          if (statement === 5) {
            return [
              {
                id: 'attempt-1',
                attempt_number: 1,
                status: 'queued',
              },
            ];
          }
          if (statement === 8) throw new Error('outbox unavailable');
          return [];
        });
        const result = await work({ execute });
        committedStatements.push(...pendingStatements);
        return result;
      },
    });
    const createDispatchedV2Run = Reflect.get(
      repo,
      'createDispatchedV2Run',
    ) as
      | ((
          input: CreateDispatchedV2RunInput,
        ) => Promise<CreateDispatchedV2RunResult>)
      | undefined;

    expect(createDispatchedV2Run).toEqual(expect.any(Function));
    if (!createDispatchedV2Run) return;

    await expect(
      createDispatchedV2Run({
        runId: 'run-1',
        threadId: 'thread-1',
        projectId: 'project-1',
        lane: 'background',
        workloadLane: 'document',
        capacityClass: 'batch',
        timeoutAt: '2026-09-18T13:00:00.000Z',
        specRef,
      }),
    ).rejects.toThrow('outbox unavailable');
    expect(transactionCount).toBe(1);
    expect(committedStatements).toEqual([]);
  });

  it('does not let a delayed initial dispatcher revive a recovered run', async () => {
    const execute = jest.fn().mockResolvedValueOnce([
      {
        id: 'run-1',
        status: 'cancelled',
        transport_version: 'servicebus-blob-v2',
      },
    ]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.dispatchNextAttempt({
        runId: 'run-1',
        workloadLane: 'document',
        capacityClass: 'batch',
        specRef,
      }),
    ).rejects.toThrow('cancelled run');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects stale dispatch fences on transition and checkpoint accept', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          run_id: 'run-1',
          status: 'running',
          dispatch_message_id: 'dispatch-current',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          dispatch_message_id: 'dispatch-current',
          last_checkpoint_sequence: 2,
          status: 'running',
        },
      ]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.transitionAttempt({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-stale',
        to: 'finalizing',
      })
    ).resolves.toEqual({ status: 'fence_mismatch' });

    await expect(
      repo.acceptCheckpoint({
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId: 'evt-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-stale',
        timestamp: '2026-09-18T12:00:00.000Z',
        kind: 'heartbeat',
        checkpointSequence: 3,
      })
    ).resolves.toEqual({ status: 'fence_mismatch' });
  });

  it('stores the started execution id where the reconciler probes for it', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          dispatch_message_id: 'dispatch-1',
          last_checkpoint_sequence: 0,
          status: 'dispatched',
        },
      ])
      .mockResolvedValueOnce([{ event_id: 'evt-1' }]) // inbox claim
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.acceptCheckpoint({
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId: 'evt-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
        timestamp: '2026-09-18T12:00:00.000Z',
        kind: 'started',
        checkpointSequence: 1,
        containerAppsExecutionId: 'exec-42',
      })
    ).resolves.toEqual({ status: 'accepted', checkpointSequence: 1 });

    const attemptUpdate = JSON.stringify(
      execute.mock.calls.map(([query]) => query)
    );
    expect(attemptUpdate).toContain('containerAppsExecutionId');
    expect(attemptUpdate).toContain('exec-42');
  });

  it('rejects non-monotonic checkpoint sequences', async () => {
    const execute = jest.fn().mockResolvedValueOnce([
      {
        id: 'attempt-1',
        dispatch_message_id: 'dispatch-1',
        last_checkpoint_sequence: 5,
        status: 'running',
      },
    ]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.acceptCheckpoint({
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId: 'evt-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
        timestamp: '2026-09-18T12:00:00.000Z',
        kind: 'heartbeat',
        checkpointSequence: 5,
      })
    ).resolves.toEqual({
      status: 'stale_sequence',
      lastCheckpointSequence: 5,
    });
  });

  it('persists and fans out accepted text progress in the checkpoint transaction', async () => {
    const eventId = '3f44f6f1-ec42-4aa6-9df4-0d8ce8438491';
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          dispatch_message_id: 'dispatch-1',
          last_checkpoint_sequence: 1,
          status: 'running',
          thread_id: 'ui-lab:design-1',
        },
      ])
      .mockResolvedValueOnce([{ event_id: eventId }])
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.acceptCheckpoint({
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId,
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
        timestamp: '2026-09-18T12:00:00.000Z',
        kind: 'progress',
        checkpointSequence: 2,
        phase: 'generation',
        status: 'running',
        progress: {
          kind: 'text_delta',
          offset: 0,
          text: '<html>',
        },
      }),
    ).resolves.toEqual({ status: 'accepted', checkpointSequence: 2 });

    const statements = execute.mock.calls
      .flatMap(([query]) => boundStrings(query))
      .join('\n');
    expect(statements).toContain('INSERT INTO agent_run_events');
    expect(statements).toContain('pg_notify');
    expect(statements).toContain('ui-lab:design-1');
    expect(statements).toContain('<html>');
  });

  it('persists an empty durable marker when a text delta contains only NUL bytes', async () => {
    const eventId = '4f44f6f1-ec42-4aa6-9df4-0d8ce8438491';
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          dispatch_message_id: 'dispatch-1',
          last_checkpoint_sequence: 1,
          status: 'running',
          thread_id: 'ui-lab:design-1',
        },
      ])
      .mockResolvedValueOnce([{ event_id: eventId }])
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.acceptCheckpoint({
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId,
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
        timestamp: '2026-09-18T12:00:00.000Z',
        kind: 'progress',
        checkpointSequence: 2,
        phase: 'generation',
        status: 'running',
        progress: {
          kind: 'text_delta',
          offset: 6,
          text: '\u0000\u0000',
        },
      }),
    ).resolves.toEqual({ status: 'accepted', checkpointSequence: 2 });

    const statements = execute.mock.calls
      .flatMap(([query]) => boundStrings(query))
      .join('\n');
    expect(statements).toContain('INSERT INTO agent_run_events');
    expect(statements).toContain('pg_notify');
    expect(statements).toContain('"text":""');
    expect(statements).toContain('"streamEndOffset":8');
  });

  it('preserves the raw stream offset when a text delta mixes visible text and NUL bytes', async () => {
    const eventId = '5f44f6f1-ec42-4aa6-9df4-0d8ce8438491';
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          dispatch_message_id: 'dispatch-1',
          last_checkpoint_sequence: 1,
          status: 'running',
          thread_id: 'ui-lab:design-1',
        },
      ])
      .mockResolvedValueOnce([{ event_id: eventId }])
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.acceptCheckpoint({
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId,
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
        timestamp: '2026-09-18T12:00:00.000Z',
        kind: 'progress',
        checkpointSequence: 2,
        phase: 'generation',
        status: 'running',
        progress: {
          kind: 'text_delta',
          offset: 6,
          text: 'a\u0000b',
        },
      }),
    ).resolves.toEqual({ status: 'accepted', checkpointSequence: 2 });

    const statements = execute.mock.calls
      .flatMap(([query]) => boundStrings(query))
      .join('\n');
    expect(statements).toContain('"text":"ab"');
    expect(statements).toContain('"streamOffset":6');
    expect(statements).toContain('"streamEndOffset":9');
  });

  it.each([
    ['queued', 'queued'],
    ['dispatched', 'dispatched'],
    ['running', 'running'],
    ['checking_worker', 'running'],
    ['finalizing', 'running'],
    ['completed', 'terminal'],
    ['failed', 'terminal'],
    ['cancelled', 'terminal'],
  ] as const)(
    'reads interactive %s state as %s under the dispatch fence',
    async (attemptStatus, expectedState) => {
      const execute = jest.fn().mockResolvedValueOnce([
        {
          attempt_status: attemptStatus,
          dispatch_message_id: 'dispatch-1',
        },
      ]);
      const repo = createRunAttemptRepository({
        runInTransaction: async (work) => work({ execute }),
      });

      await expect(
        repo.readInteractiveDispatchState({
          attemptId: 'attempt-1',
          expectedDispatchMessageId: 'dispatch-1',
        }),
      ).resolves.toBe(expectedState);
    },
  );

  it('distinguishes missing interactive attempts from stale fences', async () => {
    const missingExecute = jest.fn().mockResolvedValueOnce([]);
    const missingRepo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute: missingExecute }),
    });
    await expect(
      missingRepo.readInteractiveDispatchState({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-1',
      }),
    ).resolves.toBe('not-found');

    const staleExecute = jest.fn().mockResolvedValueOnce([
      {
        attempt_status: 'queued',
        dispatch_message_id: 'dispatch-current',
      },
    ]);
    const staleRepo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute: staleExecute }),
    });
    await expect(
      staleRepo.readInteractiveDispatchState({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-stale',
      }),
    ).resolves.toBe('fence-mismatch');
  });

  it('marks an interactive attempt dispatched once and persists its phase', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          attempt_status: 'queued',
          dispatch_message_id: 'dispatch-1',
          run_id: 'run-1',
          thread_id: 'thread-1',
          run_status: 'queued',
        },
      ])
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.markInteractiveDispatched({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-1',
      }),
    ).resolves.toBe('dispatched');

    const statements = execute.mock.calls
      .flatMap(([query]) => boundStrings(query))
      .join('\n');
    expect(statements).toContain('UPDATE ai_run_attempts');
    expect(statements).toContain('UPDATE agent_runs');
    expect(statements).toContain('INSERT INTO agent_run_events');
    expect(statements).toContain("'dispatched'");
    expect(statements).toContain('interactive-orchestrator:attempt-1');
    expect(statements).toContain('pg_notify');
  });

  it('reuses an already-dispatched attempt after a lost response', async () => {
    const execute = jest.fn().mockResolvedValueOnce([
      {
        attempt_status: 'dispatched',
        dispatch_message_id: 'dispatch-1',
        run_id: 'run-1',
        thread_id: 'thread-1',
        run_status: 'dispatched',
      },
    ]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.markInteractiveDispatched({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-1',
      }),
    ).resolves.toBe('already-dispatched');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fencedly terminalizes an expired interactive dispatch with error and done events', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          attempt_status: 'queued',
          dispatch_message_id: 'dispatch-1',
          run_id: 'run-1',
          thread_id: 'thread-1',
          run_status: 'queued',
        },
      ])
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.failExpiredInteractiveDispatch({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-1',
        detail: 'Interactive turn exceeded its absolute deadline',
      }),
    ).resolves.toBe('terminalized');

    const statements = execute.mock.calls
      .flatMap(([query]) => boundStrings(query))
      .join('\n');
    expect(statements).toContain('hard_timeout');
    expect(statements).toContain('UPDATE chat_threads');
    expect(statements).toContain('"type":"error"');
    expect(statements).toContain('"type":"done"');
    expect(statements).toContain(
      'interactive-orchestrator-timeout:attempt-1',
    );
    expect(statements).toContain('pg_notify');
  });

  it('fencedly terminalizes a safely identified malformed dispatch as validation_failed', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          attempt_status: 'queued',
          dispatch_message_id: 'dispatch-1',
          run_id: 'run-1',
          thread_id: 'thread-1',
          run_status: 'queued',
        },
      ])
      .mockResolvedValue([]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(
      repo.failInvalidInteractiveDispatch({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-1',
        detail: 'Interactive dispatch payload failed validation',
      }),
    ).resolves.toBe('terminalized');

    const statements = execute.mock.calls
      .flatMap(([query]) => boundStrings(query))
      .join('\n');
    expect(statements).toContain('validation_failed');
    expect(statements).toContain(
      'interactive-orchestrator-validation:attempt-1',
    );
    expect(statements).toContain('"type":"error"');
    expect(statements).toContain('"type":"done"');
  });

  it('does not terminalize a stale fence and treats a terminal replay idempotently', async () => {
    const staleExecute = jest.fn().mockResolvedValueOnce([
      {
        attempt_status: 'queued',
        dispatch_message_id: 'dispatch-current',
        run_id: 'run-1',
        thread_id: 'thread-1',
        run_status: 'queued',
      },
    ]);
    const staleRepo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute: staleExecute }),
    });
    await expect(
      staleRepo.failInvalidInteractiveDispatch({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-stale',
        detail: 'stale',
      }),
    ).resolves.toBe('fence-mismatch');
    expect(staleExecute).toHaveBeenCalledTimes(1);

    const terminalExecute = jest.fn().mockResolvedValueOnce([
      {
        attempt_status: 'failed',
        dispatch_message_id: 'dispatch-1',
        run_id: 'run-1',
        thread_id: 'thread-1',
        run_status: 'failed',
      },
    ]);
    const terminalRepo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute: terminalExecute }),
    });
    await expect(
      terminalRepo.failInvalidInteractiveDispatch({
        attemptId: 'attempt-1',
        expectedDispatchMessageId: 'dispatch-1',
        detail: 'duplicate',
      }),
    ).resolves.toBe('already-terminal');
    expect(terminalExecute).toHaveBeenCalledTimes(1);
  });
});
