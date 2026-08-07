import {
  createInteractiveActorAdmissionService,
  resolveInteractiveBurstMax,
  resolveInteractiveReserved,
  resolveFirstTokenSloMs,
  type InteractiveAdmissionStore,
  type InteractiveAdmissionTransaction,
} from '../services/interactiveActorAdmissionService';

jest.mock('../db/drizzle', () => ({ db: {} }));

type Model = {
  inFlight: number;
  queued: Set<string>;
  dispatched: Set<string>;
  dispatchCalls: number;
};

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    inFlight: 0,
    queued: new Set(['run-1', 'run-2']),
    dispatched: new Set(),
    dispatchCalls: 0,
    ...overrides,
  };
}

/**
 * In-memory store that serializes transactions to model
 * `pg_advisory_xact_lock`, so concurrent governors cannot double-admit.
 */
function makeStore(model: Model): InteractiveAdmissionStore {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    runInTransaction<T>(
      work: (tx: InteractiveAdmissionTransaction) => Promise<T>,
    ): Promise<T> {
      const tx: InteractiveAdmissionTransaction = {
        acquireLock: async () => {},
        countInFlight: async () => model.inFlight,
        dispatch: async (runId: string) => {
          model.dispatchCalls += 1;
          if (!model.queued.has(runId)) return false;
          model.queued.delete(runId);
          model.dispatched.add(runId);
          model.inFlight += 1;
          return true;
        },
      };
      const result = chain.then(() => work(tx));
      chain = result.catch(() => undefined);
      return result;
    },
  };
}

describe('interactive config resolution', () => {
  it('defaults reserved=4, burst=12, first-token SLO=1500ms', () => {
    expect(resolveInteractiveReserved(undefined)).toBe(4);
    expect(resolveInteractiveBurstMax(undefined)).toBe(12);
    expect(resolveFirstTokenSloMs(undefined)).toBe(1_500);
  });

  it('accepts valid env overrides and falls back on invalid values', () => {
    expect(resolveInteractiveReserved('6')).toBe(6);
    expect(resolveInteractiveBurstMax('18')).toBe(18);
    expect(resolveFirstTokenSloMs('900')).toBe(900);
    expect(resolveInteractiveReserved('-1')).toBe(4);
    expect(resolveInteractiveBurstMax('abc')).toBe(12);
    expect(resolveFirstTokenSloMs('0')).toBe(1_500);
  });
});

describe('reserved-capacity actor activation admission (TBI-010)', () => {
  it('VT-05 / BR-014: fills reserved capacity first', async () => {
    const model = makeModel({ inFlight: 0 });
    const service = createInteractiveActorAdmissionService({
      store: makeStore(model),
      resolveCapacity: () => ({ reserved: 4, burstMax: 12 }),
      randomUuid: () => 'dispatch-1',
    });

    const decision = await service.admit('run-1');

    expect(decision).toEqual({
      admitted: true,
      shed: false,
      slot: 'reserved',
      dispatchMessageId: 'dispatch-1',
      interactiveInFlight: 1,
      reserved: 4,
      burstMax: 12,
    });
    expect(model.dispatched.has('run-1')).toBe(true);
  });

  it('VT-05 / BR-014: uses burst capacity once reserved is full', async () => {
    const model = makeModel({ inFlight: 4 });
    const service = createInteractiveActorAdmissionService({
      store: makeStore(model),
      resolveCapacity: () => ({ reserved: 4, burstMax: 12 }),
      randomUuid: () => 'dispatch-1',
    });

    const decision = await service.admit('run-1');

    expect(decision.admitted).toBe(true);
    expect(decision.admitted && decision.slot).toBe('burst');
  });

  it('VT-05 / BR-014 / PBI-007 AC-e: sheds immediately above reserved+burst without dispatching', async () => {
    const model = makeModel({ inFlight: 16 });
    const service = createInteractiveActorAdmissionService({
      store: makeStore(model),
      resolveCapacity: () => ({ reserved: 4, burstMax: 12 }),
    });

    const decision = await service.admit('run-1');

    expect(decision).toEqual({
      admitted: false,
      shed: true,
      reason: 'over-capacity',
      interactiveInFlight: 16,
      reserved: 4,
      burstMax: 12,
    });
    expect(model.dispatchCalls).toBe(0);
    expect(model.queued.has('run-1')).toBe(true);
  });

  it('VT-05: a lost dispatch race sheds (race-lost), never double-admits', async () => {
    const model = makeModel({ inFlight: 0, queued: new Set() });
    const service = createInteractiveActorAdmissionService({
      store: makeStore(model),
      resolveCapacity: () => ({ reserved: 4, burstMax: 12 }),
    });

    const decision = await service.admit('run-1');

    expect(decision).toEqual({
      admitted: false,
      shed: true,
      reason: 'race-lost',
      interactiveInFlight: 0,
      reserved: 4,
      burstMax: 12,
    });
  });

  it('VT-05 / BR-014: concurrent governors respect a capacity of one — exactly one admit', async () => {
    const model = makeModel({ inFlight: 0, queued: new Set(['run-1', 'run-2']) });
    const service = createInteractiveActorAdmissionService({
      store: makeStore(model),
      resolveCapacity: () => ({ reserved: 1, burstMax: 0 }),
      randomUuid: () => 'dispatch-x',
    });

    const [a, b] = await Promise.all([
      service.admit('run-1'),
      service.admit('run-2'),
    ]);

    const admits = [a, b].filter((d) => d.admitted).length;
    const sheds = [a, b].filter((d) => d.shed).length;
    expect(admits).toBe(1);
    expect(sheds).toBe(1);
    expect(model.inFlight).toBe(1);
  });
});
