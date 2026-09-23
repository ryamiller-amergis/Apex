import {
  evaluateDispatchCapacity,
  evaluateInteractiveCapacity,
  emptyUtilization,
  providerForLane,
} from '../../services/aiOrchestrator/providerGovernor';
import { planAdmissionBatch } from '../../services/aiOrchestrator/admissionController';
import type { OutboxRow } from '../../services/aiRunV2/outboxRepository';
import { DEFAULT_PROVIDER_CAPACITY } from '../../services/aiOrchestrator/types';

const baseRow = (id: string, extra: Partial<OutboxRow> = {}): OutboxRow => ({
  id,
  idempotencyKey: `${id}:dispatch`,
  kind: 'dispatch_command',
  runId: 'run-1',
  attemptId: 'attempt-1',
  payload: {
    workloadLane: 'document',
    capacityClass: 'batch',
    dispatchMessageId: id,
  },
  availableAt: '2026-09-18T12:00:00.000Z',
  claimedBy: 'drainer',
  claimedAt: '2026-09-18T12:00:00.000Z',
  claimExpiresAt: '2026-09-18T12:01:00.000Z',
  publishAttempts: 1,
  lastError: null,
  publishedAt: null,
  createdAt: '2026-09-18T12:00:00.000Z',
  ...extra,
});

function interactiveUtilization(input: {
  fast: number;
  agentic: number;
}) {
  const utilization = emptyUtilization();
  const interactive = input.fast + input.agentic;
  return {
    ...utilization,
    cursorInFlight: interactive,
    laneInFlight: {
      ...utilization.laneInFlight,
      fast: input.fast,
      agentic: input.agentic,
    },
    providerClassInFlight: {
      ...utilization.providerClassInFlight,
      cursor: {
        ...utilization.providerClassInFlight.cursor,
        interactive,
      },
    },
  };
}

