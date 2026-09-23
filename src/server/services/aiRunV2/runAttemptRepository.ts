import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/drizzle';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  isAiRunV2CapacityClass,
  isAiRunV2ActiveAttemptStatus,
  isAiRunV2TerminalAttemptStatus,
  type AiRunBlobRef,
  type AiRunV2AttemptStatus,
  type AiRunV2CapacityClass,
  type AiRunV2Checkpoint,
  type AiRunV2Command,
  type AiRunV2FailureCategory,
  type AiRunV2WorkloadLane,
} from '../../../shared/types/aiRunV2';
import type {
  AgentRunLane,
  AgentRunStatus,
  AgentRunTerminalReason,
} from '../../../shared/types/agentRunLifecycle';
import type { TerminalRunSubject } from '../agentRunTerminalEffects';
import { createOutboxRepository, type SqlExecutor } from './outboxRepository';
import { createInboxRepository } from './inboxRepository';

export type CreateQueuedV2RunInput = Readonly<{
  runId?: string;
  threadId: string;
  projectId: string;
  lane: AgentRunLane;
  timeoutAt: string;
  specRef: AiRunBlobRef;
  executionSnapshot?: Record<string, unknown>;
  ownerInstance?: string | null;
}>;

export type CreateQueuedV2RunResult =
  | {
      status: 'created';
      runId: string;
      attemptId: string;
      attemptNumber: number;
      dispatchMessageId: string;
    }
  | {
      status: 'active_run_conflict';
      existingRunId: string;
      existingTransportVersion: string;
      existingStatus: string;
    };

export type CreateDispatchedV2RunInput = CreateQueuedV2RunInput &
  Readonly<{
    workloadLane: AiRunV2WorkloadLane;
    capacityClass: AiRunV2CapacityClass;
  }>;

export type CreateDispatchedV2RunResult =
  | {
      status: 'dispatched';
      runId: string;
      attemptId: string;
      attemptNumber: number;
      dispatchMessageId: string;
      outboxId: string | null;
    }
  | Extract<CreateQueuedV2RunResult, { status: 'active_run_conflict' }>;

export type DispatchNextAttemptInput = Readonly<{
  runId: string;
  dispatchMessageId?: string;
  workloadLane: AiRunV2WorkloadLane;
  capacityClass: AiRunV2CapacityClass;
  specRef: AiRunBlobRef;
  deadlineAt?: string;
}>;

export type DispatchNextAttemptResult = Readonly<{
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
  outboxId: string | null;
}>;

export type TransitionAttemptInput = Readonly<{
  attemptId: string;
  expectedDispatchMessageId: string;
  to: AiRunV2AttemptStatus;
  artifactStatus?: string;
  failureCategory?: AiRunV2FailureCategory;
  failureDetail?: string;
  manifestRef?: AiRunBlobRef | null;
}>;

export type TransitionAttemptResult =
  | {
      status: 'ok';
      attemptId: string;
      to: AiRunV2AttemptStatus;
      /**
       * The run header this transaction wrote, present only when the attempt
       * reached a terminal status. The caller needs it to apply the shared
       * post-terminal effects without re-reading the row it just wrote.
       */
      run: TerminalRunSubject | null;
    }
  | { status: 'fence_mismatch' }
  | { status: 'not_found' }
  | {
      status: 'illegal_transition';
      from: AiRunV2AttemptStatus;
      to: AiRunV2AttemptStatus;
    };

export type AcceptCheckpointResult =
  | { status: 'accepted'; checkpointSequence: number }
  | { status: 'duplicate' }
  | { status: 'stale_sequence'; lastCheckpointSequence: number }
  | { status: 'fence_mismatch' }
  | { status: 'not_found' };

export type RunAttemptRepository = {
  createQueuedV2Run(
    input: CreateQueuedV2RunInput,
  ): Promise<CreateQueuedV2RunResult>;
  createDispatchedV2Run(
    input: CreateDispatchedV2RunInput,
  ): Promise<CreateDispatchedV2RunResult>;
  dispatchNextAttempt(
    input: DispatchNextAttemptInput,
  ): Promise<DispatchNextAttemptResult>;
  transitionAttempt(
    input: TransitionAttemptInput,
  ): Promise<TransitionAttemptResult>;
  acceptCheckpoint(
    checkpoint: AiRunV2Checkpoint,
  ): Promise<AcceptCheckpointResult>;
};

type TransactionRunner = <T>(
  work: (executor: SqlExecutor) => Promise<T>
) => Promise<T>;

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

