import { AI_RUN_V2_SCHEMA_VERSION } from '../../shared/types/aiRunV2';
import { createRunAttemptRepository } from '../services/aiRunV2/runAttemptRepository';

const specRef = {
  container: 'ai-run-artifacts',
  key: 'runs/run-1/attempts/1/spec.json',
};

describe('AI-run V2 run attempt repository', () => {
  it('returns an active-run conflict instead of creating a duplicate', async () => {
    const execute = jest.fn().mockResolvedValueOnce([{
      id: 'run-existing',
      status: 'running',
      transport_version: 'http-files-v1',
    }]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(repo.createQueuedV2Run({
      threadId: 'thread-1',
      projectId: 'project-1',
      lane: 'background',
      timeoutAt: '2026-09-18T13:00:00.000Z',
      specRef,
    })).resolves.toEqual({
      status: 'active_run_conflict',
      existingRunId: 'run-existing',
      existingTransportVersion: 'http-files-v1',
      existingStatus: 'running',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('creates a queued V2 run and first attempt when the thread is free', async () => {
    const execute = jest.fn()
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

  it('rejects stale dispatch fences on transition and checkpoint accept', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce([{
        id: 'attempt-1',
        run_id: 'run-1',
        status: 'running',
        dispatch_message_id: 'dispatch-current',
      }])
      .mockResolvedValueOnce([{
        id: 'attempt-1',
        dispatch_message_id: 'dispatch-current',
        last_checkpoint_sequence: 2,
        status: 'running',
      }]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(repo.transitionAttempt({
      attemptId: 'attempt-1',
      expectedDispatchMessageId: 'dispatch-stale',
      to: 'finalizing',
    })).resolves.toEqual({ status: 'fence_mismatch' });

    await expect(repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: 'evt-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-stale',
      timestamp: '2026-09-18T12:00:00.000Z',
      kind: 'heartbeat',
      checkpointSequence: 3,
    })).resolves.toEqual({ status: 'fence_mismatch' });
  });

  it('rejects non-monotonic checkpoint sequences', async () => {
    const execute = jest.fn().mockResolvedValueOnce([{
      id: 'attempt-1',
      dispatch_message_id: 'dispatch-1',
      last_checkpoint_sequence: 5,
      status: 'running',
    }]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    await expect(repo.acceptCheckpoint({
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: 'evt-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      timestamp: '2026-09-18T12:00:00.000Z',
      kind: 'heartbeat',
      checkpointSequence: 5,
    })).resolves.toEqual({
      status: 'stale_sequence',
      lastCheckpointSequence: 5,
    });
  });
});