describe('providerGovernor', () => {
  it('maps lanes to providers', () => {
    expect(providerForLane('visual')).toBe('bedrock');
    expect(providerForLane('document')).toBe('cursor');
  });

  it('enforces Cursor 20 and Bedrock 2 caps', () => {
    const util = {
      ...emptyUtilization(),
      cursorInFlight: 20,
    };
    expect(
      evaluateDispatchCapacity({
        lane: 'document',
        capacityClass: 'batch',
        utilization: util,
        uncertainWorkerCount: 0,
        uncertainPauseThreshold: 2,
      }).status,
    ).toBe('deny');

    const bedrock = {
      ...emptyUtilization(),
      bedrockInFlight: 2,
    };
    expect(
      evaluateDispatchCapacity({
        lane: 'visual',
        capacityClass: 'batch',
        utilization: bedrock,
        uncertainWorkerCount: 0,
        uncertainPauseThreshold: 2,
        config: DEFAULT_PROVIDER_CAPACITY,
      }),
    ).toEqual({ status: 'deny', reason: 'provider_cap' });
  });

  it('pauses when uncertain workers reach the threshold', () => {
    expect(
      evaluateDispatchCapacity({
        lane: 'document',
        capacityClass: 'batch',
        utilization: emptyUtilization(),
        uncertainWorkerCount: 2,
        uncertainPauseThreshold: 2,
      }),
    ).toEqual({ status: 'deny', reason: 'uncertain_workers_paused' });
  });

  it('allows borrow above lane floor while provider capacity remains', () => {
    const util = {
      ...emptyUtilization(),
      cursorInFlight: 4,
      laneInFlight: {
        document: 4,
        visual: 0,
        fast: 0,
        agentic: 0,
      },
    };
    expect(
      evaluateDispatchCapacity({
        lane: 'document',
        capacityClass: 'batch',
        utilization: util,
        uncertainWorkerCount: 0,
        uncertainPauseThreshold: 2,
      }),
    ).toEqual({ status: 'allow', provider: 'cursor', lane: 'document' });
  });

  it('reserves one Bedrock slot so prototype batches cannot starve UI Lab', () => {
    const prototypeRows = Array.from({ length: 20 }, (_, index) =>
      baseRow(`prototype-${index}`, {
        payload: {
          workloadLane: 'visual',
          capacityClass: 'batch',
          dispatchMessageId: `prototype-${index}`,
        },
      }));
    const uiLabRow = baseRow('ui-lab', {
      payload: {
        workloadLane: 'visual',
        capacityClass: 'interactive',
        dispatchMessageId: 'ui-lab',
      },
    });

    const planned = planAdmissionBatch({
      rows: [...prototypeRows, uiLabRow],
      utilization: emptyUtilization(),
      uncertainWorkerCount: 0,
    });
    const allowed = planned.filter((item) => item.decision.status === 'allow');

    expect(allowed).toHaveLength(2);
    expect(
      allowed.map((item) => item.outbox.payload.capacityClass),
    ).toEqual(['batch', 'interactive']);
    expect(allowed.length).toBeLessThanOrEqual(
      DEFAULT_PROVIDER_CAPACITY.bedrockCap,
    );
  });

  it('allows two interactive visual runs but never exceeds provider cap two', () => {
    const planned = planAdmissionBatch({
      rows: [
        baseRow('interactive-1', {
          payload: {
            workloadLane: 'visual',
            capacityClass: 'interactive',
            dispatchMessageId: 'interactive-1',
          },
        }),
        baseRow('interactive-2', {
          payload: {
            workloadLane: 'visual',
            capacityClass: 'interactive',
            dispatchMessageId: 'interactive-2',
          },
        }),
        baseRow('interactive-3', {
          payload: {
            workloadLane: 'visual',
            capacityClass: 'interactive',
            dispatchMessageId: 'interactive-3',
          },
        }),
      ],
      utilization: emptyUtilization(),
      uncertainWorkerCount: 0,
    });

    expect(
      planned.map((item) => item.decision.status),
    ).toEqual(['allow', 'allow', 'deny']);
    expect(planned[2].decision).toEqual({
      status: 'deny',
      reason: 'provider_cap',
    });
  });

  it('reserves two slots for each class and borrows through sixteen', () => {
    expect(
      evaluateInteractiveCapacity(
        interactiveUtilization({ fast: 2, agentic: 0 }),
        'agentic',
      ),
    ).toEqual({ status: 'allow', borrowed: false });
    expect(
      evaluateInteractiveCapacity(
        interactiveUtilization({ fast: 14, agentic: 1 }),
        'agentic',
      ),
    ).toEqual({ status: 'allow', borrowed: false });
    expect(
      evaluateInteractiveCapacity(
        interactiveUtilization({ fast: 14, agentic: 2 }),
        'fast',
      ),
    ).toEqual({ status: 'deny', reason: 'interactive_cap' });
    expect(
      evaluateInteractiveCapacity(
        interactiveUtilization({ fast: 2, agentic: 2 }),
        'fast',
      ),
    ).toEqual({ status: 'allow', borrowed: true });
  });

  it('keeps document and visual floors while setting both interactive floors to two', () => {
    expect(DEFAULT_PROVIDER_CAPACITY).toMatchObject({
      interactiveCap: 16,
      laneFloors: {
        document: 4,
        visual: 2,
        fast: 2,
        agentic: 2,
      },
    });
  });
});

describe('admissionController', () => {
  it('plans allows until provider capacity is consumed in-batch', () => {
    const rows = [
      baseRow('a'),
      baseRow('b', {
        payload: {
          workloadLane: 'visual',
          capacityClass: 'batch',
          dispatchMessageId: 'b',
        },
      }),
    ];
    const planned = planAdmissionBatch({
      rows,
      utilization: emptyUtilization(),
      uncertainWorkerCount: 0,
    });
    expect(planned[0].decision.status).toBe('allow');
    expect(planned[1].decision).toEqual({
      status: 'allow',
      provider: 'bedrock',
      lane: 'visual',
    });
  });

  it('denies the batch when uncertain workers are paused', () => {
    const planned = planAdmissionBatch({
      rows: [baseRow('a')],
      utilization: emptyUtilization(),
      uncertainWorkerCount: 2,
    });
    expect(planned[0].decision).toEqual({
      status: 'deny',
      reason: 'uncertain_workers_paused',
    });
  });
});
