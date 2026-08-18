/**
 * Normalized Journey Map rollups (TBI-010 / FEAT-008).
 * Derives consecutive human route-view transitions and reconciles daily
 * identifier-free (from_route, to_route, day) buckets.
 */
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/drizzle';
import {
  OBSERVABILITY_CAPTURE_FLAG,
  UNKNOWN_ROUTE_TEMPLATE,
} from '../../shared/types/observability';
import { APEX_ROUTE_TEMPLATES, isRegisteredApexRouteTemplate } from '../../shared/utils/observabilityRouteRegistry';
import { isFeatureOperational } from './featureFlagService';
import { trackEvent } from './telemetry';

export const JOURNEY_INACTIVITY_MS = 30 * 60 * 1000;
export const JOURNEY_ROLLUP_LOCK_KEY = 'apex:journey-rollup';
export const JOURNEY_ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
export const JOURNEY_ROLLUP_STARTUP_DELAY_MS = 2 * 60 * 1000;

export interface JourneySourceEvent {
  id: string;
  actorUserId: string | null;
  routeTemplate: string | null;
  occurredAt: string;
  eventType: string;
  browserEventType?: string | null;
  trigger?: string | null;
}

export interface JourneyTransition {
  fromRoute: string;
  toRoute: string;
  day: string;
}

export interface JourneyEdgeRollup {
  fromRoute: string;
  toRoute: string;
  day: string;
  transitionCount: number;
  distinctActorCount: number;
}

export interface JourneyReconcileRange {
  fromDay: string;
  throughDay: string;
}

export interface JourneyStoreReconcileResult {
  lockAcquired: boolean;
  edgesWritten: number;
  sourceRowsConsidered: number;
  daysReconciled: number;
}

export interface JourneyAggregationStore {
  reconcileDays(range: JourneyReconcileRange): Promise<JourneyStoreReconcileResult>;
}

export type JourneyAggregationCycleStatus = 'completed' | 'disabled' | 'lock_skipped';

export interface JourneyAggregationCycleResult {
  status: JourneyAggregationCycleStatus;
  daysReconciled: number;
  edgesWritten: number;
  sourceRowsConsidered: number;
  durationMs: number;
}

export interface JourneyDaysResult {
  daysReconciled: number;
  edgesWritten: number;
}

export interface JourneyAggregationDb {
  execute: (query: unknown) => Promise<unknown>;
  transaction: (
    fn: (tx: { execute: (query: unknown) => Promise<unknown> }) => Promise<unknown>,
  ) => Promise<unknown>;
}

export interface JourneyAggregationDeps {
  db?: JourneyAggregationDb;
  store?: JourneyAggregationStore;
  isCaptureEnabled?: () => Promise<boolean>;
  now?: () => Date;
  track?: typeof trackEvent;
  afterTargetDayDelete?: () => Promise<void>;
}

export interface JourneyAggregationService {
  runJourneyAggregationCycle(): Promise<JourneyAggregationCycleResult>;
  reconcileJourneyDays(fromDay: string, throughDay: string): Promise<JourneyDaysResult>;
}

export interface JourneyDeriveOptions {
  fromDay?: string;
  throughDay?: string;
}

interface ActorScopedTransition extends JourneyTransition {
  actorUserId: string;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function isLockAcquired(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

export function utcDayOf(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, delta: number): string {
  return utcDayOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000));
}

