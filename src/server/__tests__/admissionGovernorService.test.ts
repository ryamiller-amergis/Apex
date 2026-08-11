/**
 * FEAT-002 Wave 2 Bundle C — S3/S4/S7 admission governor verification.
 */
import type { DispatchMessage } from '../../shared/types/agentRunAdmission';

jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'test-instance',
  nextRunEventSequence: jest.fn().mockReturnValue(1),
  notifyRunEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
  createAdmissionGovernorService,
  createStaleDispatchRecoveryService,
  resolveBackgroundInFlightLimit,
  resolveBackgroundPublishGraceMs,
  type AdmissionStore,
  type AdmissionTransaction,
  type AdmissionQueueSnapshot,
  type AdmittedDispatch,
  type StaleDispatchRecoveryStore,
} from '../services/admissionGovernorService';

type FakeRow = {
  id: string;
  threadId: string;
  projectId: string;
  lane: 'background';
  status: 'queued' | 'dispatched' | 'running';
  queuedAt: string;
  dispatchMessageId?: string;
  dispatchedAt?: string;
  progressPhase?: string;
  progressLabel?: string;
  prompt?: string;
};

class ConcurrencySafeFakeStore implements AdmissionStore {
  readonly rows: FakeRow[];
  transactionCompleted = true;
  private tail: Promise<void> = Promise.resolve();

  constructor(rows: FakeRow[]) {
    this.rows = rows;
  }

  async runInTransaction<T>(
    work: (tx: AdmissionTransaction) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.transactionCompleted = false;
    try {
      return await work({
        acquireGlobalLock: async () => undefined,
        readQueueSnapshot: async () => this.snapshot(),
        admitNext: async (dispatchMessageId, dispatchedAt) =>
          this.admitNext(dispatchMessageId, dispatchedAt),
      });
    } finally {
      this.transactionCompleted = true;
      release();
    }
  }

  private snapshot(): AdmissionQueueSnapshot {
    const inFlightRows = this.rows.filter(
      (row) => row.lane === 'background'
        && (row.status === 'dispatched' || row.status === 'running'),
    );
    const queuedRows = this.rows.filter(
      (row) => row.lane === 'background' && row.status === 'queued',
    );
    return {
      inFlight: inFlightRows.length,
      queuedDepth: queuedRows.length,
      oldestQueuedAt: queuedRows
        .map((row) => row.queuedAt)
        .sort()[0] ?? null,
    };
  }

  private admitNext(
    dispatchMessageId: string,
    dispatchedAt: string,
  ): AdmittedDispatch | null {
    const inFlightByProject = new Map<string, number>();
    for (const row of this.rows) {
      if (row.status === 'dispatched' || row.status === 'running') {
        inFlightByProject.set(
          row.projectId,
          (inFlightByProject.get(row.projectId) ?? 0) + 1,
        );
      }
    }

    const candidate = this.rows
      .filter((row) => row.status === 'queued')
      .sort((left, right) => {
        const countDifference =
          (inFlightByProject.get(left.projectId) ?? 0)
          - (inFlightByProject.get(right.projectId) ?? 0);
        return countDifference
          || left.queuedAt.localeCompare(right.queuedAt)
          || left.id.localeCompare(right.id);
      })[0];
    if (!candidate) return null;

    const projectInFlight = inFlightByProject.get(candidate.projectId) ?? 0;
    candidate.status = 'dispatched';
    candidate.dispatchMessageId = dispatchMessageId;
    candidate.dispatchedAt = dispatchedAt;
    candidate.progressPhase = 'dispatched';
    candidate.progressLabel = 'Starting…';
    return {
      runId: candidate.id,
      threadId: candidate.threadId,
      dispatchMessageId,
      projectId: candidate.projectId,
      lane: 'background',
      queuedAt: candidate.queuedAt,
      projectInFlight,
    };
  }
}

function queued(
  id: string,
  projectId: string,
  queuedAt: string,
  extras: Partial<FakeRow> = {},
): FakeRow {
  return {
    id,
    threadId: `thread-${id}`,
    projectId,
    lane: 'background',
    status: 'queued',
    queuedAt,
    ...extras,
  };
}

function inFlight(
  id: string,
  projectId: string,
  status: 'dispatched' | 'running' = 'running',
): FakeRow {
  return {
    id,
    threadId: `thread-${id}`,
    projectId,
    lane: 'background',
    status,
    queuedAt: '2026-08-05T10:00:00.000Z',
  };
}

