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
import {
  isDocumentWorkflowClass,
  type AiRunV2DocumentSpecification,
} from '../../../shared/types/aiRunV2DocumentSpec';
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

export type FinishedV2DocumentAttempt = FinishedV2Attempt &
  Readonly<{
    attemptNumber: number;
    workflowClass: AiRunV2DocumentSpecification['workflowClass'];
  }>;

export type HarvestClaim = 'claimed' | 'already_harvested';

export type FinishedAttemptReader = {
  listFinishedByThread(
    threadIds: readonly string[],
  ): Promise<Map<string, FinishedV2Attempt>>;
  listFinishedDocuments(
    limit: number,
  ): Promise<FinishedV2DocumentAttempt[]>;
  isDocumentHarvestPending(runId: string): Promise<boolean>;
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

    async listFinishedDocuments(limit) {
      const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
      const result = await executor.execute(sql`
        SELECT latest.*
        FROM (
          SELECT DISTINCT ON (r.thread_id)
            r.thread_id,
            r.created_at AS run_created_at,
            r.execution_snapshot->>'workflowClass' AS workflow_class,
            a.id AS attempt_id,
            a.attempt_number,
            a.run_id,
            a.dispatch_message_id,
            a.status,
            a.manifest_ref,
            a.failure_detail
          FROM ai_run_attempts a
          JOIN agent_runs r ON r.id = a.run_id
          WHERE r.transport_version = 'servicebus-blob-v2'
            AND r.status IN ('completed', 'failed', 'cancelled')
            AND a.status IN ('completed', 'failed', 'cancelled')
            AND r.execution_snapshot->>'workflowClass' IN (
              'prd',
              'design-doc',
              'validation',
              'test-cases',
              'walkthrough-smart-tagging'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM agent_runs newer
              WHERE newer.thread_id = r.thread_id
                AND (
                  newer.created_at > r.created_at
                  OR (
                    newer.created_at = r.created_at
                    AND newer.id > r.id
                  )
                )
            )
          ORDER BY
            r.thread_id,
            r.created_at DESC,
            a.attempt_number DESC
        ) latest
        WHERE NOT EXISTS (
          SELECT 1
          FROM ai_run_inbox harvested
          WHERE harvested.event_id =
            'artifact-harvest:' || latest.attempt_id
            AND harvested.processed_at IS NOT NULL
        )
        ORDER BY latest.run_created_at ASC, latest.run_id ASC
        LIMIT ${boundedLimit}
      `);

      const finished: FinishedV2DocumentAttempt[] = [];
      for (const row of resultRows<Record<string, unknown>>(result)) {
        if (!isDocumentWorkflowClass(row.workflow_class)) continue;
        finished.push({
          attemptId: String(row.attempt_id),
          attemptNumber: Number(row.attempt_number),
          runId: String(row.run_id),
          threadId: String(row.thread_id),
          dispatchMessageId: String(row.dispatch_message_id),
          status: row.status as FinishedV2AttemptStatus,
          manifestRef: parseManifestRef(row.manifest_ref),
          failureDetail:
            row.failure_detail == null ? null : String(row.failure_detail),
          workflowClass: row.workflow_class,
        });
      }
      return finished;
    },

    async isDocumentHarvestPending(runId) {
      const result = await executor.execute(sql`
        SELECT TRUE AS pending
        FROM agent_runs r
        JOIN LATERAL (
          SELECT attempt.id, attempt.status
          FROM ai_run_attempts attempt
          WHERE attempt.run_id = r.id
          ORDER BY attempt.attempt_number DESC
          LIMIT 1
        ) latest_attempt ON TRUE
        WHERE r.id = ${runId}
          AND r.transport_version = 'servicebus-blob-v2'
          AND r.status IN ('completed', 'failed', 'cancelled')
          AND latest_attempt.status IN ('completed', 'failed', 'cancelled')
          AND r.execution_snapshot->>'workflowClass' IN (
            'prd',
            'design-doc',
            'validation',
            'test-cases',
            'walkthrough-smart-tagging'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ai_run_inbox harvested
            WHERE harvested.event_id =
              'artifact-harvest:' || latest_attempt.id
              AND harvested.processed_at IS NOT NULL
          )
        LIMIT 1
      `);
      return resultRows(result).length > 0;
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

export function isDocumentHarvestPendingForRun(
  runId: string,
): Promise<boolean> {
  return createFinishedAttemptReader().isDocumentHarvestPending(runId);
}
