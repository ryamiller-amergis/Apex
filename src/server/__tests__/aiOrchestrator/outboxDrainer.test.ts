import { createOutboxDrainer } from '../../services/aiOrchestrator/outboxDrainer';
import { createInteractiveActorDispatchClient } from '../../services/aiOrchestrator/interactiveActorDispatchClient';
import type {
  OutboxRepository,
  OutboxRow,
} from '../../services/aiRunV2/outboxRepository';
import type { InteractiveTerminalizeResult } from '../../services/aiRunV2/runAttemptRepository';
import { emptyUtilization } from '../../services/aiOrchestrator/providerGovernor';
import { createUtilizationReader } from '../../services/aiOrchestrator/utilizationReader';
import type { HeldDistributedLease } from '../../services/aiRunV2/distributedLeaseRepository';
import { MAX_OUTBOX_DRAIN_PAGES } from '../../services/aiOrchestrator/types';

function terminalizedResult(
  priorAttemptStatus:
    | 'queued'
    | 'dispatched'
    | 'running' = 'queued',
): InteractiveTerminalizeResult {
  return {
    outcome: 'terminalized',
    priorAttemptStatus,
    capacityCharged:
      priorAttemptStatus === 'dispatched' ||
      priorAttemptStatus === 'running',
  };
}

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
  payloadOverrides: Record<string, unknown> = {},
): OutboxRow {
  return {
    ...row(id),
    idempotencyKey: `${id}:interactive-dispatch`,
    kind: 'interactive_dispatch',
    runId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
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
      ...payloadOverrides,
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
    markDiscarded: async () => true,
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
      failExpiredInteractiveDispatch: async () =>
        ({ outcome: 'not-found' }) as const,
      failInvalidInteractiveDispatch: async () =>
        ({ outcome: 'not-found' }) as const,
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
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
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
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        deadlineAt: '2026-09-23T15:05:00.000Z',
      }),
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
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...utilization,
        cursorInFlight: 16,
        interactiveClassInFlight: {
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
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => {
        const utilization = emptyUtilization();
        utilizationReads += 1;
        if (utilizationReads === 1) return utilization;
        return {
          ...utilization,
          cursorInFlight: 16,
          interactiveClassInFlight: {
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
      .mockResolvedValue(terminalizedResult());
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: jest.fn(),
        failExpiredInteractiveDispatch,
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
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
        markDiscarded,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(failExpiredInteractiveDispatch).toHaveBeenCalledWith({
      attemptId: '22222222-2222-4222-8222-222222222222',
      expectedDispatchMessageId: '33333333-3333-4333-8333-333333333333',
      detail: 'Interactive turn exceeded its absolute deadline',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(markDiscarded).toHaveBeenCalledWith(
      'interactive-expired',
      expect.any(String),
      'deadline_expired',
    );
    expect(markPublished).not.toHaveBeenCalled();
  });

  it('publishes a terminal replay without invoking the actor again', async () => {
    const dispatch = jest.fn();
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'terminal',
        markInteractiveDispatched: jest.fn(),
        failExpiredInteractiveDispatch: jest.fn(),
        failInvalidInteractiveDispatch: jest.fn(),
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
        markDiscarded,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(markPublished).toHaveBeenCalledWith(
      ['interactive-terminal'],
      expect.any(String),
    );
    expect(markDiscarded).not.toHaveBeenCalled();
  });

  it('gives a floor-eligible Dapr turn the last shared Cursor slot before background planning', async () => {
    const base = emptyUtilization();
    const publish = jest.fn();
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markFailed = jest.fn().mockResolvedValue(true);
    const claimBatch = jest
      .fn()
      .mockResolvedValueOnce([row('background')])
      .mockResolvedValue([]);
    const claimInteractiveCandidates = jest
      .fn()
      .mockResolvedValueOnce([interactiveRow('direct-fast')])
      .mockResolvedValue([]);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 19,
        laneInFlight: {
          ...base.laneInFlight,
          document: 17,
        },
        interactiveClassInFlight: { fast: 1, agentic: 1 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
          cursor: { batch: 17, interactive: 2 },
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
        claimBatch,
        claimInteractiveCandidates,
        markFailed,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      'background',
      expect.any(String),
      'provider_cap',
      5_000,
    );
  });

  it('rechecks the clock before each invocation and terminalizes a row that expires between turns', async () => {
    let nowMs = Date.parse('2026-09-23T15:00:00.000Z');
    const dispatch = jest.fn().mockImplementation(async () => {
      nowMs = Date.parse('2026-09-23T15:02:00.000Z');
    });
    const failExpiredInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(terminalizedResult());
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch,
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => new Date(nowMs),
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([
            interactiveRow(
              'a-first',
              'fast',
              '2026-09-23T15:05:00.000Z',
            ),
            interactiveRow(
              'b-expired',
              'agentic',
              '2026-09-23T15:01:00.000Z',
            ),
          ])
          .mockResolvedValue([]),
        markDiscarded,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(failExpiredInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(markDiscarded).toHaveBeenCalledWith(
      'b-expired',
      expect.any(String),
      'deadline_expired',
    );
  });

  it('aborts a hanging fetch at its remaining deadline and continues with the next row', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-23T15:00:00.000Z'));
    try {
      const fetchImpl = jest
        .fn()
        .mockImplementationOnce(
          () => new Promise<Response>(() => undefined),
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 202,
          json: async () => ({ accepted: true }),
        } as Response);
      const client = createInteractiveActorDispatchClient({
        fastUrl: 'https://fast.example',
        agenticUrl: 'https://agentic.example',
        fetchImpl,
      });
      const failExpiredInteractiveDispatch = jest
        .fn()
        .mockResolvedValue(terminalizedResult());
      const markDiscarded = jest.fn().mockResolvedValue(true);
      const markPublished = jest.fn(async (ids: string[]) => ids.length);
      const drainer = createOutboxDrainer({
        executor: { execute: async () => [] },
        publisher: { publish: jest.fn() },
        interactiveDispatchClient: client,
        attempts: {
          readInteractiveDispatchState: async () => 'queued',
          markInteractiveDispatched: async () => 'dispatched',
          failExpiredInteractiveDispatch,
          failInvalidInteractiveDispatch: async () => terminalizedResult(),
        },
        getUtilization: async () => emptyUtilization(),
        getUncertainWorkerCount: async () => 0,
        clock: {
          now: () => new Date(Date.now()),
          sleep: async () => undefined,
        },
        enableNotify: false,
        acquireOutboxLease: async (work) => work(lease()),
        outbox: fakeOutbox({
          claimInteractiveCandidates: jest
            .fn()
            .mockResolvedValueOnce([
              interactiveRow(
                'a-hanging',
                'fast',
                '2026-09-23T15:00:01.000Z',
              ),
              interactiveRow(
                'b-next',
                'fast',
                '2026-09-23T15:05:00.000Z',
              ),
            ])
            .mockResolvedValue([]),
          markDiscarded,
          markPublished,
        }),
      });

      const pending = drainer.drainOnce();
      for (
        let spin = 0;
        spin < 20 && fetchImpl.mock.calls.length === 0;
        spin += 1
      ) {
        await Promise.resolve();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toBe(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(failExpiredInteractiveDispatch).toHaveBeenCalledTimes(1);
      expect(markDiscarded).toHaveBeenCalledWith(
        'a-hanging',
        expect.any(String),
        'deadline_expired',
      );
      expect(markPublished).toHaveBeenCalledWith(
        ['b-next'],
        expect.any(String),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('refills under the same lease after a stale bounded window', async () => {
    const base = emptyUtilization();
    const staleRows = Array.from({ length: 20 }, (_, index) =>
      interactiveRow(`stale-${String(index).padStart(2, '0')}`),
    );
    const claimInteractiveCandidates = jest
      .fn()
      .mockResolvedValueOnce(staleRows)
      .mockResolvedValueOnce([interactiveRow('valid-after-stale')])
      .mockResolvedValue([]);
    const readInteractiveDispatchState = jest
      .fn()
      .mockResolvedValueOnce('not-found');
    for (let index = 1; index < staleRows.length; index += 1) {
      readInteractiveDispatchState.mockResolvedValueOnce('not-found');
    }
    readInteractiveDispatchState.mockResolvedValueOnce('queued');
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const publish = jest.fn();
    const markFailed = jest.fn().mockResolvedValue(true);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState,
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 19,
        laneInFlight: {
          ...base.laneInFlight,
          document: 17,
        },
        interactiveClassInFlight: { fast: 1, agentic: 1 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
          cursor: { batch: 17, interactive: 2 },
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
        claimBatch: jest
          .fn()
          .mockResolvedValueOnce([row('background-behind-stale')])
          .mockResolvedValue([]),
        claimInteractiveCandidates,
        markDiscarded,
        markFailed,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(claimInteractiveCandidates).toHaveBeenCalledTimes(3);
    expect(markDiscarded).toHaveBeenCalledTimes(20);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      'background-behind-stale',
      expect.any(String),
      'provider_cap',
      5_000,
    );
  });

  it('bounds refill pages when every claimed row is malformed', async () => {
    const claimInteractiveCandidates = jest
      .fn()
      .mockImplementation(async () => {
        const page = claimInteractiveCandidates.mock.calls.length;
        return [
          {
            ...interactiveRow(`malformed-${page}`),
            attemptId: null,
            payload: { kind: 'interactive_dispatch', page },
          } satisfies OutboxRow,
        ];
      });
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch: jest.fn() },
      attempts: {
        readInteractiveDispatchState: jest.fn(),
        markInteractiveDispatched: jest.fn(),
        failExpiredInteractiveDispatch: jest.fn(),
        failInvalidInteractiveDispatch: jest.fn(),
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(claimInteractiveCandidates).toHaveBeenCalledTimes(
      MAX_OUTBOX_DRAIN_PAGES,
    );
  });

  it('durably discards malformed, missing, and stale dispatches without success publication', async () => {
    const malformedSafe = interactiveRow('malformed-safe');
    malformedSafe.payload.capacityClass = 'batch';
    const malformedUnsafe = {
      ...interactiveRow('malformed-unsafe'),
      attemptId: null,
      payload: { kind: 'interactive_dispatch' },
    } satisfies OutboxRow;
    const missing = interactiveRow('missing');
    const stale = interactiveRow('stale');
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const failInvalidInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(terminalizedResult());
    const readInteractiveDispatchState = jest
      .fn()
      .mockResolvedValueOnce('not-found')
      .mockResolvedValueOnce('fence-mismatch');
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch: jest.fn() },
      attempts: {
        readInteractiveDispatchState,
        markInteractiveDispatched: jest.fn(),
        failExpiredInteractiveDispatch: jest.fn(),
        failInvalidInteractiveDispatch,
      },
      getUtilization: async () => emptyUtilization(),
      getUncertainWorkerCount: async () => 0,
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([
            malformedSafe,
            malformedUnsafe,
            missing,
            stale,
          ])
          .mockResolvedValue([]),
        markPublished,
        markDiscarded,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(failInvalidInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(markDiscarded.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'malformed-safe',
          expect.any(String),
          'invalid_payload',
        ],
        [
          'malformed-unsafe',
          expect.any(String),
          'invalid_payload',
        ],
        ['missing', expect.any(String), 'attempt_not_found'],
        ['stale', expect.any(String), 'fence_mismatch'],
      ]),
    );
    expect(markPublished).not.toHaveBeenCalled();
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
        failInvalidInteractiveDispatch: jest.fn(),
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

  it('refills a freed planner slot before claiming deeper work on the next page', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-23T15:00:00.000Z'));
    try {
      const hanging = {
        ...interactiveRow(
          'hanging-selected',
          'fast',
          '2026-09-23T15:00:03.000Z',
        ),
        createdAt: '2026-09-23T15:00:00.000Z',
      };
      const deferred = {
        ...interactiveRow(
          'deferred-seen',
          'fast',
          '2026-09-23T15:10:00.000Z',
        ),
        createdAt: '2026-09-23T15:00:01.000Z',
      };
      const deeper = {
        ...interactiveRow(
          'deeper-valid',
          'fast',
          '2026-09-23T15:10:00.000Z',
        ),
        createdAt: '2026-09-23T15:00:02.000Z',
      };
      const claims = new Map<
        string,
        { claimedBy: string | null; claimExpiresAt: string | null }
      >();
      const releaseClaim = jest.fn(
        async (
          id: string,
          _holderId: string,
          _availableAt: string,
          _detail: string,
        ) => {
          claims.set(id, { claimedBy: null, claimExpiresAt: null });
          return true;
        },
      );
      const claimInteractiveCandidates = jest.fn(
        async (
          _globalLimit: number,
          _perClassFloorLimit: number,
          holderId: string,
          _claimMs: number,
          excludeIds: readonly string[] = [],
        ) => {
          const excluded = new Set(excludeIds);
          const page = claimInteractiveCandidates.mock.calls.length;
          if (page === 1) {
            for (const row of [hanging, deferred]) {
              claims.set(row.id, {
                claimedBy: holderId,
                claimExpiresAt: '2026-09-23T15:00:30.000Z',
              });
            }
            return [hanging, deferred];
          }
          if (page === 2) {
            expect(excluded.has('hanging-selected')).toBe(true);
            expect(excluded.has('deferred-seen')).toBe(true);
            expect(excluded.has('deeper-valid')).toBe(false);
            claims.set(deeper.id, {
              claimedBy: holderId,
              claimExpiresAt: '2026-09-23T15:00:35.000Z',
            });
            return [deeper];
          }
          return [];
        },
      );
      const fetchImpl = jest
        .fn()
        .mockImplementationOnce(
          () => new Promise<Response>(() => undefined),
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ accepted: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const markPublished = jest.fn(async (ids: string[]) => {
        for (const id of ids) {
          claims.set(id, { claimedBy: null, claimExpiresAt: null });
        }
        return ids.length;
      });
      const markDiscarded = jest.fn(async (id: string) => {
        claims.set(id, { claimedBy: null, claimExpiresAt: null });
        return true;
      });
      const failExpiredInteractiveDispatch = jest
        .fn()
        .mockResolvedValue(terminalizedResult());
      const base = emptyUtilization();
      const drainer = createOutboxDrainer({
        executor: { execute: async () => [] },
        publisher: { publish: jest.fn() },
        interactiveDispatchClient: createInteractiveActorDispatchClient({
          fastUrl: 'https://fast.example',
          agenticUrl: 'https://agentic.example',
          fetchImpl,
        }),
        attempts: {
          readInteractiveDispatchState: async () => 'queued',
          markInteractiveDispatched: async () => 'dispatched',
          failExpiredInteractiveDispatch,
          failInvalidInteractiveDispatch: async () => terminalizedResult(),
        },
        getUtilization: async () => ({
          ...base,
          cursorInFlight: 15,
          interactiveClassInFlight: { fast: 15, agentic: 0 },
          providerClassInFlight: {
            ...base.providerClassInFlight,
            cursor: { batch: 0, interactive: 15 },
          },
        }),
        getUncertainWorkerCount: async () => 0,
        clock: {
          now: () => new Date(jest.now()),
          sleep: async () => undefined,
        },
        enableNotify: false,
        acquireOutboxLease: async (work) => work(lease()),
        outbox: fakeOutbox({
          claimInteractiveCandidates,
          releaseClaim,
          markPublished,
          markDiscarded,
        }),
      });

      const pending = drainer.drainOnce();
      for (
        let spin = 0;
        spin < 40 && fetchImpl.mock.calls.length === 0;
        spin += 1
      ) {
        await Promise.resolve();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // Waiters stay claimed until the in-flight selected row finishes so a
      // freed planner slot can refill them in the same drain.
      expect(releaseClaim).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBe(1);

      expect(failExpiredInteractiveDispatch).toHaveBeenCalledTimes(1);
      expect(markDiscarded).toHaveBeenCalledWith(
        'hanging-selected',
        expect.any(String),
        'deadline_expired',
      );
      expect(claimInteractiveCandidates).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(markPublished).toHaveBeenCalledWith(
        ['deferred-seen'],
        expect.any(String),
      );
      expect(releaseClaim).toHaveBeenCalledWith(
        'deeper-valid',
        expect.any(String),
        expect.any(String),
        'interactive_cap',
      );
      expect(claims.get('deferred-seen')).toEqual({
        claimedBy: null,
        claimExpiresAt: null,
      });
      expect(claims.get('hanging-selected')).toEqual({
        claimedBy: null,
        claimExpiresAt: null,
      });
      expect(claims.get('deeper-valid')).toEqual({
        claimedBy: null,
        claimExpiresAt: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not free a saturated slot for a first-read terminal leftover ACK', async () => {
    const terminalLeftover = {
      ...interactiveRow(
        'terminal-leftover-ack',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-should-defer',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const releaseClaim = jest.fn().mockResolvedValue(true);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: jest
          .fn()
          .mockResolvedValueOnce('terminal')
          .mockResolvedValueOnce('queued'),
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 16,
        interactiveClassInFlight: { fast: 16, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([terminalLeftover, queuedWaiter])
          .mockResolvedValue([]),
        markPublished,
        releaseClaim,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(markPublished).toHaveBeenCalledWith(
      ['terminal-leftover-ack'],
      expect.any(String),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith(
      'waiter-should-defer',
      expect.any(String),
      expect.any(String),
      'interactive_cap',
    );
  });

  it('does not free a slot when queued malformed terminalization succeeds', async () => {
    const malformedQueued = {
      ...interactiveRow(
        'malformed-queued',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
      payload: {
        ...interactiveRow('malformed-queued', 'fast', '2026-09-23T15:10:00.000Z', {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }).payload,
        capacityClass: 'batch',
      },
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-queued-malformed',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const releaseClaim = jest.fn().mockResolvedValue(true);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const failInvalidInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(terminalizedResult('queued'));
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch,
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 16,
        interactiveClassInFlight: { fast: 16, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([malformedQueued, queuedWaiter])
          .mockResolvedValue([]),
        markDiscarded,
        releaseClaim,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(failInvalidInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(markDiscarded).toHaveBeenCalledWith(
      'malformed-queued',
      expect.any(String),
      'invalid_payload',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith(
      'waiter-after-queued-malformed',
      expect.any(String),
      expect.any(String),
      'interactive_cap',
    );
  });

  it('does not free a slot on malformed fence mismatch with a live replacement', async () => {
    const malformedStale = {
      ...interactiveRow(
        'malformed-stale-fence',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
      payload: {
        ...interactiveRow(
          'malformed-stale-fence',
          'fast',
          '2026-09-23T15:10:00.000Z',
          {
            attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        ).payload,
        capacityClass: 'batch',
      },
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-fence-mismatch',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const releaseClaim = jest.fn().mockResolvedValue(true);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const failInvalidInteractiveDispatch = jest
      .fn()
      .mockResolvedValue({ outcome: 'fence-mismatch' } as const);
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch,
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 16,
        interactiveClassInFlight: { fast: 16, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([malformedStale, queuedWaiter])
          .mockResolvedValue([]),
        markDiscarded,
        releaseClaim,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(failInvalidInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(markDiscarded).toHaveBeenCalledWith(
      'malformed-stale-fence',
      expect.any(String),
      'invalid_payload',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith(
      'waiter-after-fence-mismatch',
      expect.any(String),
      expect.any(String),
      'interactive_cap',
    );
  });

  it('frees exactly one charged dispatched slot and dispatches one waiter', async () => {
    const chargedMalformed = {
      ...interactiveRow(
        'malformed-charged-dispatched',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
      payload: {
        ...interactiveRow(
          'malformed-charged-dispatched',
          'fast',
          '2026-09-23T15:10:00.000Z',
          {
            attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
        ).payload,
        capacityClass: 'batch',
      },
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-charged-free',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const failInvalidInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(terminalizedResult('dispatched'));
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch,
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 16,
        interactiveClassInFlight: { fast: 16, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([chargedMalformed, queuedWaiter])
          .mockResolvedValue([]),
        markPublished,
        markDiscarded,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(failInvalidInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(markDiscarded).toHaveBeenCalledWith(
      'malformed-charged-dispatched',
      expect.any(String),
      'invalid_payload',
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(
      ['waiter-after-charged-free'],
      expect.any(String),
    );
  });

  it('does not double-release the same charged attempt in one drain', async () => {
    const chargedAttemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const chargedDispatchMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const chargedPayload = {
      attemptId: chargedAttemptId,
      dispatchMessageId: chargedDispatchMessageId,
    };
    const expiredCharged = {
      ...interactiveRow(
        'expired-charged',
        'fast',
        '2026-09-23T14:59:00.000Z',
        chargedPayload,
      ),
      attemptId: chargedAttemptId,
      createdAt: '2026-09-23T15:00:00.000Z',
    };
    const malformedSameAttempt = {
      ...interactiveRow(
        'malformed-same-attempt',
        'fast',
        '2026-09-23T15:10:00.000Z',
        chargedPayload,
      ),
      attemptId: chargedAttemptId,
      createdAt: '2026-09-23T15:00:01.000Z',
      payload: {
        ...interactiveRow(
          'malformed-same-attempt',
          'fast',
          '2026-09-23T15:10:00.000Z',
          chargedPayload,
        ).payload,
        capacityClass: 'batch',
      },
    };
    const firstWaiter = {
      ...interactiveRow(
        'first-waiter',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:02.000Z',
    };
    const secondWaiter = {
      ...interactiveRow(
        'second-waiter',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          dispatchMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        },
      ),
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      createdAt: '2026-09-23T15:00:03.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const releaseClaim = jest.fn().mockResolvedValue(true);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const failExpiredInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(terminalizedResult('dispatched'));
    const failInvalidInteractiveDispatch = jest
      .fn()
      .mockResolvedValue(terminalizedResult('dispatched'));
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: jest
          .fn()
          .mockResolvedValueOnce('dispatched')
          .mockResolvedValueOnce('queued')
          .mockResolvedValueOnce('queued'),
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch,
        failInvalidInteractiveDispatch,
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 16,
        interactiveClassInFlight: { fast: 16, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([
            expiredCharged,
            malformedSameAttempt,
            firstWaiter,
            secondWaiter,
          ])
          .mockResolvedValue([]),
        markPublished,
        markDiscarded,
        releaseClaim,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(failExpiredInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(failInvalidInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(
      ['first-waiter'],
      expect.any(String),
    );
    expect(releaseClaim).toHaveBeenCalledWith(
      'second-waiter',
      expect.any(String),
      expect.any(String),
      'interactive_cap',
    );
  });

  it('frees a planner-owned slot when expire returns already-terminal after selection', async () => {
    const selectedExpired = {
      ...interactiveRow(
        'selected-already-terminal',
        'fast',
        '2026-09-23T15:05:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-already-terminal',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const failExpiredInteractiveDispatch = jest
      .fn()
      .mockResolvedValue({ outcome: 'already-terminal' } as const);
    let nowCalls = 0;
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: async () => 'dispatched',
        failExpiredInteractiveDispatch,
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 15,
        interactiveClassInFlight: { fast: 15, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
          cursor: { batch: 0, interactive: 15 },
        },
      }),
      getUncertainWorkerCount: async () => 0,
      clock: {
        now: () => {
          nowCalls += 1;
          return nowCalls === 1
            ? new Date('2026-09-23T15:00:00.000Z')
            : new Date('2026-09-23T15:06:00.000Z');
        },
        sleep: async () => undefined,
      },
      enableNotify: false,
      acquireOutboxLease: async (work) => work(lease()),
      outbox: fakeOutbox({
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([selectedExpired, queuedWaiter])
          .mockResolvedValue([]),
        markPublished,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(2);
    expect(failExpiredInteractiveDispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(
      ['selected-already-terminal'],
      expect.any(String),
    );
    expect(markPublished).toHaveBeenCalledWith(
      ['waiter-after-already-terminal'],
      expect.any(String),
    );
  });

  it('frees a planner-owned slot on mark fence-mismatch and dispatches a waiter', async () => {
    const selectedStale = {
      ...interactiveRow(
        'selected-fence-mismatch',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-mark-fence-mismatch',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: jest
          .fn()
          .mockResolvedValueOnce('fence-mismatch')
          .mockResolvedValue('dispatched'),
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 15,
        interactiveClassInFlight: { fast: 15, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
          cursor: { batch: 0, interactive: 15 },
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([selectedStale, queuedWaiter])
          .mockResolvedValue([]),
        markPublished,
        markDiscarded,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(markDiscarded).toHaveBeenCalledWith(
      'selected-fence-mismatch',
      expect.any(String),
      'fence_mismatch',
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(
      ['waiter-after-mark-fence-mismatch'],
      expect.any(String),
    );
  });

  it('frees a planner-owned slot when markInteractiveDispatched throws', async () => {
    const selectedThrow = {
      ...interactiveRow(
        'selected-mark-throw',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-mark-throw',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const markPublished = jest.fn(async (ids: string[]) => ids.length);
    const markFailed = jest.fn().mockResolvedValue(true);
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: async () => 'queued',
        markInteractiveDispatched: jest
          .fn()
          .mockRejectedValueOnce(new Error('db unavailable'))
          .mockResolvedValue('dispatched'),
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 15,
        interactiveClassInFlight: { fast: 15, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
          cursor: { batch: 0, interactive: 15 },
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([selectedThrow, queuedWaiter])
          .mockResolvedValue([]),
        markPublished,
        markFailed,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(1);
    expect(markFailed).toHaveBeenCalledWith(
      'selected-mark-throw',
      expect.any(String),
      'db unavailable',
      10_000,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(
      ['waiter-after-mark-throw'],
      expect.any(String),
    );
  });

  it('does not free a utilization-only recovery slot on fence-mismatch', async () => {
    const recoveryStale = {
      ...interactiveRow(
        'recovery-fence-mismatch',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          dispatchMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-23T15:00:00.000Z',
    };
    const queuedWaiter = {
      ...interactiveRow(
        'waiter-after-recovery-fence',
        'fast',
        '2026-09-23T15:10:00.000Z',
        {
          attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          dispatchMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      createdAt: '2026-09-23T15:00:01.000Z',
    };
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const releaseClaim = jest.fn().mockResolvedValue(true);
    const markDiscarded = jest.fn().mockResolvedValue(true);
    const base = emptyUtilization();
    const drainer = createOutboxDrainer({
      executor: { execute: async () => [] },
      publisher: { publish: jest.fn() },
      interactiveDispatchClient: { dispatch },
      attempts: {
        readInteractiveDispatchState: jest
          .fn()
          .mockResolvedValueOnce('dispatched')
          .mockResolvedValueOnce('queued'),
        markInteractiveDispatched: async () => 'fence-mismatch',
        failExpiredInteractiveDispatch: async () => terminalizedResult(),
        failInvalidInteractiveDispatch: async () => terminalizedResult(),
      },
      getUtilization: async () => ({
        ...base,
        cursorInFlight: 16,
        interactiveClassInFlight: { fast: 16, agentic: 0 },
        providerClassInFlight: {
          ...base.providerClassInFlight,
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
        claimInteractiveCandidates: jest
          .fn()
          .mockResolvedValueOnce([recoveryStale, queuedWaiter])
          .mockResolvedValue([]),
        markDiscarded,
        releaseClaim,
      }),
    });

    await expect(drainer.drainOnce()).resolves.toBe(0);
    expect(markDiscarded).toHaveBeenCalledWith(
      'recovery-fence-mismatch',
      expect.any(String),
      'fence_mismatch',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith(
      'waiter-after-recovery-fence',
      expect.any(String),
      expect.any(String),
      'interactive_cap',
    );
  });
});