const ALLOWED_ATTEMPT_TRANSITIONS: Record<
  AiRunV2AttemptStatus,
  readonly AiRunV2AttemptStatus[]
> = {
  queued: ['dispatched', 'cancelled'],
  dispatched: ['running', 'cancelled', 'failed'],
  running: [
    'checking_worker',
    'finalizing',
    'completed',
    'failed',
    'cancelled',
  ],
  checking_worker: ['running', 'finalizing', 'failed', 'cancelled'],
  finalizing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const V1_TERMINAL_REASONS = new Set<string>([
  'worker_lost',
  'progress_timeout',
  'queue_ttl',
  'dispatch_ttl',
  'forced_cancel',
]);

function headerStatusForAttempt(status: AiRunV2AttemptStatus): AgentRunStatus {
  if (isAiRunV2TerminalAttemptStatus(status)) {
    return status;
  }
  if (status === 'queued') return 'queued';
  if (status === 'dispatched') return 'dispatched';
  return 'running';
}

function toV1TerminalReason(
  failureCategory: AiRunV2FailureCategory | undefined
): AgentRunTerminalReason | null {
  if (!failureCategory) return null;
  return V1_TERMINAL_REASONS.has(failureCategory)
    ? (failureCategory as AgentRunTerminalReason)
    : null;
}

function assertCapacityClass(input: {
  capacityClass: AiRunV2CapacityClass;
}): void {
  if (!isAiRunV2CapacityClass(input.capacityClass)) {
    throw new Error('capacityClass is required for V2 dispatch commands');
  }
}

const defaultTransactionRunner: TransactionRunner = async (work) =>
  db.transaction(async (tx) =>
    work({ execute: (query) => tx.execute(query as never) })
  );

export function createRunAttemptRepository(options?: {
  runInTransaction?: TransactionRunner;
}): RunAttemptRepository {
  const runInTransaction =
    options?.runInTransaction ?? defaultTransactionRunner;

  return {
    async createQueuedV2Run(
      input: CreateQueuedV2RunInput
    ): Promise<CreateQueuedV2RunResult> {
      return runInTransaction(async (executor) => {
        const activeResult = await executor.execute(sql`
          SELECT id, status, transport_version
          FROM agent_runs
          WHERE thread_id = ${input.threadId}
            AND status IN ('queued', 'dispatched', 'running')
          ORDER BY created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE
        `);
        const active = resultRows<{
          id: string;
          status: string;
          transport_version: string;
        }>(activeResult)[0];
        if (active) {
          return {
            status: 'active_run_conflict',
            existingRunId: active.id,
            existingTransportVersion: active.transport_version,
            existingStatus: active.status,
          };
        }

        const runId = input.runId ?? randomUUID();
        const attemptId = randomUUID();
        const dispatchMessageId = randomUUID();

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
            owner_instance,
            transport_version,
            cancel_requested,
            heartbeat_at,
            started_at,
            created_at,
            updated_at
          ) VALUES (
            ${runId},
            ${input.threadId},
            'queued',
            ${input.projectId},
            ${input.lane},
            now(),
            ${input.timeoutAt},
            ${input.executionSnapshot
              ? JSON.stringify(input.executionSnapshot)
              : null}::jsonb,
            ${input.ownerInstance ?? null},
            'servicebus-blob-v2',
            FALSE,
            now(),
            now(),
            now(),
            now()
          )
        `);

        await executor.execute(sql`
          INSERT INTO ai_run_attempts (
            id,
            run_id,
            attempt_number,
            dispatch_message_id,
            status,
            artifact_status,
            spec_ref,
            created_at,
            updated_at
          ) VALUES (
            ${attemptId},
            ${runId},
            1,
            ${dispatchMessageId},
            'queued',
            'pending',
            ${JSON.stringify(input.specRef)}::jsonb,
            now(),
            now()
          )
        `);

        return {
          status: 'created',
          runId,
          attemptId,
          attemptNumber: 1,
          dispatchMessageId,
        };
      });
    },

    async createDispatchedV2Run(
      input: CreateDispatchedV2RunInput,
    ): Promise<CreateDispatchedV2RunResult> {
      return runInTransaction(async (executor) => {
        // Bind both existing operations to this executor so the run header,
        // first attempt, dispatch fence, and outbox command commit together.
        // The public dispatch method remains independently transactional for
        // reconciler-created replacement attempts.
        const transactionBoundRepository = createRunAttemptRepository({
          runInTransaction: async (work) => work(executor),
        });
        const created =
          await transactionBoundRepository.createQueuedV2Run(input);
        if (created.status === 'active_run_conflict') return created;

        const dispatched =
          await transactionBoundRepository.dispatchNextAttempt({
            runId: created.runId,
            workloadLane: input.workloadLane,
            capacityClass: input.capacityClass,
            specRef: input.specRef,
            deadlineAt: input.timeoutAt,
          });
        return {
          status: 'dispatched',
          runId: created.runId,
          attemptId: dispatched.attemptId,
          attemptNumber: dispatched.attemptNumber,
          dispatchMessageId: dispatched.dispatchMessageId,
          outboxId: dispatched.outboxId,
        };
      });
    },

    async dispatchNextAttempt(
      input: DispatchNextAttemptInput
    ): Promise<DispatchNextAttemptResult> {
      assertCapacityClass(input);
      return runInTransaction(async (executor) => {
        const outbox = createOutboxRepository(executor);

        const runResult = await executor.execute(sql`
          SELECT id, status, transport_version, timeout_at
          FROM agent_runs
          WHERE id = ${input.runId}
          FOR UPDATE
        `);
        const run = resultRows<{
          id: string;
          status: string;
          transport_version: string;
          timeout_at?: string | Date | null;
        }>(runResult)[0];
        if (!run) {
          throw new Error(`Run not found: ${input.runId}`);
        }
        if (run.transport_version !== 'servicebus-blob-v2') {
          throw new Error(`Run ${input.runId} is not a V2 transport run`);
        }
        if (run.status === 'completed' || run.status === 'cancelled') {
          throw new Error(
            `Cannot dispatch another attempt for ${run.status} run ${input.runId}`
          );
        }

        const activeAttempt = await executor.execute(sql`
          SELECT id, attempt_number, status
          FROM ai_run_attempts
          WHERE run_id = ${input.runId}
            AND status IN ('queued', 'dispatched', 'running', 'checking_worker', 'finalizing')
          FOR UPDATE
        `);
        const active = resultRows<{
          id: string;
          attempt_number: number;
          status: string;
        }>(activeAttempt)[0];

        const dispatchMessageId = input.dispatchMessageId ?? randomUUID();
        const deadlineAt =
          input.deadlineAt
          ?? (
            run.timeout_at instanceof Date
              ? run.timeout_at.toISOString()
              : run.timeout_at == null
                ? ''
                : String(run.timeout_at)
          );
        if (!Number.isFinite(Date.parse(deadlineAt))) {
          throw new Error(`Run ${input.runId} has no valid dispatch deadline`);
        }

        if (active?.status === 'queued' && active.attempt_number === 1) {
          await executor.execute(sql`
            UPDATE ai_run_attempts
            SET
              status = 'dispatched',
              dispatch_message_id = ${dispatchMessageId},
              spec_ref = ${JSON.stringify(input.specRef)}::jsonb,
              updated_at = now()
            WHERE id = ${active.id}
          `);
          await executor.execute(sql`
            UPDATE agent_runs
            SET
              status = 'dispatched',
              dispatch_message_id = ${dispatchMessageId},
              dispatched_at = now(),
              updated_at = now()
            WHERE id = ${input.runId}
          `);

          const command: AiRunV2Command = {
            schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
            eventId: randomUUID(),
            runId: input.runId,
            attemptId: active.id,
            attemptNumber: 1,
            dispatchMessageId,
            timestamp: new Date().toISOString(),
            kind: 'dispatch_command',
            transport: 'servicebus-blob-v2',
            workloadLane: input.workloadLane,
            capacityClass: input.capacityClass,
            specRef: input.specRef,
            deadlineAt,
          };
          const inserted = await outbox.enqueue([
            {
              idempotencyKey: `${active.id}:dispatch`,
              kind: 'dispatch_command',
              runId: input.runId,
              attemptId: active.id,
              payload: command,
            },
          ]);
          return {
            attemptId: active.id,
            attemptNumber: 1,
            dispatchMessageId,
            outboxId: inserted[0]?.id ?? null,
          };
        }

        if (active) {
          throw new Error(`Run ${input.runId} already has an active attempt`);
        }

        const nextNumberResult = await executor.execute(sql`
          SELECT COALESCE(MAX(attempt_number), 0)::int AS max_attempt
          FROM ai_run_attempts
          WHERE run_id = ${input.runId}
        `);
        const maxAttempt = Number(
          resultRows<{ max_attempt: number | string }>(nextNumberResult)[0]
            ?.max_attempt ?? 0
        );
        const attemptNumber = maxAttempt + 1;
        const attemptId = randomUUID();

        await executor.execute(sql`
          INSERT INTO ai_run_attempts (
            id,
            run_id,
            attempt_number,
            dispatch_message_id,
            status,
            artifact_status,
            spec_ref,
            created_at,
            updated_at
          ) VALUES (
            ${attemptId},
            ${input.runId},
            ${attemptNumber},
            ${dispatchMessageId},
            'dispatched',
            'pending',
            ${JSON.stringify(input.specRef)}::jsonb,
            now(),
            now()
          )
        `);

        await executor.execute(sql`
          UPDATE agent_runs
          SET
            status = 'dispatched',
            dispatch_message_id = ${dispatchMessageId},
            dispatched_at = now(),
            updated_at = now()
          WHERE id = ${input.runId}
        `);

        const command: AiRunV2Command = {
          schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
          eventId: randomUUID(),
          runId: input.runId,
          attemptId,
          attemptNumber,
          dispatchMessageId,
          timestamp: new Date().toISOString(),
          kind: 'dispatch_command',
          transport: 'servicebus-blob-v2',
          workloadLane: input.workloadLane,
          capacityClass: input.capacityClass,
          specRef: input.specRef,
          deadlineAt,
        };
        const inserted = await outbox.enqueue([
          {
            idempotencyKey: `${attemptId}:dispatch`,
            kind: 'dispatch_command',
            runId: input.runId,
            attemptId,
            payload: command,
          },
        ]);

        return {
          attemptId,
          attemptNumber,
          dispatchMessageId,
          outboxId: inserted[0]?.id ?? null,
        };
      });
    },

    async transitionAttempt(
      input: TransitionAttemptInput
    ): Promise<TransitionAttemptResult> {
      return runInTransaction(async (executor) => {
        const existingResult = await executor.execute(sql`
          SELECT id, run_id, status, dispatch_message_id
          FROM ai_run_attempts
          WHERE id = ${input.attemptId}
          FOR UPDATE
        `);
        const existing = resultRows<{
          id: string;
          run_id: string;
          status: AiRunV2AttemptStatus;
          dispatch_message_id: string;
        }>(existingResult)[0];
        if (!existing) return { status: 'not_found' };
        if (existing.dispatch_message_id !== input.expectedDispatchMessageId) {
          return { status: 'fence_mismatch' };
        }
        const allowed = ALLOWED_ATTEMPT_TRANSITIONS[existing.status] ?? [];
        if (!allowed.includes(input.to)) {
          return {
            status: 'illegal_transition',
            from: existing.status,
            to: input.to,
          };
        }

        const headerStatus = headerStatusForAttempt(input.to);
        const terminalReason = isAiRunV2TerminalAttemptStatus(input.to)
          ? toV1TerminalReason(input.failureCategory)
          : null;

        await executor.execute(sql`
          UPDATE ai_run_attempts
          SET
            status = ${input.to},
            artifact_status = COALESCE(${input.artifactStatus ?? null}, artifact_status),
            failure_category = ${input.failureCategory ?? null},
            failure_detail = ${input.failureDetail ?? null},
            manifest_ref = COALESCE(${input.manifestRef ? JSON.stringify(input.manifestRef) : null}::jsonb, manifest_ref),
            updated_at = now()
          WHERE id = ${input.attemptId}
        `);

        const headerResult = await executor.execute(sql`
          UPDATE agent_runs
          SET
            status = ${headerStatus},
            terminal_reason = COALESCE(${terminalReason}, terminal_reason),
            updated_at = now()
          WHERE id = ${existing.run_id}
          RETURNING
            id,
            thread_id,
            project_id,
            lane,
            terminal_reason,
            dispatch_message_id
        `);
        const header = resultRows<{
          id: string;
          thread_id: string;
          project_id: string | null;
          lane: string | null;
          terminal_reason: string | null;
          dispatch_message_id: string | null;
        }>(headerResult)[0];

        let run: TerminalRunSubject | null = null;
        if (isAiRunV2TerminalAttemptStatus(input.to) && header) {
          run = {
            runId: header.id,
            threadId: header.thread_id,
            projectId: header.project_id ?? null,
            lane: (header.lane as AgentRunLane | null) ?? null,
            status: input.to,
            fromStatus: headerStatusForAttempt(existing.status),
            terminalReason:
              (header.terminal_reason as AgentRunTerminalReason | null) ?? null,
            dispatchMessageId: header.dispatch_message_id ?? null,
          };
        }

        return { status: 'ok', attemptId: input.attemptId, to: input.to, run };
      });
    },

    async acceptCheckpoint(
      checkpoint: AiRunV2Checkpoint
    ): Promise<AcceptCheckpointResult> {
      return runInTransaction(async (executor) => {
        const inbox = createInboxRepository(executor);

        const attemptResult = await executor.execute(sql`
          SELECT
            attempt.id,
            attempt.dispatch_message_id,
            attempt.last_checkpoint_sequence,
            attempt.status,
            run.thread_id
          FROM ai_run_attempts attempt
          JOIN agent_runs run ON run.id = attempt.run_id
          WHERE attempt.id = ${checkpoint.attemptId}
          FOR UPDATE
        `);
        const attempt = resultRows<{
          id: string;
          dispatch_message_id: string;
          last_checkpoint_sequence: number;
          status: AiRunV2AttemptStatus;
          thread_id: string;
        }>(attemptResult)[0];
        if (!attempt) return { status: 'not_found' };
        if (attempt.dispatch_message_id !== checkpoint.dispatchMessageId) {
          return { status: 'fence_mismatch' };
        }
        if (!isAiRunV2ActiveAttemptStatus(attempt.status)) {
          return {
            status: 'stale_sequence',
            lastCheckpointSequence: Number(attempt.last_checkpoint_sequence),
          };
        }
        if (
          checkpoint.checkpointSequence <=
          Number(attempt.last_checkpoint_sequence)
        ) {
          return {
            status: 'stale_sequence',
            lastCheckpointSequence: Number(attempt.last_checkpoint_sequence),
          };
        }

        const claim = await inbox.claimEvent({
          eventId: checkpoint.eventId,
          kind: 'checkpoint',
          runId: checkpoint.runId,
          attemptId: checkpoint.attemptId,
          dispatchMessageId: checkpoint.dispatchMessageId,
          checkpointSequence: checkpoint.checkpointSequence,
          payload: checkpoint as unknown as Record<string, unknown>,
        });
        if (claim.status !== 'inserted') {
          return { status: 'duplicate' };
        }

        if (
          checkpoint.kind === 'progress'
          && checkpoint.progress?.kind === 'text_delta'
        ) {
          const streamOffset = checkpoint.progress.offset;
          const streamEndOffset =
            checkpoint.progress.offset + checkpoint.progress.text.length;
          const text = checkpoint.progress.text.split('\u0000').join('');
          if (text || streamEndOffset > streamOffset) {
            const sourceInstance =
              `ai-run-v2-checkpoint:${checkpoint.attemptId}`;
            const event = {
              type: 'token',
              text,
              streamOffset,
              streamEndOffset,
              runId: checkpoint.runId,
              eventTimestamp: checkpoint.timestamp,
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
                event
              ) VALUES (
                ${checkpoint.eventId}::uuid,
                ${attempt.thread_id},
                ${checkpoint.runId},
                ${sourceInstance},
                ${checkpoint.checkpointSequence},
                ${checkpoint.timestamp},
                'token',
                'implementation',
                'running',
                NULL,
                ${JSON.stringify(event)}::jsonb
              )
              ON CONFLICT (event_id) DO NOTHING
            `);
            await executor.execute(sql`
              SELECT pg_notify(
                'agent_run_events',
                json_build_object(
                  'threadId', ${attempt.thread_id},
                  'eventId', ${checkpoint.eventId}
                )::text
              )
            `);
          }
        }

        // The started checkpoint carries the only execution id the reconciler
        // can probe, so fold it into spec_ref rather than leaving it in inbox.
        const executionIdPatch =
          checkpoint.kind === 'started'
            ? sql`spec_ref = COALESCE(spec_ref, '{}'::jsonb) || ${JSON.stringify(
                { containerAppsExecutionId: checkpoint.containerAppsExecutionId },
              )}::jsonb,`
            : sql``;
        await executor.execute(sql`
          UPDATE ai_run_attempts
          SET
            last_checkpoint_sequence = ${checkpoint.checkpointSequence},
            last_checkpoint_at = now(),
            ${executionIdPatch}
            status = CASE
              WHEN status = 'dispatched' THEN 'running'
              ELSE status
            END,
            updated_at = now()
          WHERE id = ${checkpoint.attemptId}
        `);
        await executor.execute(sql`
          UPDATE agent_runs
          SET
            status = 'running',
            updated_at = now()
          WHERE id = ${checkpoint.runId}
            AND status IN ('dispatched', 'running')
        `);
        await inbox.markProcessed(checkpoint.eventId);
        return {
          status: 'accepted',
          checkpointSequence: checkpoint.checkpointSequence,
        };
      });
    },
  };
}

export const runAttemptRepository = createRunAttemptRepository();
