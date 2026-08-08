/**
 * Authenticated worker-to-web ingest for background AI runs (FEAT-004).
 *
 * The project-scoped row and exact dispatch fence are checked before every
 * mutation, including idempotent terminal callbacks. Durable progress uses the
 * established PostgreSQL event spine; terminal writes delegate to lifecycle.
 */
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns } from '../db/schema';
import {
  markTerminal,
  transition,
  type AgentRunLifecycleRow,
  type LifecycleResult,
} from './agentRunLifecycleService';
import {
  RUN_EVENT_SOURCE_INSTANCE,
  nextRunEventSequence,
  notifyRunEvent,
} from './pgNotifyService';
import type {
  AgentRunEventEnvelope,
  AgentRunEventStatus,
  AgentRunEventType,
  AgentRunPhase,
  ChatMessage,
  SseEvent,
} from '../../shared/types/chat';
import {
  isAgentRunTerminalReason,
  isAgentRunTerminalStatus,
} from '../../shared/types/agentRunLifecycle';
import {
  isAiRunIngestKind,
  isAiRunTerminalIngestStatus,
  type AiRunIngestBody,
  type AiRunBootstrapResponse,
  type AiRunIngestErrorCode,
  type AiRunProgressIngest,
  type AiRunTerminalIngest,
} from '../../shared/types/aiRunIngest';
import { INTERACTIVE_LANE } from '../../shared/types/interactiveWorkflow';
import { workerTierTelemetry } from './workerTierTelemetry';

const MAX_DETAIL_LENGTH = 500;
const AGENT_RUN_PHASES: ReadonlySet<string> = new Set([
  'queued',
  'dispatched',
  'setup',
  'planning',
  'approval',
  'dependencies',
  'analysis',
  'implementation',
  'testing',
  'typecheck',
  'push',
  'completion',
]);
const EVENT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export class AiRunIngestError extends Error {
  constructor(
    message: string,
    readonly code: AiRunIngestErrorCode,
  ) {
    super(message);
    this.name = 'AiRunIngestError';
  }
}

export interface AiRunIngestResult {
  cancelRequested: boolean;
  run: AgentRunLifecycleRow;
}

export type CompletedArtifactConsumer = (
  threadId: string,
  workspaceDir: string,
) => Promise<void>;

export interface AiRunIngestDependencies {
  consumeCompletedArtifacts?: CompletedArtifactConsumer;
  persistThreadMessage?: (
    threadId: string,
    message: ChatMessage,
  ) => Promise<void>;
}

async function consumeCompletedArtifacts(
  threadId: string,
  workspaceDir: string,
): Promise<void> {
  const { syncOutputToDb } = await import('./chatAgentService');
  await syncOutputToDb(threadId, workspaceDir);
}

/**
 * Persist a durable chat message (idempotent by id via `onConflictDoNothing`).
 * Used for the interactive lane's final assistant message so a full thread
 * reload — not just event replay — always shows the answer.
 */
async function persistThreadMessage(
  threadId: string,
  message: ChatMessage,
): Promise<void> {
  const { insertMessage } = await import('./chatThreadRepository');
  await insertMessage(threadId, message);
}

function sanitizeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH);
  return sanitized || undefined;
}

function emitWorkerTelemetry(emit: () => void): void {
  try {
    emit();
  } catch {
    // Telemetry must never reject an accepted worker callback.
  }
}

function isAgentRunPhase(value: unknown): value is AgentRunPhase {
  return typeof value === 'string' && AGENT_RUN_PHASES.has(value);
}

function isAgentRunEventStatus(value: unknown): value is AgentRunEventStatus {
  return typeof value === 'string' && EVENT_STATUSES.has(value);
}

