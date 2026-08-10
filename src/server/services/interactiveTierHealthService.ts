/**
 * FEAT-007 / TBI-012 — interactive lane health + first-token SLO evaluation.
 *
 * Extends the worker-tier health surface consumed by `GET /api/health/agents`
 * with `interactiveSaturation` and `firstTokenSloStatus`. The pure evaluator
 * decides when telemetry must raise an alert (first-token P95 SLO breach OR
 * reserved capacity exhausted) — PBI-007 (h).
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  INTERACTIVE_LANE,
  type InteractiveSloStatus,
  type InteractiveTierHealth,
} from '../../shared/types/interactiveWorkflow';
import {
  resolveFirstTokenSloMs,
  resolveInteractiveCapacity,
} from './interactiveActorAdmissionService';

export interface EvaluateInteractiveTierHealthInput {
  interactiveInFlight: number;
  reserved: number;
  burstMax: number;
  /** Observed first-token latency P95 (ms); null when no sample window exists. */
  observedFirstTokenP95Ms: number | null;
  firstTokenSloMs: number;
}

/**
 * Pure health evaluation. `alert` fires on a first-token SLO breach or when
 * reserved+burst capacity is fully consumed (interactive saturation).
 */
export function evaluateInteractiveTierHealth(
  input: EvaluateInteractiveTierHealthInput,
): InteractiveTierHealth {
  const capacity = input.reserved + input.burstMax;
  const interactiveSaturation =
    capacity > 0 ? input.interactiveInFlight / capacity : 0;
  const reservedExhausted = input.interactiveInFlight >= capacity && capacity > 0;

  let firstTokenSloStatus: InteractiveSloStatus = 'unknown';
  if (
    input.observedFirstTokenP95Ms !== null &&
    Number.isFinite(input.observedFirstTokenP95Ms)
  ) {
    firstTokenSloStatus =
      input.observedFirstTokenP95Ms > input.firstTokenSloMs ? 'breach' : 'ok';
  }

  return {
    interactiveSaturation,
    firstTokenSloStatus,
    alert: firstTokenSloStatus === 'breach' || reservedExhausted,
  };
}

type InteractiveTierHealthDependencies = {
  resolveCapacity?: typeof resolveInteractiveCapacity;
  resolveFirstTokenSloMs?: typeof resolveFirstTokenSloMs;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createInteractiveTierHealthService(
  dependencies: InteractiveTierHealthDependencies = {},
): {
  getInteractiveTierHealthStats(
    observedFirstTokenP95Ms?: number | null,
  ): Promise<InteractiveTierHealth>;
} {
  const resolveCapacity =
    dependencies.resolveCapacity ?? resolveInteractiveCapacity;
  const resolveSlo =
    dependencies.resolveFirstTokenSloMs ?? resolveFirstTokenSloMs;

  return {
    async getInteractiveTierHealthStats(
      observedFirstTokenP95Ms: number | null = null,
    ): Promise<InteractiveTierHealth> {
      const result = await db.execute(sql`
        SELECT COUNT(*)::int AS in_flight
        FROM agent_runs
        WHERE lane = ${INTERACTIVE_LANE}
          AND status IN ('dispatched', 'running')
      `);
      const interactiveInFlight = numberValue(
        resultRows<{ in_flight: number | string }>(result)[0]?.in_flight,
      );
      const { reserved, burstMax } = resolveCapacity();
      return evaluateInteractiveTierHealth({
        interactiveInFlight,
        reserved,
        burstMax,
        observedFirstTokenP95Ms,
        firstTokenSloMs: resolveSlo(),
      });
    },
  };
}

const defaultInteractiveTierHealthService =
  createInteractiveTierHealthService();

export function getInteractiveTierHealthStats(
  observedFirstTokenP95Ms?: number | null,
): Promise<InteractiveTierHealth> {
  return defaultInteractiveTierHealthService.getInteractiveTierHealthStats(
    observedFirstTokenP95Ms,
  );
}
