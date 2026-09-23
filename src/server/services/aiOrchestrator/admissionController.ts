/**
 * Leased V2 admission decisions for outbox command rows.
 */
import {
  AI_RUN_V2_LANE_QUEUES,
  isAiRunV2CapacityClass,
  isAiRunV2WorkloadLane,
  type AiRunV2CapacityClass,
} from '../../../shared/types/aiRunV2';
import {
  isInteractiveDispatchOutboxPayload,
  type InteractiveDispatchOutboxPayload,
} from '../../../shared/types/durableInteractiveTurn';
import type { OutboxRow } from '../aiRunV2/outboxRepository';
import {
  createProviderCapacityReservation,
  evaluateDispatchCapacity,
  providerForLane,
} from './providerGovernor';
import type {
  AiOrchestratorLane,
  DispatchDecision,
  ProviderCapacityReservation,
  ProviderCapacityConfig,
  ProviderUtilization,
} from './types';
import {
  DEFAULT_PROVIDER_CAPACITY,
  UNCERTAIN_WORKER_PAUSE_THRESHOLD,
} from './types';

export type AdmissionCandidate = Readonly<{
  outbox: OutboxRow;
  /** Null when the row carries no recognizable workload lane. */
  queueName: string | null;
  lane: AiOrchestratorLane | null;
  capacityClass: AiRunV2CapacityClass | null;
  decision: DispatchDecision;
}>;

export type InteractiveAdmissionCandidate = Readonly<{
  outbox: OutboxRow;
  payload: InteractiveDispatchOutboxPayload;
}>;

export function toInteractiveAdmissionCandidate(
  row: OutboxRow,
): InteractiveAdmissionCandidate | null {
  if (
    row.kind !== 'interactive_dispatch' ||
    !isInteractiveDispatchOutboxPayload(row.payload) ||
    row.runId !== row.payload.runId ||
    row.attemptId !== row.payload.attemptId
  ) {
    return null;
  }
  return {
    outbox: row,
    payload: row.payload,
  };
}

function compareInteractiveCandidates(
  left: InteractiveAdmissionCandidate,
  right: InteractiveAdmissionCandidate,
): number {
  const createdAtDifference =
    Date.parse(left.outbox.createdAt) - Date.parse(right.outbox.createdAt);
  if (createdAtDifference !== 0) return createdAtDifference;
  return left.outbox.id.localeCompare(right.outbox.id);
}

export function planInteractiveAdmissionBatch(input: {
  candidates: ReadonlyArray<InteractiveAdmissionCandidate>;
  utilization: ProviderUtilization;
  reservation?: ProviderCapacityReservation;
  config?: ProviderCapacityConfig;
  maxDispatches?: number;
  now?: Date;
}): InteractiveAdmissionCandidate[] {
  const config = input.config ?? DEFAULT_PROVIDER_CAPACITY;
  const nowMs = (input.now ?? new Date()).getTime();
  const reservation =
    input.reservation ??
    createProviderCapacityReservation(input.utilization);
  const totalInteractiveInFlight =
    reservation.interactiveClassInFlight.fast +
    reservation.interactiveClassInFlight.agentic;
  const interactiveSlots = Math.max(
    0,
    config.interactiveCap - totalInteractiveInFlight,
  );
  const cursorSlots = Math.max(
    0,
    config.cursorCap - reservation.cursorInFlight,
  );
  const capSlots = Math.min(interactiveSlots, cursorSlots);
  const requestedSlots = input.maxDispatches ?? capSlots;
  let availableSlots = Math.min(
    capSlots,
    Math.max(0, requestedSlots),
  );
  const remaining = input.candidates
    .filter((candidate) => Date.parse(candidate.payload.deadlineAt) > nowMs)
    .sort(compareInteractiveCandidates);
  const planned: InteractiveAdmissionCandidate[] = [];

  while (availableSlots > 0 && remaining.length > 0) {
    const floorEligible = remaining.filter(
      (candidate) =>
        reservation.interactiveClassInFlight[
          candidate.payload.interactiveClass
        ] <
        config.laneFloors[candidate.payload.interactiveClass],
    );
    const selected = (floorEligible.length > 0 ? floorEligible : remaining)[0];
    planned.push(selected);
    reservation.interactiveClassInFlight[
      selected.payload.interactiveClass
    ] += 1;
    reservation.cursorInFlight += 1;
    reservation.providerClassInFlight.cursor.interactive += 1;
    remaining.splice(remaining.indexOf(selected), 1);
    availableSlots -= 1;
  }

  return planned;
}

export function resolveLaneFromOutbox(row: OutboxRow): AiOrchestratorLane | null {
  const payload = row.payload as Record<string, unknown>;
  return isAiRunV2WorkloadLane(payload.workloadLane)
    ? payload.workloadLane
    : null;
}

export function resolveCapacityClassFromOutbox(
  row: OutboxRow,
): AiRunV2CapacityClass | null {
  const payload = row.payload as Record<string, unknown>;
  return isAiRunV2CapacityClass(payload.capacityClass)
    ? payload.capacityClass
    : null;
}

export function planAdmissionBatch(input: {
  rows: OutboxRow[];
  utilization: ProviderUtilization;
  reservation?: ProviderCapacityReservation;
  uncertainWorkerCount: number;
  config?: ProviderCapacityConfig;
  uncertainPauseThreshold?: number;
}): AdmissionCandidate[] {
  const config = input.config ?? DEFAULT_PROVIDER_CAPACITY;
  const threshold =
    input.uncertainPauseThreshold ?? UNCERTAIN_WORKER_PAUSE_THRESHOLD;
  const working =
    input.reservation ??
    createProviderCapacityReservation(input.utilization);
  const planned: AdmissionCandidate[] = [];

  for (const row of input.rows) {
    if (row.kind !== 'dispatch_command') continue;
    const lane = resolveLaneFromOutbox(row);
    if (!lane) {
      planned.push({
        outbox: row,
        queueName: null,
        lane: null,
        capacityClass: null,
        decision: { status: 'deny', reason: 'unknown_lane' },
      });
      continue;
    }
    const queueName = AI_RUN_V2_LANE_QUEUES[lane];
    const capacityClass = resolveCapacityClassFromOutbox(row);

    const decision = evaluateDispatchCapacity({
      lane,
      utilization: working,
      config,
      uncertainWorkerCount: input.uncertainWorkerCount,
      uncertainPauseThreshold: threshold,
      capacityClass,
    });
    planned.push({
      outbox: row,
      queueName,
      lane,
      capacityClass,
      decision,
    });
    if (decision.status === 'allow') {
      const provider = providerForLane(lane);
      if (provider === 'cursor') working.cursorInFlight += 1;
      else working.bedrockInFlight += 1;
      working.laneInFlight[lane] = (working.laneInFlight[lane] ?? 0) + 1;
      if (capacityClass) {
        working.providerClassInFlight[provider][capacityClass] += 1;
      }
    }
  }
  return planned;
}
