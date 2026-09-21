/**
 * Live provider and lane utilization for admission decisions.
 *
 * The lane is not a column on ai_run_attempts — it travels in the dispatch
 * command payload, so in-flight counts join back to the originating outbox row.
 */
import { sql } from 'drizzle-orm';
import { isAiRunV2WorkloadLane } from '../../../shared/types/aiRunV2';
import type { SqlExecutor } from '../aiRunV2/outboxRepository';
import { emptyUtilization, providerForLane } from './providerGovernor';
import type { ProviderUtilization } from './types';

export type UtilizationReaderDeps = Readonly<{
  executor: SqlExecutor;
}>;

type LaneCountRow = Readonly<{
  workload_lane: unknown;
  in_flight: unknown;
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
          o.payload->>'workloadLane' AS workload_lane,
          COUNT(*)::int AS in_flight
        FROM ai_run_attempts a
        JOIN agent_runs r
          ON r.id = a.run_id
         AND r.transport_version = 'servicebus-blob-v2'
        LEFT JOIN ai_run_outbox o
          ON o.attempt_id = a.id
         AND o.kind = 'dispatch_command'
        WHERE a.status IN ('dispatched', 'running', 'checking_worker', 'finalizing')
        GROUP BY 1
      `);

      const utilization = {
        cursorInFlight: 0,
        bedrockInFlight: 0,
        laneInFlight: { ...emptyUtilization().laneInFlight },
      };

      for (const row of resultRows<LaneCountRow>(result)) {
        const lane = row.workload_lane;
        if (!isAiRunV2WorkloadLane(lane)) continue;
        const count = Number(row.in_flight ?? 0);
        if (!Number.isFinite(count) || count <= 0) continue;
        utilization.laneInFlight[lane] += count;
        if (providerForLane(lane) === 'cursor') {
          utilization.cursorInFlight += count;
        } else {
          utilization.bedrockInFlight += count;
        }
      }

      return utilization;
    },
  };
}

export type UtilizationReader = ReturnType<typeof createUtilizationReader>;
