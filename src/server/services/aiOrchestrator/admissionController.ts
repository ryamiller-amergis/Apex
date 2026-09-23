/**
 * Leased V2 admission decisions for outbox command rows.
 */
import {
  AI_RUN_V2_LANE_QUEUES,
  isAiRunV2CapacityClass,
  isAiRunV2WorkloadLane,
  type AiRunV2CapacityClass,
} from '../../../shared/types/aiRunV2';
import type { OutboxRow } from '../aiRunV2/outboxRepository';
import { evaluateDispatchCapacity, providerForLane } from './providerGovernor';
import type {
  AiOrchestratorLane,
  DispatchDecision,
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
  uncertainWorkerCount: number;
  config?: ProviderCapacityConfig;
  uncertainPauseThreshold?: number;
}): AdmissionCandidate[] {
  const config = input.config ?? DEFAULT_PROVIDER_CAPACITY;
  const threshold =
    input.uncertainPauseThreshold ?? UNCERTAIN_WORKER_PAUSE_THRESHOLD;
  const working = {
    cursorInFlight: input.utilization.cursorInFlight,
    bedrockInFlight: input.utilization.bedrockInFlight,
    laneInFlight: {
      document: input.utilization.laneInFlight.document,
      visual: input.utilization.laneInFlight.visual,
      fast: input.utilization.laneInFlight.fast,
      agentic: input.utilization.laneInFlight.agentic,
    },
    providerClassInFlight: {
      cursor: { ...input.utilization.providerClassInFlight.cursor },
      bedrock: { ...input.utilization.providerClassInFlight.bedrock },
    },
  };
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
