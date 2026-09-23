import {
  evaluateDispatchCapacity,
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
  payload: { workloadLane: 'document', dispatchMessageId: id },
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
          visualSubjectKind: 'design-prototype',
          dispatchMessageId: `prototype-${index}`,
        },
      }));
    const uiLabRow = baseRow('ui-lab', {
      payload: {
        workloadLane: 'visual',
        visualSubjectKind: 'ui-lab-screen',
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
      allowed.map((item) => item.outbox.payload.visualSubjectKind),
    ).toEqual(['design-prototype', 'ui-lab-screen']);
    expect(allowed.length).toBeLessThanOrEqual(
      DEFAULT_PROVIDER_CAPACITY.bedrockCap,
    );
  });
});

describe('admissionController', () => {
  it('plans allows until provider capacity is consumed in-batch', () => {
    const rows = [
      baseRow('a'),
      baseRow('b', {
        payload: {
          workloadLane: 'visual',
          visualSubjectKind: 'design-prototype',
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
