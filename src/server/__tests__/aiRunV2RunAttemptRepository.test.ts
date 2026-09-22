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
});
