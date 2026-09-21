import { AI_RUN_V2_SCHEMA_VERSION } from '../../../shared/types/aiRunV2';
import { createCheckpointConsumer } from '../../services/aiOrchestrator/checkpointConsumer';
import { createResultConsumer } from '../../services/aiOrchestrator/resultConsumer';
import { createReconciler } from '../../services/aiOrchestrator/reconciler';
import type { PeekLockedMessage } from '../../services/aiOrchestrator/types';
import type { QueueConsumer } from '../../services/aiOrchestrator/ports';

function checkpointMessage(
  overrides: Partial<PeekLockedMessage> = {},
): PeekLockedMessage {
  return {
    lockToken: 'lock-1',
    messageId: 'mid-1',
    deliveryCount: 1,
    body: {
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: 'evt-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      timestamp: '2026-09-18T12:00:00.000Z',
      kind: 'heartbeat',
      checkpointSequence: 2,
    },
    ...overrides,
  };
}

describe('checkpointConsumer', () => {
  it('completes accepted and stale/duplicate checkpoints without terminalizing', async () => {
    const completed: string[] = [];
    const consumer: QueueConsumer = {
      receive: async () => checkpointMessage(),
      complete: async (token) => {
        completed.push(token);
      },
      abandon: async () => undefined,
      deadLetter: async () => undefined,
    };
    const acceptCheckpoint = jest.fn().mockResolvedValue({
      status: 'accepted',
      checkpointSequence: 2,
    });
    const handler = createCheckpointConsumer({
      consumer,
      attempts: {
        acceptCheckpoint,
      } as never,
    });
    await expect(handler.processOnce()).resolves.toBe('processed');
    expect(completed).toEqual(['lock-1']);
    expect(acceptCheckpoint).toHaveBeenCalled();
  });

  it('dead-letters fence mismatches', async () => {
    const dead: string[] = [];
    const consumer: QueueConsumer = {
      receive: async () => checkpointMessage(),
      complete: async () => undefined,
      abandon: async () => undefined,
      deadLetter: async (token) => {
        dead.push(token);
      },
    };
    const handler = createCheckpointConsumer({
      consumer,
      attempts: {
        acceptCheckpoint: async () => ({ status: 'fence_mismatch' }),
      } as never,
    });
    await expect(handler.processOnce()).resolves.toBe('poison');
    expect(dead).toEqual(['lock-1']);
  });
});

describe('resultConsumer', () => {
  it('finalizes a valid terminal result', async () => {
    const completed: string[] = [];
    const consumer: QueueConsumer = {
      receive: async () => ({
        lockToken: 'lock-r',
        messageId: 'm',
        deliveryCount: 1,
        body: {
          schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
          eventId: 'evt-r',
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          dispatchMessageId: 'dispatch-1',
          timestamp: '2026-09-18T12:00:00.000Z',
          kind: 'terminal',
          status: 'completed',
          artifactStatus: 'verified',
        },
      }),
      complete: async (token) => {
        completed.push(token);
      },
      abandon: async () => undefined,
      deadLetter: async () => undefined,
    };
    const transitionAttempt = jest.fn().mockResolvedValue({
      status: 'ok',
      attemptId: 'attempt-1',
      to: 'completed',
    });
    const handler = createResultConsumer({
      consumer,
      attempts: { transitionAttempt } as never,
    });
    await expect(handler.processOnce()).resolves.toBe('processed');
    expect(transitionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'completed' }),
    );
    expect(completed).toEqual(['lock-r']);
  });
});