function uuidSequence(): () => string {
  let next = 0;
  return () => `dispatch-${++next}`;
}

describe('background in-flight cap resolver (BR-003)', () => {
  test('Given no env value, when resolved, then the cap defaults to 10', () => {
    expect(resolveBackgroundInFlightLimit(undefined)).toBe(10);
    expect(resolveBackgroundInFlightLimit('')).toBe(10);
  });

  test('Given a positive bounded integer, when resolved, then it is honored', () => {
    expect(resolveBackgroundInFlightLimit('12')).toBe(12);
    expect(resolveBackgroundInFlightLimit('1')).toBe(1);
  });

  test.each(['0', '-1', '1.5', 'abc', '101', ' 12x '])(
    'Given invalid or out-of-range value %s, when resolved, then it safely defaults',
    (value) => {
      expect(resolveBackgroundInFlightLimit(value)).toBe(10);
    },
  );
});

describe('transactional fair admission (PBI-002 AC-0/AC-1/AC-2, VT-01/VT-02/VT-03, DoD-2/DoD-3)', () => {
  test('BR-003: Given a full cap, when a cycle runs, then no queued run is admitted', async () => {
    const store = new ConcurrencySafeFakeStore([
      inFlight('live-1', 'project-a'),
      inFlight('live-2', 'project-b', 'dispatched'),
      queued('queued-1', 'project-c', '2026-08-05T11:00:00.000Z'),
    ]);
    const publish = jest.fn();
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish },
      resolveLimit: () => 2,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
    });

    const result = await governor.runAdmissionCycle('enqueue');

    expect(result).toEqual({ admitted: 0, inFlight: 2, limit: 2 });
    expect(store.rows.find((row) => row.id === 'queued-1')?.status).toBe('queued');
    expect(publish).not.toHaveBeenCalled();
  });

  test('AC-0/VT-01/BR-004: Given unequal live counts, when slots fill, then fairness is recalculated before every slot', async () => {
    const store = new ConcurrencySafeFakeStore([
      inFlight('b-live', 'project-b'),
      queued('a-1', 'project-a', '2026-08-05T11:05:00.000Z'),
      queued('a-2', 'project-a', '2026-08-05T11:06:00.000Z'),
      queued('b-1', 'project-b', '2026-08-05T11:00:00.000Z'),
    ]);
    const publish = jest.fn().mockResolvedValue(undefined);
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish },
      resolveLimit: () => 3,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
    });

    const result = await governor.runAdmissionCycle('enqueue');

    expect(result).toEqual({ admitted: 2, inFlight: 1, limit: 3 });
    expect(publish.mock.calls.map(([message]) => message.runId)).toEqual(['a-1', 'b-1']);
    expect(store.rows.find((row) => row.id === 'a-2')?.status).toBe('queued');
  });

  test('DoD-3/BR-004: Given equal project counts, when selecting, then FIFO and stable id break ties', async () => {
    const store = new ConcurrencySafeFakeStore([
      queued('run-z', 'project-z', '2026-08-05T11:01:00.000Z'),
      queued('run-b', 'project-b', '2026-08-05T11:00:00.000Z'),
      queued('run-a', 'project-a', '2026-08-05T11:00:00.000Z'),
    ]);
    const publish = jest.fn().mockResolvedValue(undefined);
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish },
      resolveLimit: () => 1,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
    });

    await governor.runAdmissionCycle('enqueue');

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-a' }),
    );
  });

  test('AC-2/VT-03: Given only one project waits, when capacity exists, then it fills every idle slot', async () => {
    const store = new ConcurrencySafeFakeStore([
      queued('run-1', 'project-a', '2026-08-05T11:00:00.000Z'),
      queued('run-2', 'project-a', '2026-08-05T11:01:00.000Z'),
      queued('run-3', 'project-a', '2026-08-05T11:02:00.000Z'),
    ]);
    const publish = jest.fn().mockResolvedValue(undefined);
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish },
      resolveLimit: () => 3,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
    });

    const result = await governor.runAdmissionCycle('enqueue');

    expect(result.admitted).toBe(3);
    expect(store.rows.filter((row) => row.status === 'dispatched')).toHaveLength(3);
  });

  test('AC-1/VT-02/DoD-2/BR-003: Given concurrent cycles, when both admit, then no run duplicates and the cap never overshoots', async () => {
    const store = new ConcurrencySafeFakeStore([
      ...Array.from({ length: 8 }, (_, index) =>
        queued(
          `run-${index + 1}`,
          `project-${(index % 3) + 1}`,
          `2026-08-05T11:0${index}:00.000Z`,
        )),
    ]);
    const published: DispatchMessage[] = [];
    const governor = createAdmissionGovernorService({
      store,
      publisher: {
        publish: async (message) => {
          published.push(message);
        },
      },
      resolveLimit: () => 4,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
    });

    await Promise.all([
      governor.runAdmissionCycle('enqueue'),
      governor.runAdmissionCycle('slot-release'),
    ]);

    const dispatched = store.rows.filter(
      (row) => row.status === 'dispatched' || row.status === 'running',
    );
    expect(dispatched).toHaveLength(4);
    expect(new Set(dispatched.map((row) => row.id)).size).toBe(4);
    expect(new Set(published.map((message) => message.runId)).size).toBe(4);
  });
});

