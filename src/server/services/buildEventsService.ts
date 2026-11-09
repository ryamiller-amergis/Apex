/**
 * Append-only build events. Redacts before insert. No update or delete function exists.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { BuildCorrelationKind, BuildEvent, BuildEventSeverity } from '../../shared/types/build';
import { BUILD_EVENT_SEVERITIES, BUILD_EVENT_TYPE_PATTERN } from '../../shared/types/build';
import { db } from '../db/drizzle';
import { buildEvents } from '../db/schema';
import { RedactionError, redactJson, redactText } from './buildRedactionService';

const MESSAGE_MAX = 8000;

export class BuildEventWriteRefusedError extends Error {
  readonly code = 'BUILD_EVENT_WRITE_REFUSED' as const;

  constructor() {
    super('Build event write refused');
    this.name = 'BuildEventWriteRefusedError';
  }
}

export interface AppendBuildEventInput {
  buildRunId: string;
  buildRevisionId?: string | null;
  eventType: string;
  severity?: BuildEventSeverity;
  message: string;
  detail?: Record<string, unknown> | null;
  correlation?: { kind: BuildCorrelationKind; id: string } | null;
  actorUserId?: string | null;
  dedupeKey?: string | null;
}

export type BuildEventExecutor = Pick<typeof db, 'insert'>;

export interface AppendBuildEventDeps {
  executor?: BuildEventExecutor;
  redact?: typeof redactText;
  redactJson?: typeof redactJson;
}

function logRefusal(buildRunId: string, eventType: string): void {
  console.error('[build-events]', JSON.stringify({
    buildRunId,
    eventType,
    reason: 'redaction_unprocessable',
  }));
}

function toBuildEvent(row: typeof buildEvents.$inferSelect): BuildEvent {
  return {
    id: row.id,
    ordinal: row.ordinal,
    buildRunId: row.buildRunId,
    buildRevisionId: row.buildRevisionId ?? null,
    eventType: row.eventType,
    severity: row.severity,
    message: row.message,
    detail: row.detail ?? null,
    correlationKind: row.correlationKind ?? null,
    correlationId: row.correlationId ?? null,
    actorUserId: row.actorUserId ?? null,
    dedupeKey: row.dedupeKey ?? null,
    createdAt: row.createdAt,
  };
}

export async function appendBuildEvent(
  input: AppendBuildEventInput,
  deps?: AppendBuildEventDeps,
): Promise<{ inserted: boolean; event: BuildEvent | null }> {
  const redact = deps?.redact ?? redactText;
  const redactDetail = deps?.redactJson ?? redactJson;
  const executor = deps?.executor ?? db;

  if (!BUILD_EVENT_TYPE_PATTERN.test(input.eventType)) {
    throw new BuildEventWriteRefusedError();
  }
  const severity = input.severity ?? 'info';
  if (!BUILD_EVENT_SEVERITIES.includes(severity)) {
    throw new BuildEventWriteRefusedError();
  }

  let message: string;
  let detail: Record<string, unknown> | null;
  try {
    message = redact(input.message).slice(0, MESSAGE_MAX);
    detail = input.detail == null ? null : redactDetail(input.detail);
  } catch (error) {
    if (error instanceof RedactionError || error instanceof Error) {
      logRefusal(input.buildRunId, input.eventType);
      throw new BuildEventWriteRefusedError();
    }
    throw error;
  }

  if (message.length < 1) {
    logRefusal(input.buildRunId, input.eventType);
    throw new BuildEventWriteRefusedError();
  }

  const rows = await executor
    .insert(buildEvents)
    .values({
      buildRunId: input.buildRunId,
      buildRevisionId: input.buildRevisionId ?? null,
      eventType: input.eventType,
      severity,
      message,
      detail,
      correlationKind: input.correlation?.kind ?? null,
      correlationId: input.correlation?.id ?? null,
      actorUserId: input.actorUserId ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({
      target: [buildEvents.buildRunId, buildEvents.dedupeKey],
      where: sql`${buildEvents.dedupeKey} IS NOT NULL`,
    })
    .returning();

  if (rows.length === 0) return { inserted: false, event: null };
  return { inserted: true, event: toBuildEvent(rows[0]) };
}

export async function listBuildEvents(
  buildRunId: string,
  options?: { afterOrdinal?: number; limit?: number },
): Promise<BuildEvent[]> {
  const limit = options?.limit ?? 200;
  const filters = [eq(buildEvents.buildRunId, buildRunId)];
  if (options?.afterOrdinal != null) filters.push(gt(buildEvents.ordinal, options.afterOrdinal));
  const rows = await db
    .select()
    .from(buildEvents)
    .where(and(...filters))
    .orderBy(asc(buildEvents.ordinal))
    .limit(limit);
  return rows.map(toBuildEvent);
}
