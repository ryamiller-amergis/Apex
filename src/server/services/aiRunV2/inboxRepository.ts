import { sql } from 'drizzle-orm';

export type SqlExecutor = {
  execute(query: unknown): Promise<unknown>;
};

/**
 * `artifact_harvest` is claimed by the App Service rather than by a queue
 * consumer: it records that an owning service has already read a finished
 * attempt's artifact and applied it to its own row.
 */
export type InboxKind =
  | 'checkpoint'
  | 'terminal_result'
  | 'command_ack'
  | 'artifact_harvest';

export type InboxClaimResult =
  | { status: 'inserted'; eventId: string }
  | { status: 'duplicate_unprocessed'; eventId: string }
  | { status: 'duplicate_processed'; eventId: string };

export type InboxRow = Readonly<{
  eventId: string;
  kind: InboxKind;
  runId: string;
  attemptId: string;
  dispatchMessageId: string;
  checkpointSequence: number | null;
  payload: Record<string, unknown>;
  receivedAt: string;
  processedAt: string | null;
}>;

export type ClaimInboxEventInput = Readonly<{
  eventId: string;
  kind: InboxKind;
  runId: string;
  attemptId: string;
  dispatchMessageId: string;
  checkpointSequence?: number | null;
  payload: Record<string, unknown>;
}>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function mapInboxRow(row: Record<string, unknown>): InboxRow {
  const receivedAt = row.received_at;
  const processedAt = row.processed_at;
  return {
    eventId: String(row.event_id),
    kind: row.kind as InboxKind,
    runId: String(row.run_id),
    attemptId: String(row.attempt_id),
    dispatchMessageId: String(row.dispatch_message_id),
    checkpointSequence:
      row.checkpoint_sequence == null ? null : Number(row.checkpoint_sequence),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    receivedAt:
      receivedAt instanceof Date
        ? receivedAt.toISOString()
        : String(receivedAt),
    processedAt:
      processedAt == null
        ? null
        : processedAt instanceof Date
          ? processedAt.toISOString()
          : String(processedAt),
  };
}

export function createInboxRepository(executor: SqlExecutor) {
  return {
    async claimEvent(input: ClaimInboxEventInput): Promise<InboxClaimResult> {
      if (
        input.checkpointSequence != null &&
        (!Number.isInteger(input.checkpointSequence) ||
          input.checkpointSequence <= 0)
      ) {
        throw new Error(
          'checkpointSequence must be a positive integer when provided'
        );
      }

      const inserted = await executor.execute(sql`
        INSERT INTO ai_run_inbox (
          event_id,
          kind,
          run_id,
          attempt_id,
          dispatch_message_id,
          checkpoint_sequence,
          payload
        ) VALUES (
          ${input.eventId},
          ${input.kind},
          ${input.runId},
          ${input.attemptId},
          ${input.dispatchMessageId},
          ${input.checkpointSequence ?? null},
          ${JSON.stringify(input.payload)}::jsonb
        )
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id
      `);
      if (resultRows(inserted).length > 0) {
        return { status: 'inserted', eventId: input.eventId };
      }

      const existing = await executor.execute(sql`
        SELECT event_id, processed_at
        FROM ai_run_inbox
        WHERE event_id = ${input.eventId}
        FOR UPDATE
      `);
      const row = resultRows<{
        event_id: string;
        processed_at: string | Date | null;
      }>(existing)[0];
      if (!row) {
        throw new Error(
          `Inbox event disappeared after conflict: ${input.eventId}`
        );
      }
      if (row.processed_at == null) {
        return { status: 'duplicate_unprocessed', eventId: input.eventId };
      }
      return { status: 'duplicate_processed', eventId: input.eventId };
    },

    async markProcessed(eventId: string): Promise<boolean> {
      const result = await executor.execute(sql`
        UPDATE ai_run_inbox
        SET processed_at = now()
        WHERE event_id = ${eventId}
          AND processed_at IS NULL
        RETURNING event_id
      `);
      return resultRows(result).length > 0;
    },

    async getEvent(eventId: string): Promise<InboxRow | null> {
      const result = await executor.execute(sql`
        SELECT *
        FROM ai_run_inbox
        WHERE event_id = ${eventId}
      `);
      const row = resultRows<Record<string, unknown>>(result)[0];
      return row ? mapInboxRow(row) : null;
    },
  };
}

export type InboxRepository = ReturnType<typeof createInboxRepository>;