describe('post-commit publish and safe telemetry (TBI-002 DoD-0/DoD-4/S7)', () => {
  test('PBI-006 AC-0 / VT-01: durable dispatched phase is published after the fence and before worker dispatch', async () => {
    const store = new ConcurrencySafeFakeStore([
      queued('run-1', 'project-a', '2026-08-05T11:59:00.000Z', {
        prompt: 'confidential prompt',
      }),
    ]);
    const calls: string[] = [];
    const notifyRunEvent = jest.fn(async (event) => {
      expect(store.transactionCompleted).toBe(true);
      expect(store.rows[0]).toEqual(expect.objectContaining({
        status: 'dispatched',
        progressPhase: 'dispatched',
        progressLabel: 'Starting…',
      }));
      expect(event).toEqual(expect.objectContaining({
        threadId: 'thread-run-1',
        runId: 'run-1',
        phase: 'dispatched',
        status: 'pending',
        detail: 'Starting…',
        event: expect.objectContaining({
          type: 'phase',
          phase: 'dispatched',
          detail: 'Starting…',
          runId: 'run-1',
        }),
      }));
      calls.push('event');
    });
    const publish = jest.fn(async () => {
      calls.push('dispatch');
    });
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish },
      resolveLimit: () => 1,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
      notifyRunEvent,
    });

    await governor.runAdmissionCycle('enqueue');

    expect(calls).toEqual(['event', 'dispatch']);
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', threadId: 'thread-run-1' }),
      { persist: true },
    );
    expect(JSON.stringify(notifyRunEvent.mock.calls)).not.toMatch(
      /confidential prompt|snapshot|workspace|CURSOR_API_KEY/i,
    );
  });

  test('DoD-4: Given a durable dispatch, when publishing, then publish starts only after transaction commit', async () => {
    const store = new ConcurrencySafeFakeStore([
      queued('run-1', 'project-a', '2026-08-05T11:00:00.000Z'),
    ]);
    const publish = jest.fn(async () => {
      expect(store.transactionCompleted).toBe(true);
      expect(store.rows[0]).toEqual(expect.objectContaining({
        status: 'dispatched',
        dispatchMessageId: 'dispatch-1',
      }));
    });
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish },
      resolveLimit: () => 1,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
    });

    await governor.runAdmissionCycle('enqueue');

    expect(publish).toHaveBeenCalledWith({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
  });

  test('DoD-4: Given publish fails, when the cycle completes, then admission remains durable and failure is safely handled', async () => {
    const store = new ConcurrencySafeFakeStore([
      queued('run-1', 'project-a', '2026-08-05T11:00:00.000Z', {
        prompt: 'never-log-this-prompt',
      }),
    ]);
    const logError = jest.fn();
    const governor = createAdmissionGovernorService({
      store,
      publisher: {
        publish: jest.fn().mockRejectedValue(
          new Error('secret broker response containing CURSOR_API_KEY'),
        ),
      },
      resolveLimit: () => 1,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
      logError,
    });

    await expect(governor.runAdmissionCycle('enqueue')).resolves.toEqual({
      admitted: 1,
      inFlight: 0,
      limit: 1,
    });
    expect(store.rows[0].status).toBe('dispatched');
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain('run-1');
    expect(logged).toContain('dispatch-1');
    expect(logged).not.toContain('CURSOR_API_KEY');
    expect(logged).not.toContain('never-log-this-prompt');
  });

  test('S7/security NFR: Given a cycle and admitted run, when telemetry emits, then safe properties and aggregation measurements are present', async () => {
    const store = new ConcurrencySafeFakeStore([
      inFlight('live-1', 'project-b'),
      queued('run-1', 'project-a', '2026-08-05T11:55:00.000Z', {
        prompt: 'confidential prompt',
      }),
      queued('run-2', 'project-c', '2026-08-05T11:59:00.000Z'),
    ]);
    const telemetry = jest.fn();
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish: jest.fn().mockResolvedValue(undefined) },
      resolveLimit: () => 2,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry,
    });

    await governor.runAdmissionCycle('slot-release');

    expect(telemetry).toHaveBeenCalledWith(
      'agent_run.admission_cycle',
      { lane: 'background', reason: 'slot-release' },
      expect.objectContaining({
        limit: 2,
        inFlight: 1,
        admitted: 1,
        queuedDepth: 2,
        oldestQueuedAgeMs: 300_000,
      }),
    );
    expect(telemetry).toHaveBeenCalledWith(
      'agent_run.admitted',
      {
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
        projectId: 'project-a',
        lane: 'background',
        reason: 'slot-release',
      },
      {
        projectInFlight: 0,
        admissionWaitMs: 300_000,
      },
    );
    const serialized = JSON.stringify(telemetry.mock.calls);
    expect(serialized).not.toContain('confidential prompt');
    expect(serialized).not.toMatch(/snapshot|workspace|secret/i);
  });

  test('TBI-008 DoD-2 / performance NFR: emits typed capacity, queue, fairness, and raw admission duration telemetry', async () => {
    const store = new ConcurrencySafeFakeStore([
      inFlight('live-1', 'project-b'),
      queued('run-1', 'project-a', '2026-08-05T11:55:00.000Z', {
        prompt: 'prompt=confidential',
      }),
    ]);
    const workerTelemetry = {
      inflight: jest.fn(),
      queueDepth: jest.fn(),
      queueOldestAge: jest.fn(),
      projectInflight: jest.fn(),
      admissionWait: jest.fn(),
      coldStart: jest.fn(),
      cancellation: jest.fn(),
      reaperAction: jest.fn(),
      terminalReason: jest.fn(),
      interactiveFirstToken: jest.fn(),
      interactiveTurn: jest.fn(),
      interactiveInflight: jest.fn(),
      interactiveShed: jest.fn(),
      interactiveActorHealth: jest.fn(),
      interactiveReplay: jest.fn(),
      interactiveStage: jest.fn(),
    };
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish: jest.fn().mockResolvedValue(undefined) },
      resolveLimit: () => 2,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
      workerTelemetry,
      notifyRunEvent: jest.fn().mockResolvedValue(undefined),
    });

    await governor.runAdmissionCycle('slot-release');

    expect(workerTelemetry.inflight).toHaveBeenCalledWith(
      { lane: 'background' },
      2,
      2,
    );
    expect(workerTelemetry.queueDepth).toHaveBeenCalledWith(
      { lane: 'background' },
      0,
    );
    expect(workerTelemetry.queueOldestAge).toHaveBeenCalledWith(
      { lane: 'background' },
      0,
    );
    expect(workerTelemetry.projectInflight).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
        project: 'project-a',
        lane: 'background',
      }),
      1,
    );
    expect(workerTelemetry.admissionWait).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
        project: 'project-a',
        lane: 'background',
      }),
      300_000,
    );
    expect(JSON.stringify(workerTelemetry)).not.toMatch(
      /prompt=confidential|snapshot|workspace|CURSOR_API_KEY/i,
    );
  });

  test('TBI-008 DoD-2: typed telemetry failures do not affect durable admission', async () => {
    const store = new ConcurrencySafeFakeStore([
      queued('run-1', 'project-a', '2026-08-05T11:59:00.000Z'),
    ]);
    const throwing = jest.fn(() => {
      throw new Error('telemetry unavailable');
    });
    const governor = createAdmissionGovernorService({
      store,
      publisher: { publish: jest.fn().mockResolvedValue(undefined) },
      resolveLimit: () => 1,
      randomUuid: uuidSequence(),
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      telemetry: jest.fn(),
      workerTelemetry: {
        inflight: throwing,
        queueDepth: throwing,
        queueOldestAge: throwing,
        projectInflight: throwing,
        admissionWait: throwing,
        coldStart: throwing,
        cancellation: throwing,
        reaperAction: throwing,
        terminalReason: throwing,
        interactiveFirstToken: throwing,
        interactiveTurn: throwing,
        interactiveInflight: throwing,
        interactiveShed: throwing,
        interactiveActorHealth: throwing,
        interactiveReplay: throwing,
        interactiveStage: throwing,
      },
      notifyRunEvent: jest.fn().mockResolvedValue(undefined),
    });

    await expect(governor.runAdmissionCycle('enqueue')).resolves.toEqual({
      admitted: 1,
      inFlight: 0,
      limit: 1,
    });
    expect(store.rows[0].status).toBe('dispatched');
  });
});

