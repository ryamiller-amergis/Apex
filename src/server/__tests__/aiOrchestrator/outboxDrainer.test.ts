import { createOutboxDrainer } from '../../services/aiOrchestrator/outboxDrainer';
import type {
  OutboxRepository,
  OutboxRow,
} from '../../services/aiRunV2/outboxRepository';
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

function interactiveRow(
  id: string,
  interactiveClass: 'fast' | 'agentic' = 'fast',
  deadlineAt = '2026-09-23T15:05:00.000Z',
): OutboxRow {
  return {
    ...row(id),
    idempotencyKey: `${id}:interactive-dispatch`,
    kind: 'interactive_dispatch',
    payload: {
      schemaVersion: 2,
      kind: 'interactive_dispatch',
      transport: 'dapr-actor-v2',
      runId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      attemptNumber: 1,
      dispatchMessageId: '33333333-3333-4333-8333-333333333333',
      threadId: '44444444-4444-4444-8444-444444444444',
      userId: 'user-1',
      interactiveClass,
      workloadLane: interactiveClass,
      capacityClass: 'interactive',
      deadlineAt,
    },
  };
}

function fakeOutbox(
  overrides: Partial<OutboxRepository> = {},
): OutboxRepository {
  return {
    enqueue: async () => [],
    claimBatch: async () => [],
    claimInteractiveCandidates: async () => [],
    markPublished: async (ids) => ids.length,
    markFailed: async () => true,
    releaseClaim: async () => true,
    ...overrides,
  };
}

