/**
 * Live provider and lane utilization for admission decisions.
 *
 * The lane is not a column on ai_run_attempts — it travels in the dispatch
 * command payload, so in-flight counts join back to the originating outbox row.
 */
import { sql } from 'drizzle-orm';
import {
  isAiRunV2CapacityClass,
  isAiRunV2WorkloadLane,
} from '../../../shared/types/aiRunV2';
import type { SqlExecutor } from '../aiRunV2/outboxRepository';
import { emptyUtilization, providerForLane } from './providerGovernor';
import type { ProviderUtilization } from './types';

export type UtilizationReaderDeps = Readonly<{
  executor: SqlExecutor;
}>;

type LaneCountRow = Readonly<{
  attempt_status: unknown;
  published_at: unknown;
  workload_lane: unknown;
  capacity_class: unknown;
}>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

export function createUtilizationReader(deps: UtilizationReaderDeps) {
  return {
    async read(): Promise<ProviderUtilization> {
      const result = await deps.executor.execute(sql`
        SELECT
          a.status AS attempt_status,
          o.published_at,
          o.payload->>'workloadLane' AS workload_lane,
          o.payload->>'capacityClass' AS capacity_class
        FROM ai_run_attempts a
        JOIN agent_runs r
          ON r.id = a.run_id
         AND r.transport_version = 'servicebus-blob-v2'
        LEFT JOIN ai_run_outbox o
          ON o.attempt_id = a.id
         AND o.kind = 'dispatch_command'
        WHERE a.status IN ('dispatched', 'running', 'checking_worker', 'finalizing')
      `);

      const utilization = {
        cursorInFlight: 0,
        bedrockInFlight: 0,
        laneInFlight: { ...emptyUtilization().laneInFlight },
        providerClassInFlight: {
          cursor: { ...emptyUtilization().providerClassInFlight.cursor },
          bedrock: { ...emptyUtilization().providerClassInFlight.bedrock },
        },
      };

      for (const row of resultRows<LaneCountRow>(result)) {
        const countsAsInFlight =
          row.attempt_status === 'running'
          || row.attempt_status === 'checking_worker'
          || row.attempt_status === 'finalizing'
          || (
            row.attempt_status === 'dispatched'
            && row.published_at != null
          );
        if (!countsAsInFlight) continue;
        const lane = row.workload_lane;
        if (!isAiRunV2WorkloadLane(lane)) continue;
        const provider = providerForLane(lane);
        utilization.laneInFlight[lane] += 1;
        if (provider === 'cursor') {
          utilization.cursorInFlight += 1;
        } else {
          utilization.bedrockInFlight += 1;
        }
        if (isAiRunV2CapacityClass(row.capacity_class)) {
          utilization.providerClassInFlight[provider][row.capacity_class] += 1;
        }
      }

      return utilization;
    },
  };
}

export type UtilizationReader = ReturnType<typeof createUtilizationReader>;
