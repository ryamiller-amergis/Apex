import { createOutboxDrainer } from '../../services/aiOrchestrator/outboxDrainer';
import type { OutboxRow } from '../../services/aiRunV2/outboxRepository';
import { emptyUtilization } from '../../services/aiOrchestrator/providerGovernor';
import { createUtilizationReader } from '../../services/aiOrchestrator/utilizationReader';
import type { HeldDistributedLease } from '../../services/aiRunV2/distributedLeaseRepository';

function row(id: string, payload: Record<string, unknown> = {}): OutboxRow {
  return {
    id,
    idempotencyKey: `${id}:dispatch`,
    kind: 'dispatch_command',
    runId: 'run-1',
    attemptId: 'attempt-1',
    payload: {
      workloadLane: 'document',
      capacityClass: 'batch',
      dispatchMessageId: id,
      ...payload,
    },
    availableAt: '2026-09-18T12:00:00.000Z',
    claimedBy: 'drainer',
    claimedAt: '2026-09-18T12:00:00.000Z',
    claimExpiresAt: '2026-09-18T12:01:00.000Z',
    publishAttempts: 1,
    lastError: null,
    publishedAt: null,
    createdAt: '2026-09-18T12:00:00.000Z',
  };
}

describe('outboxDrainer', () => {
  function lease(): HeldDistributedLease {
    return {
      leaseKey: 'outbox',
      holderId: 'test',
      fencingToken: 1n,
      signal: new AbortController().signal,
      assertOwned: async () => undefined,
      release: async () => undefined,
    };
  }

  it('publishes allowed claims and marks them published', async () => {
    const published: string[] = [];
    const failed: string[] = [];
    const publishBodies: unknown[] = [];

    const fakeLease = {
      leaseKey: 'outbox' as const,
      holderId: 'test',
      fencingToken: 1n,
      signal: new AbortController().signal,
      assertOwned: async () => undefined,
      release: async () => undefined,
    } satisfies HeldDistributedLease;

    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: {
        publish: async (req) => {
          publishBodies.push(req.body);
        },
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(fakeLease),
      outbox: {
        enqueue: async () => [],
        claimBatch: async () => [row('msg-1')],
        markPublished: async (ids) => {
          published.push(...ids);
          return ids.length;
        },
        markFailed: async (id) => {
          failed.push(id);
          return true;
        },
      },
    });

    const count = await drainer.drainOnce();
    expect(count).toBe(1);
    expect(published).toEqual(['msg-1']);
    expect(failed).toEqual([]);
    expect(publishBodies).toHaveLength(1);
  });

  it('routes each workload lane to its own command queue', async () => {
    const queues: string[] = [];
    const fakeLease = {
      leaseKey: 'outbox' as const,
      holderId: 'test',
      fencingToken: 1n,
      signal: new AbortController().signal,
      assertOwned: async () => undefined,
      release: async () => undefined,
    } satisfies HeldDistributedLease;

    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: {
        publish: async (req) => {
          queues.push(req.queueName);
        },
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(fakeLease),
      outbox: {
        enqueue: async () => [],
        claimBatch: async () => [
          row('msg-doc', { workloadLane: 'document' }),
          row('msg-vis', {
            workloadLane: 'visual',
            capacityClass: 'batch',
          }),
          row('msg-fast', { workloadLane: 'fast' }),
          row('msg-agent', { workloadLane: 'agentic' }),
        ],
        markPublished: async (ids) => ids.length,
        markFailed: async () => true,
      },
    });

    await drainer.drainOnce();
    expect(queues).toEqual([
      'ai-runs-v2-document',
      'ai-runs-v2-visual',
      'ai-runs-v2-fast',
      'ai-runs-v2-agentic',
    ]);
  });

  it('refuses to guess a queue when the command carries no workload lane', async () => {
    const failed: string[] = [];
    const published: string[] = [];
    const fakeLease = {
      leaseKey: 'outbox' as const,
      holderId: 'test',
      fencingToken: 1n,
      signal: new AbortController().signal,
      assertOwned: async () => undefined,
      release: async () => undefined,
    } satisfies HeldDistributedLease;

    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: {
        publish: async (req) => {
          published.push(req.queueName);
        },
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(fakeLease),
      outbox: {
        enqueue: async () => [],
        claimBatch: async () => [row('msg-3', { workloadLane: undefined })],
        markPublished: async () => 0,
        markFailed: async (id, _holder, reason) => {
          failed.push(`${id}:${reason}`);
          return true;
        },
      },
    });

    await drainer.drainOnce();
    expect(published).toEqual([]);
    expect(failed[0]).toContain('unknown_lane');
  });

  it('marks failed when uncertain workers pause admission', async () => {
    const failed: string[] = [];
    const fakeLease = {
      leaseKey: 'outbox' as const,
      holderId: 'test',
      fencingToken: 1n,
      signal: new AbortController().signal,
      assertOwned: async () => undefined,
      release: async () => undefined,
    } satisfies HeldDistributedLease;

    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: async () => undefined },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 2,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(fakeLease),
      outbox: {
        enqueue: async () => [],
        claimBatch: async () => [row('msg-2')],
        markPublished: async () => 0,
        markFailed: async (id, _holder, reason) => {
          failed.push(`${id}:${reason}`);
          return true;
        },
      },
    });

    const count = await drainer.drainOnce();
    expect(count).toBe(0);
    expect(failed[0]).toContain('uncertain_workers_paused');
  });

  it('publishes the first batch visual command without counting its unpublished attempt', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const utilization = createUtilizationReader({
      executor: {
        execute: async () => ({
          rows: [
            {
              attempt_status: 'dispatched',
              published_at: null,
              workload_lane: 'visual',
              capacity_class: 'batch',
            },
          ],
        }),
      },
    });
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      getUtilization: () => utilization.read(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: {
        enqueue: async () => [],
        claimBatch: async () => [
          row('prototype-1', {
            workloadLane: 'visual',
            capacityClass: 'batch',
          }),
        ],
        markPublished: async (ids) => ids.length,
        markFailed: async () => true,
      },
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes two interactive visual commands without self-counting either attempt', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const utilization = createUtilizationReader({
      executor: {
        execute: async () => ({
          rows: [
            {
              attempt_status: 'dispatched',
              published_at: null,
              workload_lane: 'visual',
              capacity_class: 'interactive',
            },
            {
              attempt_status: 'dispatched',
              published_at: null,
              workload_lane: 'visual',
              capacity_class: 'interactive',
            },
          ],
        }),
      },
    });
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      getUtilization: () => utilization.read(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: {
        enqueue: async () => [],
        claimBatch: async () => [
          row('interactive-1', {
            workloadLane: 'visual',
            capacityClass: 'interactive',
          }),
          row('interactive-2', {
            workloadLane: 'visual',
            capacityClass: 'interactive',
          }),
        ],
        markPublished: async (ids) => ids.length,
        markFailed: async () => true,
      },
    });

    await expect(drainer.drainOnce()).resolves.toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