function noInteractiveDeps() {
  return {
    interactiveDispatchClient: {
      dispatch: async () => undefined,
    },
    attempts: {
      readInteractiveDispatchState: async () => 'not-found' as const,
      markInteractiveDispatched: async () => 'not-found' as const,
      failExpiredInteractiveDispatch: async () => undefined,
    },
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
      ...noInteractiveDeps(),
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
      outbox: fakeOutbox({
        claimBatch: async () => [row('msg-1')],
        markPublished: async (ids) => {
          published.push(...ids);
          return ids.length;
        },
        markFailed: async (id) => {
          failed.push(id);
          return true;
        },
      }),
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
      ...noInteractiveDeps(),
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
      outbox: fakeOutbox({
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
      }),
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
      ...noInteractiveDeps(),
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
      outbox: fakeOutbox({
        claimBatch: async () => [row('msg-3', { workloadLane: undefined })],
        markPublished: async () => 0,
        markFailed: async (id, _holder, reason) => {
          failed.push(`${id}:${reason}`);
          return true;
        },
      }),
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
      ...noInteractiveDeps(),
      executor: { execute: async () => [] },
      publisher: { publish: async () => undefined },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 2,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(fakeLease),
      outbox: fakeOutbox({
        claimBatch: async () => [row('msg-2')],
        markPublished: async () => 0,
        markFailed: async (id, _holder, reason) => {
          failed.push(`${id}:${reason}`);
          return true;
        },
      }),
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
              transport_version: 'servicebus-blob-v2',
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
      ...noInteractiveDeps(),
      executor: { execute: async () => [] },
      publisher: { publish },
      getUtilization: () => utilization.read(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimBatch: async () => [
          row('prototype-1', {
            workloadLane: 'visual',
            capacityClass: 'batch',
          }),
        ],
        markPublished: async (ids) => ids.length,
        markFailed: async () => true,
      }),
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
              transport_version: 'servicebus-blob-v2',
              attempt_status: 'dispatched',
              published_at: null,
              workload_lane: 'visual',
              capacity_class: 'interactive',
            },
            {
              transport_version: 'servicebus-blob-v2',
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
      ...noInteractiveDeps(),
      executor: { execute: async () => [] },
      publisher: { publish },
      getUtilization: () => utilization.read(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
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
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('dispatches interactive work directly without publishing to Service Bus', async () => {
    const publish = jest.fn().mockResolvedValue(undefined);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markInteractiveDispatched = jest
      .fn()
      .mockResolvedValue('dispatched');
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched,
        failExpiredInteractiveDispatch: async () => undefined,
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => new Date('2026-09-23T15:00:00.000Z'),
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: async () => [
          interactiveRow('interactive-fast'),
        ],
        markPublished,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(markInteractiveDispatched).toHaveBeenCalledWith({
      attemptId: '22222222-2222-4222-8222-222222222222',
      expectedDispatchMessageId: '33333333-3333-4333-8333-333333333333',
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ interactiveClass: 'fast' }),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledWith(
      ['interactive-fast'],
      expect.any(String),
    );
  });

  it('releases the seventeenth queued turn for five seconds without invoking it', async () => {
    const utilization = emptyUtilization();
    const releaseClaim = jest.fn().mockResolvedValue(true);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markInteractiveDispatched = jest.fn();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched,
        failExpiredInteractiveDispatch: async () => undefined,
      },
      getUtilization: async () => ({
        ...utilization,
        cursorInFlight: 16,
        laneInFlight: {
          ...utilization.laneInFlight,
          fast: 8,
          agentic: 8,
        },
        providerClassInFlight: {
          ...utilization.providerClassInFlight,
          cursor: { batch: 0, interactive: 16 },
        },
      }),
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => new Date('2026-09-23T15:00:00.000Z'),
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: async () => [
          interactiveRow('interactive-17'),
        ],
        releaseClaim,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(releaseClaim).toHaveBeenCalledWith(
      'interactive-17',
      expect.any(String),
      '2026-09-23T15:00:05.000Z',
      'interactive_cap',
    );
    expect(markInteractiveDispatched).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('replays the same fenced invocation after a lost actor response', async () => {
    const dispatch = jest
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(undefined);
    const state = jest
      .fn()
      .mockResolvedValueOnce('queued')
      .mockResolvedValueOnce('dispatched')
      .mockResolvedValueOnce('dispatched');
    const markInteractiveDispatched = jest
      .fn()
      .mockResolvedValueOnce('dispatched')
      .mockResolvedValueOnce('already-dispatched');
    const markFailed = jest.fn().mockResolvedValue(true);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    let utilizationReads = 0;
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: state,
        markInteractiveDispatched,
        failExpiredInteractiveDispatch: async () => undefined,
      },
      getUtilization: async () => {
        const utilization = emptyUtilization();
        utilizationReads += 1;
        if (utilizationReads === 1) return utilization;
        return {
          ...utilization,
          cursorInFlight: 16,
          laneInFlight: {
            ...utilization.laneInFlight,
            fast: 8,
            agentic: 8,
          },
        };
      },
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => new Date('2026-09-23T15:00:00.000Z'),
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: async () => [
          interactiveRow('interactive-replay'),
        ],
        markFailed,
        markPublished,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    await expect(drainer.drainOnce()).resolves.toBe(1);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toEqual(dispatch.mock.calls[1][0]);
    expect(markFailed).toHaveBeenCalledWith(
      'interactive-replay',
      expect.any(String),
      'response lost',
      10_000,
    );
    expect(markPublished).toHaveBeenCalledTimes(1);
  });

  it('terminalizes an expired turn without invoking either transport', async () => {
    const publish = jest.fn();
    const dispatch = jest.fn();
    const failExpiredInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(undefined);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: jest.fn(),
        failExpiredInteractiveDispatch,
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => new Date('2026-09-23T15:00:00.000Z'),
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: async () => [
          interactiveRow(
            'interactive-expired',
            'agentic',
            '2026-09-23T15:00:00.000Z',
          ),
        ],
        markPublished,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(failExpiredInteractiveDispatch).toHaveBeenCalledWith({
      attemptId: '22222222-2222-4222-8222-222222222222',
      expectedDispatchMessageId: '33333333-3333-4333-8333-333333333333',
      detail: 'Interactive turn exceeded its absolute deadline',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledWith(
      ['interactive-expired'],
      expect.any(String),
    );
  });

  it('publishes a terminal replay without invoking the actor again', async () => {
    const dispatch = jest.fn();
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'terminal',
        markInteractiveDispatched: jest.fn(),
        failExpiredInteractiveDispatch: jest.fn(),
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: async () => [
          interactiveRow('interactive-terminal'),
        ],
        markPublished,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledWith(
      ['interactive-terminal'],
      expect.any(String),
    );
  });

  it('does not invoke when an already-dispatched attempt became terminal', async () => {
    const dispatch = jest.fn();
    const readInteractiveDispatchState = jest
      .fn()
      .mockResolvedValueOnce('dispatched')
      .mockResolvedValueOnce('terminal');
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState,
        markInteractiveDispatched: async () => 'already-dispatched',
        failExpiredInteractiveDispatch: jest.fn(),
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => new Date('2026-09-23T15:00:00.000Z'),
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: async () => [
          interactiveRow('interactive-terminal-race'),
        ],
        markPublished,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(readInteractiveDispatchState).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