function validateBody(body: AiRunIngestBody): void {
  if (
    !body
    || typeof body.dispatchMessageId !== 'string'
    || body.dispatchMessageId.trim().length === 0
    || !isAiRunIngestKind(body.kind)
  ) {
    throw new AiRunIngestError(
      'dispatchMessageId and a supported kind are required',
      'AI_RUN_VALIDATION',
    );
  }

  if (body.kind === 'progress') {
    if (body.phase !== undefined && !isAgentRunPhase(body.phase)) {
      throw new AiRunIngestError('Invalid progress phase', 'AI_RUN_VALIDATION');
    }
    if (body.status !== undefined && !isAgentRunEventStatus(body.status)) {
      throw new AiRunIngestError('Invalid progress status', 'AI_RUN_VALIDATION');
    }
  }

  if (body.kind === 'terminal') {
    if (!isAiRunTerminalIngestStatus(body.status)) {
      throw new AiRunIngestError(
        'Terminal ingest requires completed, failed, or cancelled status',
        'AI_RUN_VALIDATION',
      );
    }
    if (body.phase !== undefined && !isAgentRunPhase(body.phase)) {
      throw new AiRunIngestError('Invalid terminal phase', 'AI_RUN_VALIDATION');
    }
    if (
      body.terminalReason !== undefined
      && !isAgentRunTerminalReason(body.terminalReason)
    ) {
      throw new AiRunIngestError('Invalid terminal reason', 'AI_RUN_VALIDATION');
    }
    if (
      body.artifactsFlushed !== undefined
      && typeof body.artifactsFlushed !== 'boolean'
    ) {
      throw new AiRunIngestError(
        'artifactsFlushed must be a boolean',
        'AI_RUN_VALIDATION',
      );
    }
  }
}

function mapRow(row: typeof agentRuns.$inferSelect): AgentRunLifecycleRow {
  return {
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    projectId: row.projectId ?? null,
    lane: row.lane ?? null,
    queuedAt: row.queuedAt ?? null,
    dispatchedAt: row.dispatchedAt ?? null,
    dispatchMessageId: row.dispatchMessageId ?? null,
    executionSnapshot: row.executionSnapshot ?? null,
    cancelRequested: row.cancelRequested ?? false,
    cancelState: row.cancelState ?? null,
    terminalReason: row.terminalReason ?? null,
    timeoutAt: row.timeoutAt ?? null,
    ownerInstance: row.ownerInstance ?? null,
    updatedAt: row.updatedAt,
  };
}

async function loadProjectRun(
  projectId: string,
  runId: string,
): Promise<typeof agentRuns.$inferSelect | null> {
  const row = await db.query.agentRuns.findFirst({
    where: and(
      eq(agentRuns.id, runId),
      eq(agentRuns.projectId, projectId),
    ),
  });
  return row ?? null;
}

async function loadRun(
  runId: string,
): Promise<typeof agentRuns.$inferSelect | null> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });
  return row ?? null;
}

/**
 * Return the frozen worker bootstrap only for the current external dispatch.
 * The lookup is intentionally read-only and the fence is checked before all
 * other lifecycle details so stale workers deterministically receive conflict.
 */
