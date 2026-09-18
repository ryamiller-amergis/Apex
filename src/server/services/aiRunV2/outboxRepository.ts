import { sql } from 'drizzle-orm';
import type { AiRunV2Command } from '../../../shared/types/aiRunV2';

export type SqlExecutor = {
  execute(query: unknown): Promise<unknown>;
};

export type OutboxKind = 'dispatch_command' | 'checkpoint_notify' | 'terminal_result';

export type OutboxRow = Readonly<{
  id: string;
  idempotencyKey: string;
  kind: OutboxKind;
  runId: string;
  attemptId: string | null;
  payload: Record<string, unknown>;
  availableAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  publishAttempts: number;
  lastError: string | null;
  publishedAt: string | null;
  createdAt: string;
}>;

export type EnqueueOutboxInput = Readonly<{
  idempotencyKey: string;
  kind: OutboxKind;
  runId: string;
  attemptId?: string | null;
  payload: Record<string, unknown> | AiRunV2Command;
  availableAt?: string;
}>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function mapOutboxRow(row: Record<string, unknown>): OutboxRow {
  const availableAt = row.available_at;
  const claimedAt = row.claimed_at;
  const claimExpiresAt = row.claim_expires_at;
  const publishedAt = row.published_at;
  const createdAt = row.created_at;
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    kind: row.kind as OutboxKind,
    runId: String(row.run_id),
    attemptId: row.attempt_id == null ? null : String(row.attempt_id),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    availableAt:
      availableAt instanceof Date ? availableAt.toISOString() : String(availableAt),
    claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
    claimedAt:
      claimedAt == null
        ? null
        : claimedAt instanceof Date
          ? claimedAt.toISOString()
          : String(claimedAt),
    claimExpiresAt:
      claimExpiresAt == null
        ? null
        : claimExpiresAt instanceof Date
          ? claimExpiresAt.toISOString()
          : String(claimExpiresAt),
    publishAttempts: Number(row.publish_attempts ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    publishedAt:
      publishedAt == null
        ? null
        : publishedAt instanceof Date
          ? publishedAt.toISOString()
          : String(publishedAt),
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  };
}

export function createOutboxRepository(executor: SqlExecutor) {
  return {
    async enqueue(messages: EnqueueOutboxInput[]): Promise<OutboxRow[]> {
      const inserted: OutboxRow[] = [];
      for (const message of messages) {
        const result = await executor.execute(sql`
          INSERT INTO ai_run_outbox (
            idempotency_key,
            kind,
            run_id,
            attempt_id,
            payload,
            available_at
          ) VALUES (
            ${message.idempotencyKey},
            ${message.kind},
            ${message.runId},
            ${message.attemptId ?? null},
            ${JSON.stringify(message.payload)}::jsonb,
            COALESCE(${message.availableAt ?? null}::timestamptz, now())
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING *
        `);
        const row = resultRows<Record<string, unknown>>(result)[0];
        if (row) inserted.push(mapOutboxRow(row));
      }
      return inserted;
    },

    async claimBatch(
      limit: number,
      holderId: string,
      claimMs: number,
    ): Promise<OutboxRow[]> {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error('limit must be a positive integer');
      }
      if (!Number.isInteger(claimMs) || claimMs <= 0) {
        throw new Error('claimMs must be a positive integer');
      }
      const result = await executor.execute(sql`
        WITH due AS (
          SELECT id
          FROM ai_run_outbox
          WHERE published_at IS NULL
            AND available_at <= now()
            AND (
              claimed_by IS NULL
              OR claim_expires_at IS NULL
              OR claim_expires_at <= now()
            )
          ORDER BY available_at ASC, created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE ai_run_outbox AS outbox
        SET
          claimed_by = ${holderId},
          claimed_at = now(),
          claim_expires_at = now() + (${claimMs} * interval '1 millisecond'),
          publish_attempts = outbox.publish_attempts + 1
        FROM due
        WHERE outbox.id = due.id
        RETURNING outbox.*
      `);
      return resultRows<Record<string, unknown>>(result).map(mapOutboxRow);
    },

    async markPublished(ids: string[], holderId: string): Promise<number> {
      if (ids.length === 0) return 0;
      const result = await executor.execute(sql`
        UPDATE ai_run_outbox
        SET
          published_at = now(),
          last_error = NULL,
          claim_expires_at = NULL
        WHERE id = ANY(${ids}::text[])
          AND claimed_by = ${holderId}
          AND published_at IS NULL
        RETURNING id
      `);
      return resultRows(result).length;
    },

    async markFailed(
      id: string,
      holderId: string,
      error: string,
      retryDelayMs = 0,
    ): Promise<boolean> {
      if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
        throw new Error('retryDelayMs must be a non-negative integer');
      }
      const result = await executor.execute(sql`
        UPDATE ai_run_outbox
        SET
          last_error = ${error},
          claimed_by = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          available_at = now() + (${retryDelayMs} * interval '1 millisecond')
        WHERE id = ${id}
          AND claimed_by = ${holderId}
          AND published_at IS NULL
        RETURNING id
      `);
      return resultRows(result).length > 0;
    },
  };
}

export type OutboxRepository = ReturnType<typeof createOutboxRepository>;
