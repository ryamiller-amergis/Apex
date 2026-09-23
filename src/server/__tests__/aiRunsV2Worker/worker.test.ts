import { AI_RUN_V2_SCHEMA_VERSION } from '../../../shared/types/aiRunV2';
import { VisualModelTruncatedError } from '../../services/aiRunsV2Worker/bedrockVisualClient';
import { CursorExecutionWaitError } from '../../services/cursorExecutionCore';
import { createV2Worker } from '../../services/aiRunsV2Worker/worker';
import type { WorkerServiceBusClient } from '../../services/aiRunsV2Worker/serviceBusClient';

const specRef = { container: 'ai-run-artifacts', key: 'specs/run-1.json' };

function command(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    eventId: 'evt-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    dispatchMessageId: 'dispatch-1',
    timestamp: '2026-09-18T12:00:00.000Z',
    kind: 'dispatch_command',
    transport: 'servicebus-blob-v2',
    workloadLane: 'document',
    specRef,
    ...overrides,
  };
}

type BusCalls = {
  completed: string[];
  abandoned: string[];
  deadLettered: string[];
  checkpoints: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
};

function fakeBus(
  body: Record<string, unknown> | null,
  deliveryCount = 1,
): { bus: WorkerServiceBusClient; calls: BusCalls } {
  const calls: BusCalls = {
    completed: [],
    abandoned: [],
    deadLettered: [],
    checkpoints: [],
    results: [],
  };
  let delivered = false;
  const bus: WorkerServiceBusClient = {
    async receiveCommand() {
      if (delivered || !body) return null;
      delivered = true;
      return {
        lockToken: 'lock-1',
        messageId: 'msg-1',
        body,
        deliveryCount,
      };
    },
    async completeCommand(lockToken) {
      calls.completed.push(lockToken);
    },
    async abandonCommand(lockToken) {
      calls.abandoned.push(lockToken);
    },
    async deadLetterCommand(lockToken, reason) {
      calls.deadLettered.push(`${lockToken}:${reason}`);
    },
    async sendCheckpoint(_messageId, checkpointBody) {
      calls.checkpoints.push(checkpointBody as Record<string, unknown>);
    },
    async sendResult(_messageId, resultBody) {
      calls.results.push(resultBody as Record<string, unknown>);
    },
  };
  return { bus, calls };
}