export async function getBootstrap(
  runId: string,
  dispatchMessageId: string,
): Promise<AiRunBootstrapResponse> {
  if (!runId?.trim() || !dispatchMessageId?.trim()) {
    throw new AiRunIngestError(
      'runId and dispatchMessageId are required',
      'AI_RUN_VALIDATION',
    );
  }

  const existing = await loadRun(runId);
  if (!existing) {
    throw new AiRunIngestError('AI run not found', 'AI_RUN_NOT_FOUND');
  }
  if (existing.dispatchMessageId !== dispatchMessageId) {
    throw new AiRunIngestError(
      'dispatchMessageId does not match this run',
      'AI_RUN_DISPATCH_MISMATCH',
    );
  }
  if (
    (existing.lane !== 'background' && existing.lane !== INTERACTIVE_LANE)
    || (existing.status !== 'dispatched' && existing.status !== 'running')
    || !existing.projectId
    || !existing.executionSnapshot
  ) {
    throw new AiRunIngestError(
      'AI run is not available for external bootstrap',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }

  return {
    projectId: existing.projectId,
    run: {
      ...mapRow(existing),
      executionSnapshot: existing.executionSnapshot,
    },
  };
}

function assertLifecycleSuccess(result: LifecycleResult): AgentRunLifecycleRow {
  if (!('reason' in result)) return result.run;
  const code: AiRunIngestErrorCode =
    result.reason === 'run_not_found'
      ? 'AI_RUN_NOT_FOUND'
      : result.reason.includes('fence')
        ? 'AI_RUN_DISPATCH_MISMATCH'
        : 'AI_RUN_ILLEGAL_TRANSITION';
  throw new AiRunIngestError('AI run lifecycle rejected ingest', code);
}

function eventTypeFor(event: SseEvent | undefined): AgentRunEventType {
  if (!event) return 'phase';
  switch (event.type) {
    case 'tool_call':
    case 'tool_status':
      return 'tool';
    case 'thinking':
      return 'token';
    default:
      return event.type;
  }
}

function sanitizeEvent(event: SseEvent, detail: string | undefined): SseEvent {
  const sanitized = { ...event } as SseEvent & Record<string, unknown>;
  if ('detail' in sanitized) sanitized.detail = detail;
  if ('semanticDetail' in sanitized) sanitized.semanticDetail = detail;
  if (sanitized.type === 'error' && typeof sanitized.error === 'string') {
    sanitized.error = sanitizeDetail(sanitized.error) ?? 'AI run failed';
  }
  return sanitized;
}

function buildProgressEnvelope(
  row: typeof agentRuns.$inferSelect,
  body: AiRunProgressIngest,
  timestamp: string,
  detail: string | undefined,
): AgentRunEventEnvelope {
  const phase = body.phase
    ?? body.event?.semanticPhase
    ?? (body.event?.type === 'phase' ? body.event.phase : undefined)
    ?? 'implementation';
  const status = body.status
    ?? body.event?.semanticStatus
    ?? (body.event?.type === 'phase' ? body.event.status : undefined)
    ?? 'running';
  const event: SseEvent = body.event
    ? sanitizeEvent(body.event, detail)
    : {
        type: 'phase',
        phase,
        status,
        detail,
        runId: row.id,
        eventTimestamp: timestamp,
      };

  return {
    eventId: randomUUID(),
    threadId: row.threadId,
    runId: row.id,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(row.id),
    timestamp,
    type: eventTypeFor(event),
    phase,
    status,
    detail,
    event,
  };
}

function buildTerminalEvent(
  status: AiRunTerminalIngest['status'],
  runId: string,
  detail: string | undefined,
): SseEvent {
  if (status === 'completed') return { type: 'done', runId };
  if (status === 'failed') {
    return {
      type: 'error',
      error: detail ?? 'AI run failed',
      errorCode: 'fatal',
    };
  }
  return {
    type: 'status',
    status: 'idle',
    semanticStatus: 'cancelled',
    semanticDetail: detail,
  };
}

function buildTerminalEnvelope(
  row: typeof agentRuns.$inferSelect,
  body: AiRunTerminalIngest | (AiRunIngestBody & { kind: 'cancel_ack' }),
  timestamp: string,
  status: 'completed' | 'failed' | 'cancelled',
  detail: string | undefined,
): AgentRunEventEnvelope {
  const suppliedEvent = body.kind === 'terminal' ? body.event : undefined;
  const event = suppliedEvent
    ? sanitizeEvent(suppliedEvent, detail)
    : buildTerminalEvent(status, row.id, detail);
  return {
    eventId: randomUUID(),
    threadId: row.threadId,
    runId: row.id,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(row.id),
    timestamp,
    type: status === 'cancelled' ? 'cancel' : eventTypeFor(event),
    phase: body.kind === 'terminal' ? body.phase ?? 'completion' : 'completion',
    status,
    detail,
    event: status === 'cancelled' ? { type: 'cancel' } : event,
  };
}

function buildDoneEnvelope(
  row: typeof agentRuns.$inferSelect,
  timestamp: string,
  status: 'completed' | 'failed' | 'cancelled',
  detail: string | undefined,
): AgentRunEventEnvelope {
  return {
    eventId: randomUUID(),
    threadId: row.threadId,
    runId: row.id,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(row.id),
    timestamp,
    type: 'done',
    phase: 'completion',
    status,
    detail,
    event: { type: 'done', runId: row.id },
  };
}

async function updateWorkerClocks(
  projectId: string,
  runId: string,
  dispatchMessageId: string,
  values: {
    heartbeatAt: string;
    progressAt?: string;
    progressLabel?: string | null;
    progressPhase?: AgentRunPhase;
  },
): Promise<typeof agentRuns.$inferSelect> {
  const updated = await db
    .update(agentRuns)
    .set({
      ...values,
      updatedAt: values.heartbeatAt,
    })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.projectId, projectId),
        eq(agentRuns.dispatchMessageId, dispatchMessageId),
        eq(agentRuns.status, 'running'),
      ),
    )
    .returning();

  if (updated.length === 0) {
    const latest = await loadProjectRun(projectId, runId);
    const code = latest?.dispatchMessageId !== dispatchMessageId
      ? 'AI_RUN_DISPATCH_MISMATCH'
      : 'AI_RUN_ILLEGAL_TRANSITION';
    throw new AiRunIngestError('AI run changed during ingest', code);
  }
  return updated[0];
}

