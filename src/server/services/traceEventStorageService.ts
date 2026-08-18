import { db } from '../db/drizzle';
import { traceEvents } from '../db/schema';
import type { SafeTraceEventInput } from '../../shared/types/observability';
import { toSafeTraceEvent } from '../../shared/utils/traceRedaction';

export class TraceEventStorageError extends Error {
  readonly code = 'TRACE_EVENT_STORAGE_FAILED';

  constructor(readonly ruleId: 'insert_failed') {
    super(ruleId);
    this.name = 'TraceEventStorageError';
  }
}

export interface InsertSafeTraceEventsResult {
  insertedCount: number;
}

function toInsertRow(event: SafeTraceEventInput) {
  const safe = toSafeTraceEvent(event);
  return {
    eventType: safe.eventType,
    occurredAt: safe.occurredAt,
    actorUserId: safe.actorUserId,
    projectId: safe.projectId,
    traceId: safe.traceId,
    sessionId: safe.sessionId,
    routeTemplate: safe.routeTemplate,
    httpMethod: safe.httpMethod,
    statusCode: safe.statusCode,
    durationMs: safe.durationMs,
    severity: safe.severity,
    details: safe.details,
  };
}

export async function insertSafeTraceEvents(
  events: SafeTraceEventInput[],
): Promise<InsertSafeTraceEventsResult> {
  if (events.length === 0) {
    return { insertedCount: 0 };
  }

  const rows = events.map(toInsertRow);

  try {
    await db.insert(traceEvents).values(rows);
    return { insertedCount: rows.length };
  } catch {
    console.error(
      `[traceEventStorage] insert_failed count=${rows.length} eventTypes=${rows
        .map((row) => row.eventType)
        .join(',')}`,
    );
    throw new TraceEventStorageError('insert_failed');
  }
}
