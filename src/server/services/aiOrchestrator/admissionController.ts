/**
 * Leased V2 admission decisions for outbox command rows.
 */
import type { OutboxRow } from '../aiRunV2/outboxRepository';
import {
  evaluateDispatchCapacity,
  laneForQueueName,
  providerForLane,
} from './providerGovernor';
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
  queueName: string;
  lane: AiOrchestratorLane;
  decision: DispatchDecision;
}>;

export function resolveQueueNameFromOutbox(row: OutboxRow): string {
  const payload = row.payload as Record<string, unknown>;
  if (typeof payload.queueName === 'string' && payload.queueName.trim()) {
    return payload.queueName;
  }
  const laneHint =
    typeof payload.lane === 'string'
      ? payload.lane
      : typeof payload.kind === 'string'
        ? payload.kind
        : 'document';
  if (laneHint.includes('visual')) return 'ai-runs-v2-visual';
  if (laneHint.includes('fast')) return 'ai-runs-v2-fast';
  if (laneHint.includes('agentic')) return 'ai-runs-v2-agentic';
  return 'ai-runs-v2-document';
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
  };
  const planned: AdmissionCandidate[] = [];

  for (const row of input.rows) {
    if (row.kind !== 'dispatch_command') continue;
    const queueName = resolveQueueNameFromOutbox(row);
    const lane = laneForQueueName(queueName);
    if (!lane) continue;

    const decision = evaluateDispatchCapacity({
      lane,
      utilization: working,
      config,
      uncertainWorkerCount: input.uncertainWorkerCount,
      uncertainPauseThreshold: threshold,
    });
    planned.push({ outbox: row, queueName, lane, decision });
    if (decision.status === 'allow') {
      const provider = providerForLane(lane);
      if (provider === 'cursor') working.cursorInFlight += 1;
      else working.bedrockInFlight += 1;
      working.laneInFlight[lane] = (working.laneInFlight[lane] ?? 0) + 1;
    }
  }
  return planned;
}
