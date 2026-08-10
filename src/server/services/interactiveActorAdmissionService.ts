/**
 * FEAT-007 / TBI-010 — reserved-capacity actor activation admission.
 *
 * Interactive "capacity" is warm actor availability, not a broker cap. In one
 * concurrency-safe DB transaction this counts interactive-lane in-flight work
 * and, if warm capacity is free, fences a queued interactive run into
 * `dispatched`. Reserved slots are filled before burst; beyond reserved+burst
 * the activation SHEDS immediately so the caller routes in-process rather than
 * queuing (BR-014). Background admission counts only its own lane, so it can
 * never consume a reserved interactive slot (lane isolation).
 */
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  INTERACTIVE_LANE,
  type InteractiveAdmissionDecision,
  type InteractiveCapacity,
} from '../../shared/types/interactiveWorkflow';

const DEFAULT_INTERACTIVE_RESERVED = 4;
const DEFAULT_INTERACTIVE_BURST_MAX = 12;
const MAX_INTERACTIVE_CAPACITY = 200;
const DEFAULT_FIRST_TOKEN_SLO_MS = 1_500;
const MIN_FIRST_TOKEN_SLO_MS = 100;
const MAX_FIRST_TOKEN_SLO_MS = 60_000;
const DISPATCHED_PROGRESS_LABEL = 'Starting…';

function resolveBoundedInteger(
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = rawValue?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

/**
 * Reserved warm floor. Equals the ACA actor app `min_replicas`; background can
 * never consume it. Env: `AI_RUNS_INTERACTIVE_RESERVED` (default 4).
 */
export function resolveInteractiveReserved(
  rawValue = process.env.AI_RUNS_INTERACTIVE_RESERVED,
): number {
  return resolveBoundedInteger(
    rawValue,
    DEFAULT_INTERACTIVE_RESERVED,
    0,
    MAX_INTERACTIVE_CAPACITY,
  );
}

/**
 * Burst headroom above reserved before shedding. Env:
 * `AI_RUNS_INTERACTIVE_BURST_MAX` (default 12).
 */
export function resolveInteractiveBurstMax(
  rawValue = process.env.AI_RUNS_INTERACTIVE_BURST_MAX,
): number {
  return resolveBoundedInteger(
    rawValue,
    DEFAULT_INTERACTIVE_BURST_MAX,
    0,
    MAX_INTERACTIVE_CAPACITY,
  );
}

export function resolveInteractiveCapacity(): InteractiveCapacity {
  return {
    reserved: resolveInteractiveReserved(),
    burstMax: resolveInteractiveBurstMax(),
  };
}

/**
 * First-token latency SLO (P95). Gates the alert threshold. Env:
 * `AI_RUNS_INTERACTIVE_FIRST_TOKEN_SLO_MS` (default 1500 ms).
 */
export function resolveFirstTokenSloMs(
  rawValue = process.env.AI_RUNS_INTERACTIVE_FIRST_TOKEN_SLO_MS,
): number {
  return resolveBoundedInteger(
    rawValue,
    DEFAULT_FIRST_TOKEN_SLO_MS,
    MIN_FIRST_TOKEN_SLO_MS,
    MAX_FIRST_TOKEN_SLO_MS,
  );
}

export interface InteractiveAdmissionTransaction {
  /** Serializes the count+claim decision across concurrent governors. */
  acquireLock(): Promise<void>;
  /** Interactive-lane dispatched+running count (excludes the candidate run). */
  countInFlight(): Promise<number>;
  /**
   * Fence a queued interactive run into `dispatched`. Returns false when the
   * row is no longer queued (a concurrent governor won the race).
   */
  dispatch(
    runId: string,
    dispatchMessageId: string,
    dispatchedAt: string,
  ): Promise<boolean>;
}

export interface InteractiveAdmissionStore {
  runInTransaction<T>(
    work: (tx: InteractiveAdmissionTransaction) => Promise<T>,
  ): Promise<T>;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const postgresInteractiveAdmissionStore: InteractiveAdmissionStore = {
  runInTransaction<T>(
    work: (tx: InteractiveAdmissionTransaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (databaseTransaction) => work({
      async acquireLock(): Promise<void> {
        await databaseTransaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('apex_ai_run_interactive_admission'))`,
        );
      },
      async countInFlight(): Promise<number> {
        const result = await databaseTransaction.execute(sql`
          SELECT COUNT(*)::int AS in_flight
          FROM agent_runs
          WHERE lane = ${INTERACTIVE_LANE}
            AND status IN ('dispatched', 'running')
        `);
        return numberValue(resultRows<{ in_flight: number | string }>(result)[0]?.in_flight);
      },
      async dispatch(
        runId: string,
        dispatchMessageId: string,
        dispatchedAt: string,
      ): Promise<boolean> {
        const result = await databaseTransaction.execute(sql`
          UPDATE agent_runs
          SET status = 'dispatched',
              lane = ${INTERACTIVE_LANE},
              dispatch_message_id = ${dispatchMessageId},
              dispatched_at = ${dispatchedAt},
              progress_phase = 'dispatched',
              progress_label = ${DISPATCHED_PROGRESS_LABEL},
              updated_at = ${dispatchedAt}
          WHERE id = ${runId}
            AND status = 'queued'
          RETURNING id
        `);
        return resultRows<{ id: string }>(result).length > 0;
      },
    }));
  },
};

type InteractiveAdmissionDependencies = {
  store?: InteractiveAdmissionStore;
  resolveCapacity?: () => InteractiveCapacity;
  randomUuid?: () => string;
  now?: () => Date;
};

export interface InteractiveActorAdmissionService {
  /**
   * Attempt to admit an actor activation for a queued interactive run. Fills
   * reserved then burst; sheds above burst or when a concurrent governor wins.
   */
  admit(runId: string): Promise<InteractiveAdmissionDecision>;
}

export function createInteractiveActorAdmissionService(
  dependencies: InteractiveAdmissionDependencies = {},
): InteractiveActorAdmissionService {
  const store = dependencies.store ?? postgresInteractiveAdmissionStore;
  const resolveCapacity =
    dependencies.resolveCapacity ?? resolveInteractiveCapacity;
  const createUuid = dependencies.randomUuid ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  return {
    async admit(runId: string): Promise<InteractiveAdmissionDecision> {
      const { reserved, burstMax } = resolveCapacity();
      const capacity = reserved + burstMax;

      return store.runInTransaction(async (tx) => {
        await tx.acquireLock();
        const interactiveInFlight = await tx.countInFlight();

        // BR-014: over reserved+burst sheds immediately (never queues).
        if (interactiveInFlight >= capacity) {
          return {
            admitted: false,
            shed: true,
            reason: 'over-capacity',
            interactiveInFlight,
            reserved,
            burstMax,
          };
        }

        const dispatchMessageId = createUuid();
        const claimed = await tx.dispatch(
          runId,
          dispatchMessageId,
          now().toISOString(),
        );
        if (!claimed) {
          // A concurrent governor advanced this row first — fail closed to
          // in-process rather than double-admitting.
          return {
            admitted: false,
            shed: true,
            reason: 'race-lost',
            interactiveInFlight,
            reserved,
            burstMax,
          };
        }

        return {
          admitted: true,
          shed: false,
          slot: interactiveInFlight < reserved ? 'reserved' : 'burst',
          dispatchMessageId,
          interactiveInFlight: interactiveInFlight + 1,
          reserved,
          burstMax,
        };
      });
    },
  };
}

export const interactiveActorAdmissionService =
  createInteractiveActorAdmissionService();