describe('reconciler', () => {
  it('moves stale running attempts to checking_worker without worker_lost', async () => {
    const transitions: string[] = [];
    const reconciler = createReconciler({
      executor: { execute: async () => [] },
      attempts: {
        transitionAttempt: async (input: { to: string }) => {
          transitions.push(input.to);
          return { status: 'ok', attemptId: 'a1', to: input.to };
        },
      } as never,
      executionProbe: { probe: async () => ({ status: 'running' }) },
      listStaleRunning: async () => [
        {
          attemptId: 'a1',
          runId: 'r1',
          dispatchMessageId: 'd1',
          status: 'running',
          lastCheckpointAt: null,
          containerAppsExecutionId: 'exec-1',
        },
      ],
      listCheckingWorkers: async () => [],
      acquireRecoveryLease: async (work) =>
        work({
          leaseKey: 'recovery',
          holderId: 'h',
          fencingToken: 1n,
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
          release: async () => undefined,
        }),
      acquireReaperLease: async (work) =>
        work({
          leaseKey: 'reaper',
          holderId: 'h',
          fencingToken: 1n,
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
          release: async () => undefined,
        }),
    });

    await expect(reconciler.sweepStaleCheckpoints()).resolves.toBe(1);
    expect(transitions).toEqual(['checking_worker']);
  });

  it('marks worker_lost only after a negative execution probe', async () => {
    const transitions: string[] = [];
    const reconciler = createReconciler({
      executor: { execute: async () => [] },
      attempts: {
        transitionAttempt: async (input: {
          to: string;
          failureCategory?: string;
        }) => {
          transitions.push(`${input.to}:${input.failureCategory ?? ''}`);
          return { status: 'ok', attemptId: 'a1', to: input.to };
        },
      } as never,
      executionProbe: { probe: async () => ({ status: 'not_found' }) },
      listStaleRunning: async () => [],
      listCheckingWorkers: async () => [
        {
          attemptId: 'a1',
          runId: 'r1',
          dispatchMessageId: 'd1',
          status: 'checking_worker',
          lastCheckpointAt: '2026-09-18T12:00:00.000Z',
          containerAppsExecutionId: 'exec-missing',
        },
      ],
      acquireRecoveryLease: async (work) =>
        work({
          leaseKey: 'recovery',
          holderId: 'h',
          fencingToken: 1n,
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
          release: async () => undefined,
        }),
      acquireReaperLease: async (work) =>
        work({
          leaseKey: 'reaper',
          holderId: 'h',
          fencingToken: 1n,
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
          release: async () => undefined,
        }),
    });

    await expect(reconciler.sweepCheckingWorkers()).resolves.toBe(1);
    expect(transitions).toEqual(['failed:worker_lost']);
  });

  describe('retry after a confirmed loss', () => {
    const lostRow = {
      attemptId: 'a1',
      runId: 'r1',
      dispatchMessageId: 'd1',
      status: 'checking_worker',
      lastCheckpointAt: '2026-09-18T12:00:00.000Z',
      containerAppsExecutionId: 'exec-gone',
    };

    const lease = async <T>(work: (held: never) => Promise<T>): Promise<T> =>
      work({
        leaseKey: 'reaper',
        holderId: 'h',
        fencingToken: 1n,
        signal: new AbortController().signal,
        assertOwned: async () => undefined,
        release: async () => undefined,
      } as never);

    function makeReconciler(
      dispatchNextAttempt: jest.Mock,
      retryContext: unknown,
      maxAttempts?: number,
    ) {
      return createReconciler({
        executor: { execute: async () => [] },
        attempts: {
          transitionAttempt: async () => ({
            status: 'ok',
            attemptId: 'a1',
            to: 'failed',
          }),
          dispatchNextAttempt,
        } as never,
        executionProbe: { probe: async () => ({ status: 'not_found' }) },
        listStaleRunning: async () => [],
        listCheckingWorkers: async () => [lostRow],
        loadRetryContext: async () => retryContext as never,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        acquireRecoveryLease: lease,
        acquireReaperLease: lease,
      });
    }

    it('dispatches a replacement attempt with a fresh dispatch id', async () => {
      const dispatchNextAttempt = jest.fn().mockResolvedValue({
        attemptId: 'a2',
        attemptNumber: 2,
        dispatchMessageId: 'd2',
        outboxId: 'o2',
      });
      const reconciler = makeReconciler(dispatchNextAttempt, {
        workloadLane: 'document',
        specRef: { container: 'ai-run-artifacts', key: 'spec.json' },
        attemptCount: 1,
      });

      await reconciler.sweepCheckingWorkers();

      expect(dispatchNextAttempt).toHaveBeenCalledWith({
        runId: 'r1',
        workloadLane: 'document',
        specRef: { container: 'ai-run-artifacts', key: 'spec.json' },
      });
    });

    it('stops retrying once the run has used its attempts', async () => {
      const dispatchNextAttempt = jest.fn();
      const reconciler = makeReconciler(
        dispatchNextAttempt,
        {
          workloadLane: 'document',
          specRef: { container: 'ai-run-artifacts', key: 'spec.json' },
          attemptCount: 3,
        },
        3,
      );

      await reconciler.sweepCheckingWorkers();

      expect(dispatchNextAttempt).not.toHaveBeenCalled();
    });

    it('leaves the run failed when the original command cannot be read', async () => {
      const dispatchNextAttempt = jest.fn();
      const reconciler = makeReconciler(dispatchNextAttempt, null);

      await expect(reconciler.sweepCheckingWorkers()).resolves.toBe(1);
      expect(dispatchNextAttempt).not.toHaveBeenCalled();
    });

    it('still reports the loss when the replacement dispatch fails', async () => {
      const dispatchNextAttempt = jest
        .fn()
        .mockRejectedValue(new Error('outbox unavailable'));
      const reconciler = makeReconciler(dispatchNextAttempt, {
        workloadLane: 'visual',
        specRef: { container: 'ai-run-artifacts', key: 'spec.json' },
        attemptCount: 1,
      });

      await expect(reconciler.sweepCheckingWorkers()).resolves.toBe(1);
      expect(dispatchNextAttempt).toHaveBeenCalled();
    });
  });
});
