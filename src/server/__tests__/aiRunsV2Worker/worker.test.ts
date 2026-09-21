import { AI_RUN_V2_SCHEMA_VERSION } from '../../../shared/types/aiRunV2';
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