describe('stale dispatch republish recovery (TBI-002 DoD-4/VT-07)', () => {
  test('DoD-4/VT-07: Given bounded stale dispatches, when recovery runs, then it republishes exact persisted identities only', async () => {
    const staleDispatches = Array.from({ length: 100 }, (_, index) => ({
      runId: `run-${index + 1}`,
      dispatchMessageId: `persisted-fence-${index + 1}`,
    }));
    const findStaleDispatches = jest.fn().mockResolvedValue(staleDispatches);
    const store: StaleDispatchRecoveryStore = { findStaleDispatches };
    const publish = jest.fn().mockResolvedValue(undefined);
    const recovery = createStaleDispatchRecoveryService({
      store,
      publisher: { publish },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      resolveGraceMs: () => 60_000,
      batchSize: 500,
      logError: jest.fn(),
    });

    const result = await recovery.recoverStaleDispatchedRuns();

    expect(findStaleDispatches).toHaveBeenCalledWith(
      '2026-08-05T11:59:00.000Z',
      100,
    );
    expect(result).toEqual({ selected: 100, published: 100, failed: 0 });
    expect(publish).toHaveBeenCalledTimes(100);
    expect(publish).toHaveBeenNthCalledWith(1, {
      runId: 'run-1',
      dispatchMessageId: 'persisted-fence-1',
    });
    expect(publish).toHaveBeenNthCalledWith(100, {
      runId: 'run-100',
      dispatchMessageId: 'persisted-fence-100',
    });
    expect(JSON.stringify(publish.mock.calls)).not.toMatch(
      /snapshot|prompt|workspace|secret/i,
    );
  });

  test('DoD-4/VT-07: Given a stale publish fails, when a later recovery runs, then it retries the same fence without mutation', async () => {
    const persistedDispatch = {
      runId: 'run-1',
      dispatchMessageId: 'persisted-fence-1',
    };
    const findStaleDispatches = jest.fn().mockResolvedValue([
      persistedDispatch,
    ]);
    const publish = jest.fn()
      .mockRejectedValueOnce(
        new Error('secret broker response containing CURSOR_API_KEY'),
      )
      .mockResolvedValueOnce(undefined);
    const logError = jest.fn();
    const recovery = createStaleDispatchRecoveryService({
      store: { findStaleDispatches },
      publisher: { publish },
      now: () => new Date('2026-08-05T12:00:00.000Z'),
      resolveGraceMs: () => 60_000,
      logError,
    });

    await expect(recovery.recoverStaleDispatchedRuns()).resolves.toEqual({
      selected: 1,
      published: 0,
      failed: 1,
    });
    await expect(recovery.recoverStaleDispatchedRuns()).resolves.toEqual({
      selected: 1,
      published: 1,
      failed: 0,
    });

    expect(publish.mock.calls).toEqual([
      [persistedDispatch],
      [persistedDispatch],
    ]);
    expect(persistedDispatch).toEqual({
      runId: 'run-1',
      dispatchMessageId: 'persisted-fence-1',
    });
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).toContain('run-1');
    expect(logged).toContain('persisted-fence-1');
    expect(logged).not.toContain('CURSOR_API_KEY');
    expect(logged).not.toMatch(/snapshot|prompt|workspace|secret/i);
  });

  test('DoD-4: Given invalid publish grace configuration, when resolved, then it safely defaults to 60 seconds', () => {
    expect(resolveBackgroundPublishGraceMs(undefined)).toBe(60_000);
    expect(resolveBackgroundPublishGraceMs('')).toBe(60_000);
    expect(resolveBackgroundPublishGraceMs('0')).toBe(60_000);
    expect(resolveBackgroundPublishGraceMs('not-a-duration')).toBe(60_000);
    expect(resolveBackgroundPublishGraceMs('60000')).toBe(60_000);
  });
});