export function inclusiveUtcDayCount(fromDay: string, throughDay: string): number {
  if (fromDay > throughDay) return 0;
  return Math.round((Date.parse(`${throughDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / 86_400_000) + 1;
}

export function isEligibleJourneySource(event: JourneySourceEvent): boolean {
  if (!event.actorUserId) return false;
  if (event.eventType !== 'ui_action') return false;
  if (event.browserEventType !== 'route_view') return false;
  if (event.trigger === 'poll') return false;
  if (!event.routeTemplate || event.routeTemplate === UNKNOWN_ROUTE_TEMPLATE) return false;
  return isRegisteredApexRouteTemplate(event.routeTemplate);
}

function uniqueById(events: JourneySourceEvent[]): JourneySourceEvent[] {
  const seen = new Set<string>();
  const unique: JourneySourceEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function compareSourceEvents(left: JourneySourceEvent, right: JourneySourceEvent): number {
  const byActor = (left.actorUserId ?? '').localeCompare(right.actorUserId ?? '');
  if (byActor !== 0) return byActor;
  const leftMs = Date.parse(left.occurredAt);
  const rightMs = Date.parse(right.occurredAt);
  if (leftMs !== rightMs) return leftMs - rightMs;
  return left.id.localeCompare(right.id);
}

function deriveActorTransitions(events: JourneySourceEvent[]): ActorScopedTransition[] {
  const eligible = uniqueById(events).filter(isEligibleJourneySource).sort(compareSourceEvents);
  const transitions: ActorScopedTransition[] = [];

  for (let index = 1; index < eligible.length; index += 1) {
    const previous = eligible[index - 1]!;
    const current = eligible[index]!;
    if (previous.actorUserId !== current.actorUserId) continue;
    const gapMs = Date.parse(current.occurredAt) - Date.parse(previous.occurredAt);
    if (gapMs > JOURNEY_INACTIVITY_MS) continue;
    if (previous.routeTemplate === current.routeTemplate) continue;
    transitions.push({
      actorUserId: current.actorUserId as string,
      fromRoute: previous.routeTemplate as string,
      toRoute: current.routeTemplate as string,
      day: utcDayOf(current.occurredAt),
    });
  }
  return transitions;
}

function inDayRange(day: string, options?: JourneyDeriveOptions): boolean {
  if (options?.fromDay && day < options.fromDay) return false;
  if (options?.throughDay && day > options.throughDay) return false;
  return true;
}

export function deriveJourneyTransitions(
  events: JourneySourceEvent[],
  options?: JourneyDeriveOptions,
): JourneyTransition[] {
  return deriveActorTransitions(events)
    .filter((row) => inDayRange(row.day, options))
    .map(({ fromRoute, toRoute, day }) => ({ fromRoute, toRoute, day }));
}

export function aggregateJourneyEdges(
  events: JourneySourceEvent[],
  options?: JourneyDeriveOptions,
): JourneyEdgeRollup[] {
  const grouped = new Map<string, { fromRoute: string; toRoute: string; day: string; actors: Set<string>; count: number }>();
  for (const row of deriveActorTransitions(events)) {
    if (!inDayRange(row.day, options)) continue;
    const key = `${row.day}\0${row.fromRoute}\0${row.toRoute}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.actors.add(row.actorUserId);
    } else {
      grouped.set(key, {
        fromRoute: row.fromRoute,
        toRoute: row.toRoute,
        day: row.day,
        actors: new Set([row.actorUserId]),
        count: 1,
      });
    }
  }
  return [...grouped.values()]
    .map((row) => ({
      fromRoute: row.fromRoute,
      toRoute: row.toRoute,
      day: row.day,
      transitionCount: row.count,
      distinctActorCount: row.actors.size,
    }))
    .sort((left, right) => {
      const byDay = left.day.localeCompare(right.day);
      if (byDay !== 0) return byDay;
      const byFrom = left.fromRoute.localeCompare(right.fromRoute);
      if (byFrom !== 0) return byFrom;
      return left.toRoute.localeCompare(right.toRoute);
    });
}

function emitSafeMetric(
  track: typeof trackEvent,
  name: string,
  props?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  try {
    track(name, props, measurements);
  } catch {
    // Telemetry must never affect aggregation.
  }
}

function createSqlStore(
  drizzle: JourneyAggregationDb,
  afterTargetDayDelete?: () => Promise<void>,
): JourneyAggregationStore {
  return {
    async reconcileDays(range: JourneyReconcileRange): Promise<JourneyStoreReconcileResult> {
      const daysReconciled = inclusiveUtcDayCount(range.fromDay, range.throughDay);
      if (daysReconciled === 0) {
        return { lockAcquired: true, edgesWritten: 0, sourceRowsConsidered: 0, daysReconciled: 0 };
      }

      const lookbackStart = new Date(
        Date.parse(`${range.fromDay}T00:00:00.000Z`) - JOURNEY_INACTIVITY_MS,
      ).toISOString();
      const throughEnd = `${addUtcDays(range.throughDay, 1)}T00:00:00.000Z`;
      const templates = sql.join(
        APEX_ROUTE_TEMPLATES.map((template) => sql`${template}`),
        sql`, `,
      );

      return (await drizzle.transaction(async (tx) => {
        const lockResult = await tx.execute(sql`
          SELECT pg_try_advisory_xact_lock(hashtext(${JOURNEY_ROLLUP_LOCK_KEY})) AS acquired
        `);
        const acquired = isLockAcquired(resultRows<{ acquired?: unknown }>(lockResult)[0]?.acquired);
        if (!acquired) {
          return { lockAcquired: false, edgesWritten: 0, sourceRowsConsidered: 0, daysReconciled: 0 };
        }

        await tx.execute(sql`
          DELETE FROM trace_path_rollups
          WHERE day >= ${range.fromDay}::date
            AND day <= ${range.throughDay}::date
        `);

        if (afterTargetDayDelete) {
          await afterTargetDayDelete();
        }

        const inserted = await tx.execute(sql`
          WITH eligible AS (
            SELECT
              id,
              actor_user_id,
              route_template,
              occurred_at
            FROM trace_events
            WHERE event_type = 'ui_action'
              AND actor_user_id IS NOT NULL
              AND route_template IN (${templates})
              AND COALESCE(details->>'trigger', 'human') <> 'poll'
              AND details->>'browserEventType' = 'route_view'
              AND occurred_at >= ${lookbackStart}::timestamptz
              AND occurred_at < ${throughEnd}::timestamptz
          ),
          ordered AS (
            SELECT
              actor_user_id,
              route_template,
              occurred_at,
              LAG(route_template) OVER (
                PARTITION BY actor_user_id
                ORDER BY occurred_at, id
              ) AS prev_route,
              LAG(occurred_at) OVER (
                PARTITION BY actor_user_id
                ORDER BY occurred_at, id
              ) AS prev_occurred_at
            FROM eligible
          ),
          edges AS (
            SELECT
              prev_route AS from_route,
              route_template AS to_route,
              ((occurred_at AT TIME ZONE 'UTC')::date) AS day,
              actor_user_id
            FROM ordered
            WHERE prev_route IS NOT NULL
              AND prev_route <> route_template
              AND occurred_at - prev_occurred_at <= INTERVAL '30 minutes'
              AND ((occurred_at AT TIME ZONE 'UTC')::date) >= ${range.fromDay}::date
              AND ((occurred_at AT TIME ZONE 'UTC')::date) <= ${range.throughDay}::date
          )
          INSERT INTO trace_path_rollups (
            from_route,
            to_route,
            day,
            transition_count,
            distinct_actor_count
          )
          SELECT
            from_route,
            to_route,
            day,
            COUNT(*)::int AS transition_count,
            COUNT(DISTINCT actor_user_id)::int AS distinct_actor_count
          FROM edges
          GROUP BY from_route, to_route, day
          RETURNING id
        `);

        const source = await tx.execute(sql`
          SELECT COUNT(*)::int AS source_rows
          FROM trace_events
          WHERE event_type = 'ui_action'
            AND actor_user_id IS NOT NULL
            AND route_template IN (${templates})
            AND COALESCE(details->>'trigger', 'human') <> 'poll'
            AND details->>'browserEventType' = 'route_view'
            AND occurred_at >= ${lookbackStart}::timestamptz
            AND occurred_at < ${throughEnd}::timestamptz
        `);

        return {
          lockAcquired: true,
          edgesWritten: resultRows(inserted).length,
          sourceRowsConsidered: Number(resultRows<{ source_rows?: number }>(source)[0]?.source_rows ?? 0),
          daysReconciled,
        };
      })) as JourneyStoreReconcileResult;
    },
  };
}

export function createJourneyAggregationService(
  deps: JourneyAggregationDeps = {},
): JourneyAggregationService {
  const drizzle: JourneyAggregationDb = deps.db ?? (defaultDb as unknown as JourneyAggregationDb);
  const store = deps.store ?? createSqlStore(drizzle, deps.afterTargetDayDelete);
  const isCaptureEnabled =
    deps.isCaptureEnabled ?? (() => isFeatureOperational(OBSERVABILITY_CAPTURE_FLAG));
  const now = deps.now ?? (() => new Date());
  const track = deps.track ?? trackEvent;

  async function reconcileJourneyDays(fromDay: string, throughDay: string): Promise<JourneyDaysResult> {
    const result = await store.reconcileDays({ fromDay, throughDay });
    if (!result.lockAcquired) {
      return { daysReconciled: 0, edgesWritten: 0 };
    }
    return { daysReconciled: result.daysReconciled, edgesWritten: result.edgesWritten };
  }

  async function runJourneyAggregationCycle(): Promise<JourneyAggregationCycleResult> {
    const startedAt = now().getTime();
    const enabled = await isCaptureEnabled();

    // @feature-flag:observability-capture start winner=enabled
    if (!enabled) {
      // @feature-flag:observability-capture disabled-start
      const durationMs = Math.max(0, now().getTime() - startedAt);
      emitSafeMetric(
        track,
        'observability.journey_rollup.disabled',
        { status: 'disabled' },
        { durationMs, daysReconciled: 0, edgesWritten: 0, sourceRowsConsidered: 0 },
      );
      return {
        status: 'disabled',
        daysReconciled: 0,
        edgesWritten: 0,
        sourceRowsConsidered: 0,
        durationMs,
      };
      // @feature-flag:observability-capture disabled-end
    }

    // @feature-flag:observability-capture enabled-start
    const current = now();
    const throughDay = utcDayOf(current);
    const fromDay = addUtcDays(throughDay, -1);
    const storeResult = await store.reconcileDays({ fromDay, throughDay });
    const durationMs = Math.max(0, now().getTime() - startedAt);

    if (!storeResult.lockAcquired) {
      emitSafeMetric(
        track,
        'observability.journey_rollup.lock_skipped',
        { status: 'lock_skipped' },
        { durationMs, daysReconciled: 0, edgesWritten: 0, sourceRowsConsidered: 0 },
      );
      return {
        status: 'lock_skipped',
        daysReconciled: 0,
        edgesWritten: 0,
        sourceRowsConsidered: 0,
        durationMs,
      };
    }

    emitSafeMetric(
      track,
      'observability.journey_rollup.completed',
      { status: 'completed', fromDay, throughDay },
      {
        durationMs,
        daysReconciled: storeResult.daysReconciled,
        edgesWritten: storeResult.edgesWritten,
        sourceRowsConsidered: storeResult.sourceRowsConsidered,
      },
    );
    return {
      status: 'completed',
      daysReconciled: storeResult.daysReconciled,
      edgesWritten: storeResult.edgesWritten,
      sourceRowsConsidered: storeResult.sourceRowsConsidered,
      durationMs,
    };
    // @feature-flag:observability-capture enabled-end
    // @feature-flag:observability-capture end
  }

  return { runJourneyAggregationCycle, reconcileJourneyDays };
}

let singleton: JourneyAggregationService | null = null;

export function getJourneyAggregationService(): JourneyAggregationService {
  singleton ??= createJourneyAggregationService();
  return singleton;
}

export function resetJourneyAggregationServiceForTests(): void {
  singleton = null;
}
