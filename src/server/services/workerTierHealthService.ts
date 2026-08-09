import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { resolveBackgroundInFlightLimit } from './admissionGovernorService';

const BACKGROUND_LANE = 'background';

export interface WorkerTierHealthStats {
  workerTierSaturation: number;
  oldestQueuedAgeMs: number;
}

type WorkerTierHealthDependencies = {
  resolveLimit?: () => number;
  now?: () => Date;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageInMilliseconds(now: Date, timestamp: string | Date | null): number {
  if (!timestamp) return 0;
  const timestampMs = timestamp instanceof Date
    ? timestamp.getTime()
    : Date.parse(timestamp);
  return Number.isFinite(timestampMs)
    ? Math.max(0, now.getTime() - timestampMs)
    : 0;
}

export function createWorkerTierHealthService(
  dependencies: WorkerTierHealthDependencies = {},
): {
  getWorkerTierHealthStats(): Promise<WorkerTierHealthStats>;
} {
  const resolveLimit =
    dependencies.resolveLimit ?? resolveBackgroundInFlightLimit;
  const now = dependencies.now ?? (() => new Date());

  return {
    async getWorkerTierHealthStats(): Promise<WorkerTierHealthStats> {
      const result = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE lane = ${BACKGROUND_LANE}
              AND status IN ('dispatched', 'running')
          )::int AS in_flight,
          COUNT(*) FILTER (
            WHERE lane = ${BACKGROUND_LANE}
              AND status = 'queued'
          )::int AS queued_depth,
          MIN(queued_at) FILTER (
            WHERE lane = ${BACKGROUND_LANE}
              AND status = 'queued'
          ) AS oldest_queued_at
        FROM agent_runs
      `);
      const row = resultRows<{
        in_flight: number | string | null;
        queued_depth: number | string | null;
        oldest_queued_at: string | Date | null;
      }>(result)[0];
      const inFlight = numberValue(row?.in_flight);
      const cap = resolveLimit();
      const queuedDepth = numberValue(row?.queued_depth);

      return {
        workerTierSaturation: cap > 0 ? inFlight / cap : 0,
        oldestQueuedAgeMs: queuedDepth > 0
          ? ageInMilliseconds(now(), row?.oldest_queued_at ?? null)
          : 0,
      };
    },
  };
}

const defaultWorkerTierHealthService = createWorkerTierHealthService();

export async function getWorkerTierHealthStats(): Promise<WorkerTierHealthStats> {
  return defaultWorkerTierHealthService.getWorkerTierHealthStats();
}