describe('V2 worker run loop', () => {
  it('checkpoints started before completing the command', async () => {
    const { bus, calls } = fakeBus(command());
    const order: string[] = [];
    const tracked: WorkerServiceBusClient = {
      ...bus,
      async sendCheckpoint(messageId, body) {
        order.push(`checkpoint:${(body as { kind: string }).kind}`);
        return bus.sendCheckpoint(messageId, body);
      },
      async completeCommand(lockToken) {
        order.push('complete');
        return bus.completeCommand(lockToken);
      },
    };

    const worker = createV2Worker({
      bus: tracked,
      execute: async () => ({ files: [] }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'document',
        }),
      },
    });

    await expect(worker.processOnce()).resolves.toBe('completed');
    expect(order.slice(0, 2)).toEqual(['checkpoint:started', 'complete']);
    expect(calls.completed).toEqual(['lock-1']);
  });

  it('puts the execution id on the started checkpoint', async () => {
    const { bus, calls } = fakeBus(command());
    const worker = createV2Worker({
      bus,
      execute: async () => ({ files: [] }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'document',
        }),
      },
    });

    await worker.processOnce();
    expect(calls.checkpoints[0]).toMatchObject({
      kind: 'started',
      checkpointSequence: 1,
      containerAppsExecutionId: 'exec-7',
    });
  });

  it('publishes a terminal result when execution throws', async () => {
    const { bus, calls } = fakeBus(command());
    const worker = createV2Worker({
      bus,
      execute: async () => {
        throw new Error('generation exploded');
      },
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'document',
        }),
      },
    });

    await expect(worker.processOnce()).resolves.toBe('failed');
    expect(calls.results).toHaveLength(1);
    expect(calls.results[0]).toMatchObject({
      kind: 'terminal',
      status: 'failed',
      failureCategory: 'internal_error',
      detail: 'generation exploded',
    });
  });

  it('uses the immutable specification deadline for the active attempt', async () => {
    const { bus, calls } = fakeBus(command());
    const resolveDeadlineMs = jest.fn(
      (specification: Record<string, unknown>) =>
        Number(specification.deadlineMs),
    );
    const worker = createV2Worker({
      bus,
      execute: async ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('document deadline elapsed');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      deadlineMs: 50,
      resolveDeadlineMs,
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'document',
          deadlineMs: 5,
        }),
      },
    } as Parameters<typeof createV2Worker>[0] & {
      resolveDeadlineMs: typeof resolveDeadlineMs;
    });

    await expect(worker.processOnce()).resolves.toBe('failed');
    expect(resolveDeadlineMs).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineMs: 5 }),
    );
    expect(calls.results).toEqual([
      expect.objectContaining({
        status: 'failed',
        failureCategory: 'progress_timeout',
        detail: 'document deadline elapsed',
      }),
    ]);
  });

  it('starts the command deadline before specification download', async () => {
    const { bus, calls } = fakeBus(
      command({
        deadlineAt: new Date(Date.now() + 10).toISOString(),
      }),
    );
    const execute = jest.fn();
    const read = jest.fn(
      async (
        _ref: unknown,
        signal?: AbortSignal,
      ): Promise<never> => {
        if (!signal) throw new Error('specification download has no abort signal');
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('specification deadline elapsed');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    );
    const worker = createV2Worker({
      bus,
      execute,
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      deadlineMs: 5_000,
      resolveCommandDeadlineMs: (receivedCommand) => {
        const deadlineAt = Date.parse(
          String((receivedCommand as { deadlineAt?: unknown }).deadlineAt),
        );
        return Math.max(1, deadlineAt - Date.now());
      },
      specifications: { read },
    } as Parameters<typeof createV2Worker>[0] & {
      resolveCommandDeadlineMs: (
        receivedCommand: Record<string, unknown>,
      ) => number;
    });

    await expect(worker.processOnce()).resolves.toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    expect(calls.results).toEqual([
      expect.objectContaining({
        status: 'failed',
        failureCategory: 'progress_timeout',
        detail: 'Execution deadline elapsed',
      }),
    ]);
  });

  it('publishes document token usage once on the terminal result', async () => {
    const { bus, calls } = fakeBus(command());
    const worker = createV2Worker({
      bus,
      execute: async () => ({
        files: [],
        durationMs: 2_500,
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 30,
          cacheWriteTokens: 4,
        },
      }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'document',
        }),
      },
    });

    await expect(worker.processOnce()).resolves.toBe('completed');
    expect(calls.results).toEqual([
      expect.objectContaining({
        status: 'completed',
        durationMs: 2_500,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
      }),
    ]);
  });

  it('preserves usage when Cursor fails after consuming tokens', async () => {
    const { bus, calls } = fakeBus(command());
    const worker = createV2Worker({
      bus,
      execute: async () => {
        throw new CursorExecutionWaitError(new Error('provider failed'), {
          inputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 1,
        });
      },
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'document',
        }),
      },
    });

    await expect(worker.processOnce()).resolves.toBe('failed');
    expect(calls.results).toEqual([
      expect.objectContaining({
        status: 'failed',
        detail: 'provider failed',
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
      }),
    ]);
  });

  /**
   * `AiRunV2FailureCategory` is a database check constraint and every value in
   * it names a transport or lifecycle event. A model that ran out of output
   * room is none of them, so it is an `internal_error` whose detail carries
   * the actionable sentence — the harvest copies that detail onto the
   * prototype row verbatim.
   */
  it('reports a truncated model response as internal_error with the message a human can act on', async () => {
    const { bus, calls } = fakeBus(command({
      workloadLane: 'visual',
      visualSubjectKind: 'design-prototype',
    }));
    const worker = createV2Worker({
      bus,
      execute: async () => {
        throw new VisualModelTruncatedError('<html><body><table', 32_000);
      },
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'visual',
        }),
      },
    });

    await expect(worker.processOnce()).resolves.toBe('failed');
    expect(calls.results).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        status: 'failed',
        artifactStatus: 'failed',
        failureCategory: 'internal_error',
        detail:
          'Model response was truncated at 32000 output tokens. '
          + 'Increase BEDROCK_UI_MOCK_MAX_TOKENS or use a more concise prompt.',
      }),
    ]);
  });

  /**
   * Re-running the same specification against the same ceiling truncates
   * again, so a truncated attempt must settle rather than come back. The
   * command is already completed, and one terminal result closes the attempt;
   * only the reconciler's confirmed-worker-loss path dispatches a replacement,
   * and that needs a missing worker, not a finished one.
   */
  it('settles a truncated attempt instead of leaving it to be redelivered', async () => {
    const { bus, calls } = fakeBus(command({
      workloadLane: 'visual',
      visualSubjectKind: 'design-prototype',
    }));
    const worker = createV2Worker({
      bus,
      execute: async () => {
        throw new VisualModelTruncatedError('<html><body><table', 32_000);
      },
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: {
        read: async () => ({
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          workloadLane: 'visual',
        }),
      },
    });

    await worker.processOnce();

    expect(calls.completed).toEqual(['lock-1']);
    expect(calls.abandoned).toEqual([]);
    expect(calls.deadLettered).toEqual([]);
    expect(calls.results).toHaveLength(1);
  });

  it('dead-letters a malformed command once deliveries are exhausted', async () => {
    const { bus, calls } = fakeBus({ kind: 'not_a_command' }, 5);
    const worker = createV2Worker({
      bus,
      execute: async () => ({ files: [] }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: { read: async () => ({}) as never },
    });

    await expect(worker.processOnce()).resolves.toBe('poison');
    expect(calls.deadLettered).toEqual(['lock-1:poison_message']);
    expect(calls.results).toEqual([]);
  });

  it('abandons a malformed command while deliveries remain', async () => {
    const { bus, calls } = fakeBus({ kind: 'not_a_command' }, 1);
    const worker = createV2Worker({
      bus,
      execute: async () => ({ files: [] }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      specifications: { read: async () => ({}) as never },
    });

    await expect(worker.processOnce()).resolves.toBe('redeliver');
    expect(calls.abandoned).toEqual(['lock-1']);
    expect(calls.deadLettered).toEqual([]);
  });

  it('reports no work when the queue is empty', async () => {
    const { bus } = fakeBus(null);
    const worker = createV2Worker({
      bus,
      execute: async () => ({ files: [] }),
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
    });

    await expect(worker.processOnce()).resolves.toBe('idle');
  });
});
