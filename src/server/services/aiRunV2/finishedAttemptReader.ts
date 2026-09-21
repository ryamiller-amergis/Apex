/**
 * Finds V2 runs that are over, and hands out the claim that lets exactly one
 * instance consume each finished attempt.
 *
 * Nothing here knows what an artifact means. Callers pass the thread ids they
 * own and interpret the manifest themselves, which is what keeps prototype
 * knowledge out of the transport.
 *
 * Both the run header and the attempt must be terminal before an attempt is
 * offered. The reconciler's retry path fails an attempt and immediately
 * dispatches a replacement, which puts the header back to `dispatched`;
 * consuming the loser then would apply a superseded run's output.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import {
  isAiRunBlobRef,
  type AiRunBlobRef,
} from '../../../shared/types/aiRunV2';
import { createInboxRepository, type InboxRepository } from './inboxRepository';
import type { SqlExecutor } from './outboxRepository';

export type FinishedV2AttemptStatus = 'completed' | 'failed' | 'cancelled';

export type FinishedV2Attempt = Readonly<{
  attemptId: string;
  runId: string;
  threadId: string;
  dispatchMessageId: string;
  status: FinishedV2AttemptStatus;
  /** Present only when the worker uploaded artifacts. */
  manifestRef: AiRunBlobRef | null;
  failureDetail: string | null;
}>;

export type HarvestClaim = 'claimed' | 'already_harvested';

export type FinishedAttemptReader = {
  listFinishedByThread(
    threadIds: readonly string[],
  ): Promise<Map<string, FinishedV2Attempt>>;
  claimHarvest(attempt: FinishedV2Attempt): Promise<HarvestClaim>;
  completeHarvest(attemptId: string): Promise<void>;
};

/**
 * The claim is durable and permanent, so an attempt already applied is never
 * applied again — not by another instance, and not by a later sweep after the
 * owning row has been retried back into its transient status.
 */
export function harvestEventId(attemptId: string): string {
  return `artifact-harvest:${attemptId}`;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function parseManifestRef(value: unknown): AiRunBlobRef | null {
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  return isAiRunBlobRef(parsed) ? parsed : null;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function createFinishedAttemptReader(deps?: {
  executor?: SqlExecutor;
  inbox?: InboxRepository;
}): FinishedAttemptReader {
  const executor = deps?.executor ?? {
    execute: (query: unknown) => db.execute(query as never),
  };
  const inbox = deps?.inbox ?? createInboxRepository(executor);

  return {
    async listFinishedByThread(threadIds) {
      const finished = new Map<string, FinishedV2Attempt>();
      if (threadIds.length === 0) return finished;

      const threadList = sql.join(
        threadIds.map((threadId) => sql`${threadId}`),
        sql`, `,
      );
      const result = await executor.execute(sql`
        SELECT DISTINCT ON (r.thread_id)
          r.thread_id,
          a.id AS attempt_id,
          a.run_id,
          a.dispatch_message_id,
          a.status,
          a.manifest_ref,
          a.failure_detail
        FROM ai_run_attempts a
        JOIN agent_runs r ON r.id = a.run_id
        WHERE r.transport_version = 'servicebus-blob-v2'
          AND r.thread_id IN (${threadList})
          AND r.status IN ('completed', 'failed', 'cancelled')
          AND a.status IN ('completed', 'failed', 'cancelled')
        ORDER BY r.thread_id, a.created_at DESC, a.attempt_number DESC
      `);

      for (const row of resultRows<Record<string, unknown>>(result)) {
        const threadId = String(row.thread_id);
        finished.set(threadId, {
          attemptId: String(row.attempt_id),
          runId: String(row.run_id),
          threadId,
          dispatchMessageId: String(row.dispatch_message_id),
          status: row.status as FinishedV2AttemptStatus,
          manifestRef: parseManifestRef(row.manifest_ref),
          failureDetail:
            row.failure_detail == null ? null : String(row.failure_detail),
        });
      }
      return finished;
    },

    async claimHarvest(attempt) {
      const claim = await inbox.claimEvent({
        eventId: harvestEventId(attempt.attemptId),
        kind: 'artifact_harvest',
        runId: attempt.runId,
        attemptId: attempt.attemptId,
        dispatchMessageId: attempt.dispatchMessageId,
        payload: {
          threadId: attempt.threadId,
          status: attempt.status,
          manifestRef: attempt.manifestRef,
        },
      });
      // An unprocessed duplicate is a claim whose holder died before applying
      // anything, so it is retried rather than abandoned.
      return claim.status === 'duplicate_processed'
        ? 'already_harvested'
        : 'claimed';
    },

    async completeHarvest(attemptId) {
      await inbox.markProcessed(harvestEventId(attemptId));
    },
  };
}
