import type { InteractiveClass } from '../../../shared/types/durableInteractiveTurn';
import {
  planInteractiveAdmissionBatch,
  toInteractiveAdmissionCandidate,
  type InteractiveAdmissionCandidate,
} from '../../services/aiOrchestrator/admissionController';
import { emptyUtilization } from '../../services/aiOrchestrator/providerGovernor';
import type { OutboxRow } from '../../services/aiRunV2/outboxRepository';

const DEADLINE_AT = '2026-09-23T16:00:00.000Z';
const NOW = new Date('2026-09-23T15:30:00.000Z');

function row(
  id: string,
  interactiveClass: InteractiveClass,
  createdAt: string,
  model?: string,
): OutboxRow {
  return {
    id,
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
      deadlineAt: DEADLINE_AT,
      ...(model ? { model } : {}),
    },
    availableAt: createdAt,
    claimedBy: 'drainer',
    claimedAt: createdAt,
    claimExpiresAt: '2026-09-23T15:31:00.000Z',
    publishAttempts: 1,
    lastError: null,
    publishedAt: null,
    createdAt,
  };
}

function candidates(rows: OutboxRow[]): InteractiveAdmissionCandidate[] {
  return rows.map((outbox) => {
    const candidate = toInteractiveAdmissionCandidate(outbox);
    expect(candidate).not.toBeNull();
    const hasOwn = (
      Object as ObjectConstructor & {
        hasOwn(value: object, key: PropertyKey): boolean;
      }
    ).hasOwn;
    expect(hasOwn(candidate as object, 'model')).toBe(false);
    return candidate as InteractiveAdmissionCandidate;
  });
}

function utilization(input: { fast: number; agentic: number }) {
  const base = emptyUtilization();
  return {
    ...base,
    cursorInFlight: input.fast + input.agentic,
    laneInFlight: {
      ...base.laneInFlight,
      fast: input.fast,
      agentic: input.agentic,
    },
  };
}

function planIds(
  queued: InteractiveAdmissionCandidate[],
  inFlight: { fast: number; agentic: number },
  maxDispatches: number,
): string[] {
  return planInteractiveAdmissionBatch({
    candidates: queued,
    utilization: utilization(inFlight),
    maxDispatches,
    now: NOW,
  }).map((candidate) => candidate.outbox.id);
}

describe('interactive admission planning', () => {
  it('selects the oldest shared-burst turn regardless of class or model', () => {
    const first = candidates([
      row('older', 'agentic', '2026-09-23T15:00:00.000Z', 'model-a'),
      row('newer', 'fast', '2026-09-23T15:00:01.000Z', 'model-b'),
    ]);
    const changedModels = candidates([
      row('older', 'agentic', '2026-09-23T15:00:00.000Z', 'model-z'),
      row('newer', 'fast', '2026-09-23T15:00:01.000Z', 'model-a'),
    ]);

    expect(planIds(first, { fast: 2, agentic: 2 }, 1)).toEqual(['older']);
    expect(planIds(changedModels, { fast: 2, agentic: 2 }, 1)).toEqual([
      'older',
    ]);
  });

  it('uses a released slot for the oldest floor-deficit class turn', () => {
    const queued = candidates([
      row('older-agentic', 'agentic', '2026-09-23T15:00:00.000Z'),
      row('waiting-fast', 'fast', '2026-09-23T15:00:01.000Z'),
    ]);

    expect(planIds(queued, { fast: 0, agentic: 15 }, 1)).toEqual([
      'waiting-fast',
    ]);
  });

  it('protects the agentic floor symmetrically', () => {
    const queued = candidates([
      row('older-fast', 'fast', '2026-09-23T15:00:00.000Z'),
      row('waiting-agentic', 'agentic', '2026-09-23T15:00:01.000Z'),
    ]);

    expect(planIds(queued, { fast: 15, agentic: 0 }, 1)).toEqual([
      'waiting-agentic',
    ]);
  });

  it('is work-conserving when the floor-deficit class has no queued turn', () => {
    const queued = candidates([
      row('agentic-only', 'agentic', '2026-09-23T15:00:00.000Z'),
    ]);

    expect(planIds(queued, { fast: 0, agentic: 15 }, 1)).toEqual([
      'agentic-only',
    ]);
  });

  it('breaks equal accepted timestamps by outbox id', () => {
    const queued = candidates([
      row('b', 'fast', '2026-09-23T15:00:00.000Z'),
      row('a', 'agentic', '2026-09-23T15:00:00.000Z'),
    ]);

    expect(planIds(queued, { fast: 2, agentic: 2 }, 2)).toEqual(['a', 'b']);
  });

  it('does not admit an expired or seventeenth queued turn', () => {
    const expired = row(
      'expired',
      'fast',
      '2026-09-23T15:00:00.000Z',
    );
    expired.payload.deadlineAt = '2026-09-23T15:29:59.999Z';

    expect(
      planIds(candidates([expired]), { fast: 0, agentic: 0 }, 1),
    ).toEqual([]);
    expect(
      planIds(
        candidates([
          row('seventeenth', 'fast', '2026-09-23T15:00:00.000Z'),
        ]),
        { fast: 8, agentic: 8 },
        1,
      ),
    ).toEqual([]);
  });
});
