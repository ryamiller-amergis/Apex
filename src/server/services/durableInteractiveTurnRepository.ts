import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  DurableInteractiveTurnSpecification,
  FrozenInteractiveToolGrant,
  ImmutableInteractiveAttachmentRef,
  InteractiveClass,
  InteractiveDeadlinePolicy,
  InteractiveDispatchOutboxPayload,
  InteractiveTurnAcceptedResponse,
  InteractiveTurnAcceptedStatus,
} from '../../shared/types/durableInteractiveTurn';
import {
  absoluteTurnMsForClass,
  isCanonicalUuid,
  isDurableInteractiveTurnSpecification,
  isDurableUserIdentity,
} from '../../shared/types/durableInteractiveTurn';
import { db } from '../db/drizzle';
import {
  notifyOutbox,
  type SqlExecutor,
} from './aiRunV2/outboxRepository';

const QUEUED_PROGRESS_LABEL = 'Queued — waiting for available worker';

export type PreparedDurableInteractiveTurn = Readonly<{
  turnId: string;
  requestHash: string;
  threadId: string;
  userId: string;
  projectId: string;
  interactiveClass: InteractiveClass;
  messageText: string;
  hidden: boolean;
  attachments: ReadonlyArray<ImmutableInteractiveAttachmentRef>;
  specification: DurableInteractiveTurnSpecification;
}>;

export type AdmitDurableInteractiveTurnResult =
  | (InteractiveTurnAcceptedResponse & { idempotent: boolean })
  | Readonly<{ status: 'thread_active'; activeRunId: string }>
  | Readonly<{
      status: 'user_limit';
      code: 'USER_INTERACTIVE_LIMIT' | 'USER_AGENTIC_LIMIT';
    }>
  | Readonly<{ status: 'turn_conflict' }>;

export type RetryDurableInteractiveRunInput = Readonly<{
  threadId: string;
  runId: string;
  userId: string;
  refreshedToolGrant: FrozenInteractiveToolGrant | null;
  refreshedDeadlines: InteractiveDeadlinePolicy;
}>;

export type RetryDurableInteractiveRunResult =
  | InteractiveTurnAcceptedResponse
  | Readonly<{
      status: 'user_limit';
      code: 'USER_INTERACTIVE_LIMIT' | 'USER_AGENTIC_LIMIT';
    }>
  | Readonly<{ status: 'thread_active'; activeRunId: string }>
  | Readonly<{ status: 'not_retryable' }>;

export interface DurableInteractiveTurnRepository {
  admit(
    input: PreparedDurableInteractiveTurn,
  ): Promise<AdmitDurableInteractiveTurnResult>;
  retry(
    input: RetryDurableInteractiveRunInput,
  ): Promise<RetryDurableInteractiveRunResult>;
}

export type DurableInteractiveAdmissionWriteStage =
  | 'message'
  | 'attachments'
  | 'run'
  | 'attempt'
  | 'outbox'
  | 'queued_event'
  | 'thread';

type TransactionRunner = <T>(
  work: (executor: SqlExecutor) => Promise<T>,
) => Promise<T>;

type ExistingTurnRow = Readonly<{
  id: string;
  client_turn_hash: string;
  status: string;
  interactive_class: InteractiveClass;
}>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

function isoTimestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Interactive admission returned invalid ${label}`);
  }
  return date.toISOString();
}

function duplicateStatus(status: string): InteractiveTurnAcceptedStatus {
  switch (status) {
    case 'queued':
    case 'dispatched':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return status;
    default:
      throw new Error(`Unsupported durable interactive run status: ${status}`);
  }
}

function assertPreparedTurn(input: PreparedDurableInteractiveTurn): void {
  if (
    !isCanonicalUuid(input.turnId) ||
    !isCanonicalUuid(input.threadId) ||
    !isDurableUserIdentity(input.userId)
  ) {
    throw new Error('Durable interactive turn identity is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) {
    throw new Error('Durable interactive request hash must be lowercase SHA-256');
  }
  if (
    input.specification.turnId !== input.turnId ||
    input.specification.threadId !== input.threadId ||
    input.specification.userId !== input.userId ||
    input.specification.projectId !== input.projectId ||
    input.specification.interactiveClass !== input.interactiveClass
  ) {
    throw new Error('Durable interactive specification identity mismatch');
  }
}

function assertRetryInput(input: RetryDurableInteractiveRunInput): void {
  if (
    !isCanonicalUuid(input.threadId) ||
    !isCanonicalUuid(input.runId) ||
    !isDurableUserIdentity(input.userId)
  ) {
    throw new Error('Durable interactive retry identity is invalid');
  }
}

function isActiveAttemptStatus(status: string): boolean {
  return (
    status === 'queued' || status === 'dispatched' || status === 'running'
  );
}

function cloneSpecificationForRetry(
  previous: DurableInteractiveTurnSpecification,
  refreshedToolGrant: FrozenInteractiveToolGrant | null,
  refreshedDeadlines: InteractiveDeadlinePolicy,
): DurableInteractiveTurnSpecification {
  return {
    ...previous,
    toolGrant: refreshedToolGrant,
    deadlines: refreshedDeadlines,
  };
}

const defaultTransactionRunner: TransactionRunner = async (work) =>
  db.transaction(async (tx) =>
    work({ execute: (query) => tx.execute(query as never) }),
  );

export function createDurableInteractiveTurnRepository(options?: {
  runInTransaction?: TransactionRunner;
  newId?: () => string;
  afterWrite?: (
    stage: DurableInteractiveAdmissionWriteStage,
  ) => Promise<void> | void;
}): DurableInteractiveTurnRepository {
  const runInTransaction =
    options?.runInTransaction ?? defaultTransactionRunner;
  const newId = options?.newId ?? randomUUID;
  const afterWrite = options?.afterWrite ?? (() => undefined);

  return {
    async admit(input) {
      assertPreparedTurn(input);
      return runInTransaction(async (executor) => {
        await executor.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended('interactive-user:' || ${input.userId}, 0)
          )
        `);

        const threadResult = await executor.execute(sql`
          SELECT id, user_id, active_run_id
          FROM chat_threads
          WHERE id = ${input.threadId}::uuid
          FOR UPDATE
        `);
        const lockedThread = resultRows<{
          id: string;
          user_id: string;
          active_run_id: string | null;
        }>(threadResult)[0];
        if (!lockedThread) {
          throw Object.assign(new Error('Thread not found'), { status: 404 });
        }

        const existingResult = await executor.execute(sql`
          SELECT id, client_turn_hash, status, interactive_class
          FROM agent_runs
          WHERE thread_id = ${input.threadId}
            AND client_turn_id = ${input.turnId}::uuid
          LIMIT 1
        `);
        const existing = resultRows<ExistingTurnRow>(existingResult)[0];
        if (existing) {
          if (existing.client_turn_hash !== input.requestHash) {
            return { status: 'turn_conflict' };
          }
          return {
            turnId: input.turnId,
            runId: existing.id,
            status: duplicateStatus(existing.status),
            interactiveClass: existing.interactive_class,
            idempotent: true,
            shouldReflectThreadState:
              lockedThread.active_run_id === null ||
              lockedThread.active_run_id === existing.id,
          };
        }

        const activeThreadResult = await executor.execute(sql`
          SELECT id
          FROM agent_runs
          WHERE thread_id = ${input.threadId}
            AND lane = 'ai-runs-interactive'
            AND status IN ('queued', 'dispatched', 'running')
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `);
        const activeThread = resultRows<{ id: string }>(
          activeThreadResult,
        )[0];
        if (activeThread) {
          return {
            status: 'thread_active',
            activeRunId: activeThread.id,
          };
        }

        const countResult = await executor.execute(sql`
          SELECT
            COUNT(*)::int AS active_count,
            COUNT(*) FILTER (
              WHERE interactive_class = 'agentic'
            )::int AS agentic_count
          FROM agent_runs
          WHERE requested_by_user_id = ${input.userId}
            AND lane = 'ai-runs-interactive'
            AND status IN ('queued', 'dispatched', 'running')
        `);
        const counts = resultRows<{
          active_count: number | string;
          agentic_count: number | string;
        }>(countResult)[0];
        const activeCount = Number(counts?.active_count ?? 0);
        const agenticCount = Number(counts?.agentic_count ?? 0);
        if (activeCount >= 2) {
          return {
            status: 'user_limit',
            code: 'USER_INTERACTIVE_LIMIT',
          };
        }
        if (input.interactiveClass === 'agentic' && agenticCount >= 1) {
          return {
            status: 'user_limit',
            code: 'USER_AGENTIC_LIMIT',
          };
        }

        const clockResult = await executor.execute(sql`
          SELECT
            accepted_at,
            accepted_at + (
              ${input.specification.deadlines.absoluteTurnMs}
              * INTERVAL '1 millisecond'
            ) AS deadline_at
          FROM (SELECT now() AS accepted_at) AS admission_clock
        `);
        const clock = resultRows<{
          accepted_at: string | Date;
          deadline_at: string | Date;
        }>(clockResult)[0];
        if (!clock) {
          throw new Error('Interactive admission database clock unavailable');
        }
        const acceptedAt = isoTimestamp(clock.accepted_at, 'accepted_at');
        const deadlineAt = isoTimestamp(clock.deadline_at, 'deadline_at');
        const runId = newId();
        const attemptId = newId();
        const dispatchMessageId = newId();
        const eventId = newId();

        await executor.execute(sql`
          INSERT INTO chat_messages (
            id,
            thread_id,
            role,
            text,
            hidden,
            ts
          ) VALUES (
            ${input.turnId}::uuid,
            ${input.threadId}::uuid,
            'user',
            ${input.messageText},
            ${input.hidden},
            ${acceptedAt}::timestamptz
          )
        `);
        await afterWrite('message');

        for (const attachment of input.attachments) {
          await executor.execute(sql`
            INSERT INTO chat_message_attachments (
              id,
              message_id,
              name,
              type,
              size,
              path,
              blob_ref,
              sha256
            ) VALUES (
              ${attachment.attachmentId}::uuid,
              ${input.turnId}::uuid,
              ${attachment.name},
              ${attachment.contentType},
              ${attachment.sizeBytes},
              ${attachment.materializedPath},
              ${JSON.stringify(attachment.blobRef)}::jsonb,
              ${attachment.sha256}
            )
          `);
        }
        await afterWrite('attachments');

        await executor.execute(sql`
          INSERT INTO agent_runs (
            id,
            thread_id,
            status,
            project_id,
            lane,
            queued_at,
            timeout_at,
            execution_snapshot,
            transport_version,
            requested_by_user_id,
            interactive_class,
            client_turn_id,
            client_turn_hash,
            cancel_requested,
            event_driven,
            progress_phase,
            progress_label,
            heartbeat_at,
            started_at,
            created_at,
            updated_at
          ) VALUES (
            ${runId},
            ${input.threadId},
            'queued',
            ${input.projectId},
            'ai-runs-interactive',
            ${acceptedAt}::timestamptz,
            ${deadlineAt}::timestamptz,
            ${JSON.stringify(input.specification)}::jsonb,
            'dapr-actor-v2',
            ${input.userId},
            ${input.interactiveClass},
            ${input.turnId}::uuid,
            ${input.requestHash},
            FALSE,
            TRUE,
            'queued',
            ${QUEUED_PROGRESS_LABEL},
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz
          )
        `);
        await afterWrite('run');

        await executor.execute(sql`
          INSERT INTO ai_run_attempts (
            id,
            run_id,
            attempt_number,
            dispatch_message_id,
            status,
            artifact_status,
            spec_snapshot,
            created_at,
            updated_at
          ) VALUES (
            ${attemptId},
            ${runId},
            1,
            ${dispatchMessageId},
            'queued',
            'pending',
            ${JSON.stringify(input.specification)}::jsonb,
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz
          )
        `);
        await afterWrite('attempt');

        const outboxPayload: InteractiveDispatchOutboxPayload = {
          schemaVersion: 2,
          kind: 'interactive_dispatch',
          transport: 'dapr-actor-v2',
          runId,
          attemptId,
          attemptNumber: 1,
          dispatchMessageId,
          threadId: input.threadId,
          userId: input.userId,
          interactiveClass: input.interactiveClass,
          workloadLane: input.interactiveClass,
          capacityClass: 'interactive',
          deadlineAt,
        };
        const outboxResult = await executor.execute(sql`
          INSERT INTO ai_run_outbox (
            idempotency_key,
            kind,
            run_id,
            attempt_id,
            payload,
            available_at,
            created_at
          ) VALUES (
            ${`${attemptId}:interactive-dispatch`},
            'interactive_dispatch',
            ${runId},
            ${attemptId},
            ${JSON.stringify(outboxPayload)}::jsonb,
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz
          )
          RETURNING id
        `);
        const outboxId = resultRows<{ id: string }>(outboxResult)[0]?.id;
        if (!outboxId) {
          throw new Error('Interactive dispatch outbox insert returned no id');
        }
        await afterWrite('outbox');

        const event = {
          type: 'phase' as const,
          phase: 'queued' as const,
          status: 'pending' as const,
          detail: QUEUED_PROGRESS_LABEL,
          runId,
          eventTimestamp: acceptedAt,
        };
        await executor.execute(sql`
          INSERT INTO agent_run_events (
            event_id,
            thread_id,
            run_id,
            source_instance,
            sequence,
            event_timestamp,
            event_type,
            phase,
            status,
            detail,
            event,
            created_at
          ) VALUES (
            ${eventId}::uuid,
            ${input.threadId},
            ${runId},
            'interactive-admission',
            1,
            ${acceptedAt}::timestamptz,
            'phase',
            'queued',
            'pending',
            ${QUEUED_PROGRESS_LABEL},
            ${JSON.stringify(event)}::jsonb,
            ${acceptedAt}::timestamptz
          )
        `);
        await afterWrite('queued_event');

        await executor.execute(sql`
          UPDATE chat_threads
          SET
            status = 'running',
            active_run_id = ${runId},
            last_error = NULL,
            last_activity_at = ${acceptedAt}::timestamptz
          WHERE id = ${input.threadId}::uuid
        `);
        await afterWrite('thread');

        await notifyOutbox(executor, { outboxId, runId });

        return {
          turnId: input.turnId,
          runId,
          status: 'queued',
          interactiveClass: input.interactiveClass,
          idempotent: false,
          shouldReflectThreadState: true,
        };
      });
    },

    async retry(input) {
      assertRetryInput(input);
      return runInTransaction(async (executor) => {
        await executor.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended('interactive-user:' || ${input.userId}, 0)
          )
        `);

        const threadResult = await executor.execute(sql`
          SELECT id, user_id, active_run_id
          FROM chat_threads
          WHERE id = ${input.threadId}::uuid
          FOR UPDATE
        `);
        const lockedThread = resultRows<{
          id: string;
          user_id: string;
          active_run_id: string | null;
        }>(threadResult)[0];
        if (!lockedThread) {
          throw Object.assign(new Error('Thread not found'), { status: 404 });
        }

        const runResult = await executor.execute(sql`
          SELECT
            id,
            thread_id,
            status,
            interactive_class,
            transport_version,
            requested_by_user_id,
            client_turn_id,
            execution_snapshot
          FROM agent_runs
          WHERE id = ${input.runId}
            AND thread_id = ${input.threadId}
          FOR UPDATE
        `);
        const lockedRun = resultRows<{
          id: string;
          thread_id: string;
          status: string;
          interactive_class: InteractiveClass;
          transport_version: string | null;
          requested_by_user_id: string | null;
          client_turn_id: string | null;
          execution_snapshot: unknown;
        }>(runResult)[0];
        if (!lockedRun) {
          throw Object.assign(new Error('Thread not found'), { status: 404 });
        }

        const attemptResult = await executor.execute(sql`
          SELECT
            id,
            attempt_number,
            status,
            dispatch_message_id,
            spec_snapshot
          FROM ai_run_attempts
          WHERE run_id = ${input.runId}
          ORDER BY attempt_number DESC
          LIMIT 1
          FOR UPDATE
        `);
        const latestAttempt = resultRows<{
          id: string;
          attempt_number: number | string;
          status: string;
          dispatch_message_id: string;
          spec_snapshot: unknown;
        }>(attemptResult)[0];
        if (!latestAttempt) {
          return { status: 'not_retryable' };
        }

        const latestAttemptNumber = Number(latestAttempt.attempt_number);
        if (
          lockedRun.transport_version === 'dapr-actor-v2' &&
          isActiveAttemptStatus(latestAttempt.status)
        ) {
          if (!lockedRun.client_turn_id) {
            return { status: 'not_retryable' };
          }
          return {
            turnId: lockedRun.client_turn_id,
            runId: lockedRun.id,
            status: duplicateStatus(latestAttempt.status),
            interactiveClass: lockedRun.interactive_class,
          };
        }

        if (
          lockedRun.transport_version !== 'dapr-actor-v2' ||
          lockedRun.status !== 'failed' ||
          latestAttempt.status !== 'failed' ||
          !lockedRun.client_turn_id
        ) {
          return { status: 'not_retryable' };
        }

        const previousSpecRaw = latestAttempt.spec_snapshot;
        const previousSpec =
          typeof previousSpecRaw === 'string'
            ? (JSON.parse(previousSpecRaw) as unknown)
            : previousSpecRaw;
        if (!isDurableInteractiveTurnSpecification(previousSpec)) {
          return { status: 'not_retryable' };
        }
        if (
          previousSpec.deadlines.absoluteTurnMs !==
          absoluteTurnMsForClass(lockedRun.interactive_class)
        ) {
          return { status: 'not_retryable' };
        }
        if (
          input.refreshedDeadlines.absoluteTurnMs !==
          absoluteTurnMsForClass(lockedRun.interactive_class)
        ) {
          throw new Error(
            'Retry deadlines absoluteTurnMs must match the persisted interactive class',
          );
        }

        const activeThreadResult = await executor.execute(sql`
          SELECT id
          FROM agent_runs
          WHERE thread_id = ${input.threadId}
            AND lane = 'ai-runs-interactive'
            AND status IN ('queued', 'dispatched', 'running')
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `);
        const activeThread = resultRows<{ id: string }>(
          activeThreadResult,
        )[0];
        if (activeThread) {
          return {
            status: 'thread_active',
            activeRunId: activeThread.id,
          };
        }

        const countResult = await executor.execute(sql`
          SELECT
            COUNT(*)::int AS active_count,
            COUNT(*) FILTER (
              WHERE interactive_class = 'agentic'
            )::int AS agentic_count
          FROM agent_runs
          WHERE requested_by_user_id = ${input.userId}
            AND lane = 'ai-runs-interactive'
            AND status IN ('queued', 'dispatched', 'running')
        `);
        const counts = resultRows<{
          active_count: number | string;
          agentic_count: number | string;
        }>(countResult)[0];
        const activeCount = Number(counts?.active_count ?? 0);
        const agenticCount = Number(counts?.agentic_count ?? 0);
        if (activeCount >= 2) {
          return {
            status: 'user_limit',
            code: 'USER_INTERACTIVE_LIMIT',
          };
        }
        if (
          lockedRun.interactive_class === 'agentic' &&
          agenticCount >= 1
        ) {
          return {
            status: 'user_limit',
            code: 'USER_AGENTIC_LIMIT',
          };
        }

        const absoluteTurnMs = absoluteTurnMsForClass(
          lockedRun.interactive_class,
        );
        const clockResult = await executor.execute(sql`
          SELECT
            accepted_at,
            accepted_at + (
              ${absoluteTurnMs}
              * INTERVAL '1 millisecond'
            ) AS deadline_at
          FROM (SELECT now() AS accepted_at) AS retry_clock
        `);
        const clock = resultRows<{
          accepted_at: string | Date;
          deadline_at: string | Date;
        }>(clockResult)[0];
        if (!clock) {
          throw new Error('Interactive retry database clock unavailable');
        }
        const acceptedAt = isoTimestamp(clock.accepted_at, 'accepted_at');
        const deadlineAt = isoTimestamp(clock.deadline_at, 'deadline_at');
        const attemptId = newId();
        const dispatchMessageId = newId();
        const eventId = newId();
        const nextAttemptNumber = latestAttemptNumber + 1;
        const specification = cloneSpecificationForRetry(
          previousSpec,
          input.refreshedToolGrant,
          input.refreshedDeadlines,
        );

        await executor.execute(sql`
          UPDATE agent_runs
          SET
            status = 'queued',
            timeout_at = ${deadlineAt}::timestamptz,
            execution_snapshot = ${JSON.stringify(specification)}::jsonb,
            cancel_requested = FALSE,
            progress_phase = 'queued',
            progress_label = ${QUEUED_PROGRESS_LABEL},
            heartbeat_at = ${acceptedAt}::timestamptz,
            started_at = ${acceptedAt}::timestamptz,
            last_error = NULL,
            updated_at = ${acceptedAt}::timestamptz
          WHERE id = ${input.runId}
        `);
        await afterWrite('run');

        await executor.execute(sql`
          INSERT INTO ai_run_attempts (
            id,
            run_id,
            attempt_number,
            dispatch_message_id,
            status,
            artifact_status,
            spec_snapshot,
            created_at,
            updated_at
          ) VALUES (
            ${attemptId},
            ${input.runId},
            ${nextAttemptNumber},
            ${dispatchMessageId},
            'queued',
            'pending',
            ${JSON.stringify(specification)}::jsonb,
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz
          )
        `);
        await afterWrite('attempt');

        const outboxPayload: InteractiveDispatchOutboxPayload = {
          schemaVersion: 2,
          kind: 'interactive_dispatch',
          transport: 'dapr-actor-v2',
          runId: input.runId,
          attemptId,
          attemptNumber: nextAttemptNumber,
          dispatchMessageId,
          threadId: input.threadId,
          userId: input.userId,
          interactiveClass: lockedRun.interactive_class,
          workloadLane: lockedRun.interactive_class,
          capacityClass: 'interactive',
          deadlineAt,
        };
        const outboxResult = await executor.execute(sql`
          INSERT INTO ai_run_outbox (
            idempotency_key,
            kind,
            run_id,
            attempt_id,
            payload,
            available_at,
            created_at
          ) VALUES (
            ${`${attemptId}:interactive-dispatch`},
            'interactive_dispatch',
            ${input.runId},
            ${attemptId},
            ${JSON.stringify(outboxPayload)}::jsonb,
            ${acceptedAt}::timestamptz,
            ${acceptedAt}::timestamptz
          )
          RETURNING id
        `);
        const outboxId = resultRows<{ id: string }>(outboxResult)[0]?.id;
        if (!outboxId) {
          throw new Error('Interactive retry outbox insert returned no id');
        }
        await afterWrite('outbox');

        const sequenceResult = await executor.execute(sql`
          SELECT COALESCE(MAX(sequence), 0)::int AS max_sequence
          FROM agent_run_events
          WHERE run_id = ${input.runId}
        `);
        const maxSequence = Number(
          resultRows<{ max_sequence: number | string }>(sequenceResult)[0]
            ?.max_sequence ?? 0,
        );
        const nextSequence = maxSequence + 1;
        const event = {
          type: 'phase' as const,
          phase: 'queued' as const,
          status: 'pending' as const,
          detail: QUEUED_PROGRESS_LABEL,
          runId: input.runId,
          eventTimestamp: acceptedAt,
        };
        await executor.execute(sql`
          INSERT INTO agent_run_events (
            event_id,
            thread_id,
            run_id,
            source_instance,
            sequence,
            event_timestamp,
            event_type,
            phase,
            status,
            detail,
            event,
            created_at
          ) VALUES (
            ${eventId}::uuid,
            ${input.threadId},
            ${input.runId},
            'interactive-retry',
            ${nextSequence},
            ${acceptedAt}::timestamptz,
            'phase',
            'queued',
            'pending',
            ${QUEUED_PROGRESS_LABEL},
            ${JSON.stringify(event)}::jsonb,
            ${acceptedAt}::timestamptz
          )
        `);
        await afterWrite('queued_event');

        await executor.execute(sql`
          UPDATE chat_threads
          SET
            status = 'running',
            active_run_id = ${input.runId},
            last_error = NULL,
            last_activity_at = ${acceptedAt}::timestamptz
          WHERE id = ${input.threadId}::uuid
        `);
        await afterWrite('thread');

        await notifyOutbox(executor, { outboxId, runId: input.runId });

        return {
          turnId: lockedRun.client_turn_id,
          runId: input.runId,
          status: 'queued',
          interactiveClass: lockedRun.interactive_class,
        };
      });
    },
  };
}

export const durableInteractiveTurnRepository =
  createDurableInteractiveTurnRepository();