export async function ingest(
  projectId: string,
  runId: string,
  body: AiRunIngestBody,
  dependencies: AiRunIngestDependencies = {},
): Promise<AiRunIngestResult> {
  if (!projectId?.trim() || !runId?.trim()) {
    throw new AiRunIngestError('projectId and runId are required', 'AI_RUN_VALIDATION');
  }
  validateBody(body);

  const existing = await loadProjectRun(projectId, runId);
  if (!existing) {
    throw new AiRunIngestError(
      'AI run not found in this project',
      'AI_RUN_NOT_FOUND',
    );
  }

  // Fence before terminal/idempotency checks: stale workers always abort.
  if (existing.dispatchMessageId !== body.dispatchMessageId) {
    throw new AiRunIngestError(
      'dispatchMessageId does not match this run',
      'AI_RUN_DISPATCH_MISMATCH',
    );
  }

  const nowIso = new Date().toISOString();
  const detail = sanitizeDetail(body.detail);

  if (body.kind === 'terminal' && isAgentRunTerminalStatus(existing.status)) {
    if (existing.status === body.status) {
      const run = assertLifecycleSuccess(await markTerminal(runId, {
        status: body.status,
        dispatchMessageId: body.dispatchMessageId,
        terminalReason: body.terminalReason,
        detail: detail ?? body.status,
      }));
      return { run, cancelRequested: run.cancelRequested };
    }
    throw new AiRunIngestError(
      `Cannot apply ${body.status} terminal to ${existing.status} run`,
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }

  if (body.kind === 'heartbeat' || body.kind === 'progress') {
    if (isAgentRunTerminalStatus(existing.status) || existing.status === 'queued') {
      throw new AiRunIngestError(
        `Cannot apply ${body.kind} to ${existing.status} run`,
        'AI_RUN_ILLEGAL_TRANSITION',
      );
    }
    if (existing.status === 'dispatched') {
      assertLifecycleSuccess(await transition(runId, 'running', {
        expectedFrom: 'dispatched',
        dispatchMessageId: body.dispatchMessageId,
      }));
    }

    const meaningfulProgress = body.kind === 'progress'
      && Boolean(body.phase || body.status || body.event || detail);
    const updated = await updateWorkerClocks(
      projectId,
      runId,
      body.dispatchMessageId,
      {
        heartbeatAt: nowIso,
        ...(meaningfulProgress
          ? {
              progressAt: nowIso,
              progressLabel: detail ?? null,
              progressPhase: body.phase ?? 'implementation',
            }
          : {}),
      },
    );

    if (body.kind === 'progress' && meaningfulProgress) {
      const envelope = buildProgressEnvelope(updated, body, nowIso, detail);
      await notifyRunEvent(envelope, { persist: true });

      // Durable FINAL assistant message: the interactive actor streams tokens
      // ephemerally over Redis, so the answer is only durable once persisted
      // here. The event copy above makes it replayable on reconnect; this makes
      // it survive a full thread reload from chat_messages. Idempotent by id.
      if (existing.lane === INTERACTIVE_LANE && body.event?.type === 'message') {
        try {
          await (dependencies.persistThreadMessage ?? persistThreadMessage)(
            existing.threadId,
            body.event.message,
          );
        } catch (error) {
          // Already durable + replayable in agent_run_events; a chat_messages
          // write failure must not reject an otherwise-accepted callback.
          console.error(
            '[aiRunIngest] final interactive message persist failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    if (existing.status === 'dispatched' && existing.dispatchedAt) {
      const dispatchedAtMs = Date.parse(existing.dispatchedAt);
      const acceptedAtMs = Date.parse(nowIso);
      if (
        Number.isFinite(dispatchedAtMs)
        && Number.isFinite(acceptedAtMs)
      ) {
        emitWorkerTelemetry(() => {
          workerTierTelemetry.coldStart(
            {
              runId,
              dispatchMessageId: body.dispatchMessageId,
              project: projectId,
              lane: 'background',
            },
            Math.max(0, acceptedAtMs - dispatchedAtMs),
          );
        });
      }
    }

    const run = mapRow(updated);
    return { run, cancelRequested: run.cancelRequested };
  }

  if (body.kind === 'cancel_ack') {
    const envelope = buildTerminalEnvelope(
      existing,
      body,
      nowIso,
      'cancelled',
      detail,
    );
    const terminal = assertLifecycleSuccess(await markTerminal(runId, {
      status: 'cancelled',
      dispatchMessageId: body.dispatchMessageId,
      detail: detail ?? 'Worker acknowledged cancellation',
      events: [envelope],
    }));
    const updated = await db
      .update(agentRuns)
      .set({
        cancelRequested: true,
        cancelState: 'completed',
        heartbeatAt: nowIso,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.projectId, projectId),
          eq(agentRuns.dispatchMessageId, body.dispatchMessageId),
          eq(agentRuns.status, 'cancelled'),
        ),
      )
      .returning();
    const run = updated[0] ? mapRow(updated[0]) : terminal;
    return { run, cancelRequested: true };
  }

  const mayFailWithoutArtifactFlush =
    existing.lane === INTERACTIVE_LANE && body.status === 'failed';
  if (body.artifactsFlushed !== true && !mayFailWithoutArtifactFlush) {
    throw new AiRunIngestError(
      'Terminal ingest requires durable workspace artifacts',
      'AI_RUN_ARTIFACTS_NOT_FLUSHED',
    );
  }

  if (body.status === 'completed') {
    const workspaceDir = existing.executionSnapshot?.workspaceRef;
    if (!workspaceDir) {
      throw new AiRunIngestError(
        'Completed terminal ingest requires a workspace reference',
        'AI_RUN_ILLEGAL_TRANSITION',
      );
    }
    await (
      dependencies.consumeCompletedArtifacts ?? consumeCompletedArtifacts
    )(existing.threadId, workspaceDir);
  }

  const envelope = buildTerminalEnvelope(
    existing,
    body,
    nowIso,
    body.status,
    detail,
  );
  const terminalEvents = body.status === 'failed'
    ? [envelope, buildDoneEnvelope(existing, nowIso, body.status, detail)]
    : [envelope];
  const run = assertLifecycleSuccess(await markTerminal(runId, {
    status: body.status,
    terminalReason: body.terminalReason,
    dispatchMessageId: body.dispatchMessageId,
    detail: detail ?? body.status,
    events: terminalEvents,
  }));
  return { run, cancelRequested: run.cancelRequested };
}
