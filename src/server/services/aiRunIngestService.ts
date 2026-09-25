/**
 * Authenticated worker-to-web ingest for background AI runs (FEAT-004).
 *
 * The project-scoped row and exact dispatch fence are checked before every
 * mutation, including idempotent terminal callbacks. Durable progress uses the
 * established PostgreSQL event spine; terminal writes delegate to lifecycle.
 */
import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, aiRunAttempts, chatThreads, chatMessages } from '../db/schema';
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
  type AgentRunExecutionSnapshot,
} from '../../shared/types/agentRunLifecycle';
import {
  isAiRunIngestKind,
  isAiRunTerminalIngestStatus,
  type AiRunIngestBody,
  type AiRunBootstrapResponse,
  type AiRunBootstrapResult,
  type AiRunIngestErrorCode,
  type AiRunProgressIngest,
  type AiRunTerminalIngest,
  type InteractiveActorBootstrap,
} from '../../shared/types/aiRunIngest';
import {
  isCanonicalUuid,
  isDurableInteractiveTurnSpecification,
  type DurableInteractiveTurnSpecification,
} from '../../shared/types/durableInteractiveTurn';
import { INTERACTIVE_LANE } from '../../shared/types/interactiveWorkflow';
import {
  isAiRunV2AttemptStatus,
  isAiRunV2ArtifactManifest,
  isAiRunV2FailureCategory,
  type AiRunBlobRef,
  type AiRunV2FailureCategory,
} from '../../shared/types/aiRunV2';
import { workerTierTelemetry } from './workerTierTelemetry';
import { recordCursorChatUsage } from './aiUsageService';
import type { RecordUsageInput } from '../../shared/types/aiCostAnalytics';
import { clampInteractiveDeadlinePolicy } from './interactiveDeadlinePolicy';
import { issueInteractiveToolProxyToken } from './interactiveToolProxyToken';
import {
  applyInteractiveArtifacts,
  createBlobInteractiveArtifactReader,
} from './interactiveArtifactApplier';
import { resolveArtifactContainerClient } from './aiRunV2/artifactContainer';

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

function isDurableInteractiveSnapshot(
  snapshot: AgentRunExecutionSnapshot,
): snapshot is Extract<
  AgentRunExecutionSnapshot,
  { kind: 'interactive-turn' }
> {
  return 'kind' in snapshot && snapshot.kind === 'interactive-turn';
}

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

export type FailedGenerationConsumer = (threadId: string) => Promise<void>;

export interface AiRunIngestDependencies {
  consumeCompletedArtifacts?: CompletedArtifactConsumer;
  failGeneratingArtifacts?: FailedGenerationConsumer;
  persistThreadMessage?: (
    threadId: string,
    message: ChatMessage,
  ) => Promise<void>;
  recordCursorChatUsage?: (input: {
    kickoff: {
      skillPath?: string;
      project?: string;
    };
    modelId: string;
    threadId: string;
    runId?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    tokenSource?: RecordUsageInput['tokenSource'];
    durationMs: number;
    status: RecordUsageInput['status'];
  }) => Promise<void>;
}

async function consumeCompletedArtifacts(
  threadId: string,
  workspaceDir: string,
): Promise<void> {
  const { syncOutputToDb } = await import('./chatAgentService');
  await syncOutputToDb(threadId, workspaceDir);
}

async function failGeneratingArtifacts(threadId: string): Promise<void> {
  const { failGeneratingTestCasesForThread } = await import('./testCaseService');
  await failGeneratingTestCasesForThread(threadId);
}

async function reflectFailedGeneration(
  threadId: string,
  dependencies: AiRunIngestDependencies,
): Promise<void> {
  await (dependencies.failGeneratingArtifacts ?? failGeneratingArtifacts)(
    threadId,
  );
}

async function persistBackgroundRunUsage(
  existing: typeof agentRuns.$inferSelect,
  body: AiRunTerminalIngest,
  dependencies: AiRunIngestDependencies,
): Promise<void> {
  if (existing.lane === INTERACTIVE_LANE) return;
  const snapshot = existing.executionSnapshot;
  if (
    !snapshot
    || isDurableInteractiveSnapshot(snapshot)
    || !snapshot.model
    || !existing.threadId
  ) {
    return;
  }
  if (
    body.durationMs === undefined
    && body.inputTokens === undefined
    && body.outputTokens === undefined
  ) {
    return;
  }
  const inputTokens = body.inputTokens ?? 0;
  const outputTokens = body.outputTokens ?? 0;
  const hasReportedTokens = body.inputTokens !== undefined || body.outputTokens !== undefined;
  const usageStatus = body.status === 'completed'
    ? 'success'
    : body.status === 'cancelled'
      ? 'cancelled'
      : 'error';
  try {
    await (dependencies.recordCursorChatUsage ?? recordCursorChatUsage)({
      kickoff: {
        skillPath: snapshot.skillPath,
        project: snapshot.projectId,
      },
      modelId: snapshot.model,
      threadId: existing.threadId,
      runId: existing.id,
      inputTokens,
      outputTokens,
      cacheReadTokens: body.cacheReadTokens,
      cacheWriteTokens: body.cacheWriteTokens,
      tokenSource: hasReportedTokens ? 'exact' : 'estimated',
      durationMs: body.durationMs ?? 0,
      status: usageStatus,
    });
  } catch (err) {
    console.error(
      `[aiRunIngest] Failed to record background usage (runId=${existing.id})`,
      err,
    );
  }
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
  const sanitized = value
    .split('\u0000').join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
  return sanitized || undefined;
}

/** Cursor agent ids are opaque SDK tokens — keep short and non-secret-looking. */
const MAX_CURSOR_AGENT_ID_LENGTH = 128;

function sanitizeCursorAgentId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CURSOR_AGENT_ID_LENGTH) return undefined;
  // Reject values that look like secrets / paths.
  if (/[/\\]|[\s]/.test(trimmed)) return undefined;
  return trimmed;
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
    if (body.eventId !== undefined && !isCanonicalUuid(body.eventId)) {
      throw new AiRunIngestError(
        'progress eventId must be a canonical UUID',
        'AI_RUN_VALIDATION',
      );
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
    if (
      body.cursorAgentId !== undefined
      && body.cursorAgentId !== null
      && sanitizeCursorAgentId(body.cursorAgentId) === undefined
    ) {
      throw new AiRunIngestError(
        'Invalid cursorAgentId',
        'AI_RUN_VALIDATION',
      );
    }
    if (
      body.failureCategory !== undefined
      && !isAiRunV2FailureCategory(body.failureCategory)
    ) {
      throw new AiRunIngestError(
        'Invalid failureCategory',
        'AI_RUN_VALIDATION',
      );
    }
    for (const field of [
      'durationMs',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new AiRunIngestError(
          `${field} must be a non-negative number`,
          'AI_RUN_VALIDATION',
        );
      }
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
 *
 * For `dapr-actor-v2`, selects the attempt by exact `dispatch_message_id`,
 * parses `spec_snapshot`, clamps effective deadlines, and returns
 * {@link InteractiveActorBootstrap}.
 */
export async function getBootstrap(
  runId: string,
  dispatchMessageId: string,
): Promise<AiRunBootstrapResult> {
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

  if (existing.transportVersion === 'dapr-actor-v2') {
    return getInteractiveActorBootstrap(existing, dispatchMessageId);
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

  let cursorAgentId: string | null | undefined;
  if (existing.lane === INTERACTIVE_LANE) {
    const { getCursorAgentId } = await import('./chatThreadRepository');
    cursorAgentId = await getCursorAgentId(existing.threadId);
  }

  return {
    projectId: existing.projectId,
    run: {
      ...mapRow(existing),
      executionSnapshot: existing.executionSnapshot,
    },
    ...(cursorAgentId != null ? { cursorAgentId } : {}),
  };
}

function resolveInteractiveCallbackBaseUrl(): string {
  const configured =
    process.env.AI_RUNS_APEX_CALLBACK_BASE_URL?.trim() ||
    process.env.APEX_CALLBACK_URL?.trim() ||
    process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = process.env.PORT?.trim() || '3001';
  return `http://localhost:${port}`;
}

function buildInteractiveProxyMcpServers(input: {
  runId: string;
  attemptId: string;
  dispatchMessageId: string;
  absoluteDeadlineAt: string;
  specification: DurableInteractiveTurnSpecification;
}): InteractiveActorBootstrap['mcpServers'] {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new AiRunIngestError(
      'SESSION_SECRET is required for interactive tool proxy tokens',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }
  const base = resolveInteractiveCallbackBaseUrl();
  const servers: Record<
    string,
    { url: string; headers?: Record<string, string> }
  > = {};
  for (const descriptor of input.specification.mcpServers) {
    const token = issueInteractiveToolProxyToken(
      {
        runId: input.runId,
        attemptId: input.attemptId,
        dispatchMessageId: input.dispatchMessageId,
        serverName: descriptor.serverName,
        expiresAt: input.absoluteDeadlineAt,
      },
      secret,
    );
    servers[descriptor.serverName] = {
      url: `${base}/api/internal/ai-runs/${encodeURIComponent(input.runId)}/tools/${encodeURIComponent(descriptor.serverName)}?token=${encodeURIComponent(token)}`,
    };
  }
  return servers;
}

async function getInteractiveActorBootstrap(
  existing: typeof agentRuns.$inferSelect,
  dispatchMessageId: string,
): Promise<InteractiveActorBootstrap> {
  if (!existing.projectId) {
    throw new AiRunIngestError(
      'AI run is not available for external bootstrap',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }

  const [attempt] = await db
    .select()
    .from(aiRunAttempts)
    .where(
      and(
        eq(aiRunAttempts.runId, existing.id),
        eq(aiRunAttempts.dispatchMessageId, dispatchMessageId),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new AiRunIngestError(
      'dispatchMessageId does not match this run',
      'AI_RUN_DISPATCH_MISMATCH',
    );
  }
  if (!isAiRunV2AttemptStatus(attempt.status)) {
    throw new AiRunIngestError(
      'AI run attempt status is invalid',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }
  if (!isDurableInteractiveTurnSpecification(attempt.specSnapshot)) {
    throw new AiRunIngestError(
      'Interactive attempt is missing a frozen specification',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }

  const absoluteDeadlineAt = existing.timeoutAt?.trim();
  if (!absoluteDeadlineAt) {
    throw new AiRunIngestError(
      'Interactive attempt is missing timeoutAt',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }
  const remainingMs = Date.parse(absoluteDeadlineAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new AiRunIngestError(
      'Interactive absolute deadline has expired',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }

  const effectiveDeadlines = clampInteractiveDeadlinePolicy(
    attempt.specSnapshot.deadlines,
    Math.floor(remainingMs),
  );

  const { getCursorAgentId } = await import('./chatThreadRepository');
  const cursorAgentId = (await getCursorAgentId(existing.threadId)) ?? null;

  return {
    kind: 'interactive-actor-v2',
    specification: attempt.specSnapshot,
    runId: existing.id,
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    attemptStatus: attempt.status,
    dispatchMessageId,
    absoluteDeadlineAt,
    effectiveDeadlines,
    cursorAgentId,
    mcpServers: buildInteractiveProxyMcpServers({
      runId: existing.id,
      attemptId: attempt.id,
      dispatchMessageId,
      absoluteDeadlineAt,
      specification: attempt.specSnapshot,
    }),
    projectId: existing.projectId,
  };
}

async function assertAttemptFence(
  existing: typeof agentRuns.$inferSelect,
  body: AiRunIngestBody,
): Promise<void> {
  if (existing.transportVersion !== 'dapr-actor-v2') return;
  if (!body.attemptId?.trim()) {
    throw new AiRunIngestError(
      'attemptId is required for dapr-actor-v2 ingest',
      'AI_RUN_VALIDATION',
    );
  }
  const [attempt] = await db
    .select()
    .from(aiRunAttempts)
    .where(
      and(
        eq(aiRunAttempts.id, body.attemptId),
        eq(aiRunAttempts.runId, existing.id),
      ),
    )
    .limit(1);
  if (
    !attempt ||
    attempt.dispatchMessageId !== body.dispatchMessageId
  ) {
    throw new AiRunIngestError(
      'attemptId/dispatchMessageId does not match this run',
      'AI_RUN_DISPATCH_MISMATCH',
    );
  }
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
    eventId: body.eventId ?? randomUUID(),
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

/**
 * Download + checksum-verify actor artifacts onto the thread workspace.
 * Returns the parsed manifest (for identity) so the transactional terminal
 * path can record the ref. Filesystem writes are outside the DB transaction.
 */
async function verifyAndApplyActorArtifactManifest(input: {
  threadId: string;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  manifestRef: AiRunBlobRef;
}): Promise<void> {
  const container = resolveArtifactContainerClient(input.manifestRef.container);
  const raw = await container
    .getBlockBlobClient(input.manifestRef.key)
    .downloadToBuffer();
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  if (!isAiRunV2ArtifactManifest(parsed)) {
    throw new AiRunIngestError(
      'Invalid actor artifact manifest',
      'AI_RUN_VALIDATION',
    );
  }
  const [thread] = await db
    .select({ workspaceDir: chatThreads.workspaceDir })
    .from(chatThreads)
    .where(eq(chatThreads.id, input.threadId))
    .limit(1);
  const workspaceRoot = thread?.workspaceDir?.trim();
  if (!workspaceRoot) {
    throw new AiRunIngestError(
      'Completed terminal ingest requires a workspace reference',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }
  await applyInteractiveArtifacts({
    workspaceRoot,
    manifest: parsed,
    expected: {
      runId: input.runId,
      attemptId: input.attemptId,
      attemptNumber: input.attemptNumber,
    },
    reader: createBlobInteractiveArtifactReader(async (ref) =>
      resolveArtifactContainerClient(ref.container)
        .getBlockBlobClient(ref.key)
        .downloadToBuffer(),
    ),
  });
}

/**
 * Six-write fenced terminal for dapr-actor-v2: drain/accept stream events,
 * record verified manifest, persist assistant message, terminalize attempt/run,
 * clear matching thread active run, persist error/done — one DB transaction.
 * Fence was already validated before this runs.
 */
async function terminalizeDaprActorV2(input: {
  existing: typeof agentRuns.$inferSelect;
  body: AiRunTerminalIngest;
  nowIso: string;
  detail: string | undefined;
  attemptNumber: number;
  dependencies: AiRunIngestDependencies;
}): Promise<AiRunIngestResult> {
  const { existing, body, nowIso, detail, attemptNumber, dependencies } = input;
  const runId = existing.id;
  const attemptId = body.attemptId!;
  const status = body.status;
  const failureCategory: AiRunV2FailureCategory | null =
    status === 'failed' && body.failureCategory
      ? body.failureCategory
      : null;
  const attemptTerminalStatus =
    status === 'completed'
      ? 'completed'
      : status === 'cancelled'
        ? 'cancelled'
        : 'failed';

  // Filesystem verify/apply before the DB transaction (not a SQL write).
  if (status === 'completed' && body.artifactManifestRef) {
    await verifyAndApplyActorArtifactManifest({
      threadId: existing.threadId,
      runId,
      attemptId,
      attemptNumber,
      manifestRef: body.artifactManifestRef,
    });
  }

  const terminalEvents =
    status === 'failed'
      ? [
          buildTerminalEnvelope(existing, body, nowIso, status, detail),
          buildDoneEnvelope(existing, nowIso, status, detail),
        ]
      : [buildTerminalEnvelope(existing, body, nowIso, status, detail)];

  const assistantMessage =
    existing.lane === INTERACTIVE_LANE && body.event?.type === 'message'
      ? body.event.message
      : null;
  const cursorAgentId =
    status === 'completed' && existing.lane === INTERACTIVE_LANE
      ? sanitizeCursorAgentId(body.cursorAgentId)
      : undefined;

  const run = await db.transaction(async (tx) => {
    // 1. Drain/accept already-persisted stream events: fence re-check under
    //    the same txn. Stale fences must 409 before any of the writes below.
    const [locked] = await tx
      .select({
        dispatchMessageId: agentRuns.dispatchMessageId,
        status: agentRuns.status,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    if (!locked || locked.dispatchMessageId !== body.dispatchMessageId) {
      throw new AiRunIngestError(
        'dispatchMessageId does not match this run',
        'AI_RUN_DISPATCH_MISMATCH',
      );
    }
    if (isAgentRunTerminalStatus(locked.status)) {
      if (locked.status === status) {
        return (
          await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
        )[0]!;
      }
      throw new AiRunIngestError(
        `Cannot apply ${status} terminal to ${locked.status} run`,
        'AI_RUN_ILLEGAL_TRANSITION',
      );
    }

    // 2. Record verified manifest on the attempt (files already on disk).
    if (status === 'completed' && body.artifactManifestRef) {
      await tx
        .update(aiRunAttempts)
        .set({
          manifestRef: body.artifactManifestRef,
          artifactStatus: 'verified',
          updatedAt: nowIso,
        })
        .where(eq(aiRunAttempts.id, attemptId));
    }

    // 3. Persist final assistant message (idempotent by id).
    if (assistantMessage) {
      await tx
        .insert(chatMessages)
        .values({
          id: assistantMessage.id,
          threadId: existing.threadId,
          role: assistantMessage.role,
          text: assistantMessage.text,
          toolName: assistantMessage.toolName ?? null,
          hidden: assistantMessage.hidden ?? false,
          ts: assistantMessage.ts,
        })
        .onConflictDoNothing();
    }

    // 4. Terminalize attempt + run.
    await tx
      .update(aiRunAttempts)
      .set({
        status: attemptTerminalStatus,
        ...(failureCategory ? { failureCategory } : {}),
        ...(status === 'failed' && detail ? { failureDetail: detail } : {}),
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(aiRunAttempts.id, attemptId),
          eq(aiRunAttempts.dispatchMessageId, body.dispatchMessageId),
        ),
      );

    const [updatedRun] = await tx
      .update(agentRuns)
      .set({
        status,
        lastError: status === 'failed' ? detail ?? status : null,
        progressPhase: 'completion',
        progressLabel: detail ?? status,
        progressAt: nowIso,
        updatedAt: nowIso,
        ...(body.terminalReason ? { terminalReason: body.terminalReason } : {}),
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.dispatchMessageId, body.dispatchMessageId),
          inArray(agentRuns.status, ['queued', 'dispatched', 'running']),
        ),
      )
      .returning();

    if (!updatedRun) {
      throw new AiRunIngestError(
        `Cannot apply ${status} terminal to run`,
        'AI_RUN_ILLEGAL_TRANSITION',
      );
    }

    // 5. Clear matching thread active run only.
    await tx
      .update(chatThreads)
      .set({
        status: 'idle',
        activeRunId: null,
        lastError: status === 'failed' ? detail ?? null : null,
        lastActivityAt: nowIso,
      })
      .where(
        and(
          eq(chatThreads.id, existing.threadId),
          eq(chatThreads.activeRunId, runId),
        ),
      );

    if (cursorAgentId !== undefined) {
      await tx
        .update(chatThreads)
        .set({ cursorAgentId })
        .where(eq(chatThreads.id, existing.threadId));
    }

    // 6. Persist error/done (and completed) terminal events.
    for (const envelope of terminalEvents) {
      await tx.execute(sql`
        INSERT INTO agent_run_events (
          event_id, thread_id, run_id, source_instance, sequence,
          event_timestamp, event_type, phase, status, detail, event
        ) VALUES (
          ${envelope.eventId}::uuid,
          ${envelope.threadId},
          ${envelope.runId},
          ${envelope.sourceInstance},
          ${envelope.sequence},
          ${envelope.timestamp}::timestamptz,
          ${envelope.type},
          ${envelope.phase},
          ${envelope.status},
          ${envelope.detail ?? null},
          ${JSON.stringify(envelope.event)}::jsonb
        )
        ON CONFLICT (event_id) DO NOTHING
      `);
    }

    return updatedRun;
  });

  for (const envelope of terminalEvents) {
    await notifyRunEvent(envelope, { persist: false }).catch(() => {});
  }

  if (status === 'failed' || status === 'cancelled') {
    await reflectFailedGeneration(existing.threadId, dependencies);
  }

  return { run: mapRow(run), cancelRequested: run.cancelRequested };
}

async function loadAttemptNumber(attemptId: string): Promise<number> {
  const [attempt] = await db
    .select({ attemptNumber: aiRunAttempts.attemptNumber })
    .from(aiRunAttempts)
    .where(eq(aiRunAttempts.id, attemptId))
    .limit(1);
  if (!attempt) {
    throw new AiRunIngestError(
      'attemptId does not match this run',
      'AI_RUN_DISPATCH_MISMATCH',
    );
  }
  return attempt.attemptNumber;
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
  await assertAttemptFence(existing, body);

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
      if (body.status === 'failed' || body.status === 'cancelled') {
        await reflectFailedGeneration(existing.threadId, dependencies);
      }
      return { run, cancelRequested: run.cancelRequested };
    }
    throw new AiRunIngestError(
      `Cannot apply ${body.status} terminal to ${existing.status} run`,
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }

  if (body.kind === 'heartbeat' || body.kind === 'progress') {
    // User Stop (cancelRun) often terminalizes the run before the interactive
    // actor / worker observes cancelRequested on its next heartbeat. Returning
    // cancelRequested here lets the turn exit cooperatively instead of treating
    // the race as a fatal "Interactive turn failed".
    if (existing.status === 'cancelled') {
      return { run: mapRow(existing), cancelRequested: true };
    }
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
    await reflectFailedGeneration(existing.threadId, dependencies);
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

  if (existing.transportVersion === 'dapr-actor-v2') {
    const attemptNumber = await loadAttemptNumber(body.attemptId!);
    return terminalizeDaprActorV2({
      existing,
      body,
      nowIso,
      detail,
      attemptNumber,
      dependencies,
    });
  }

  if (body.status === 'completed') {
    const snapshot = existing.executionSnapshot;
    const workspaceDir =
      snapshot && !isDurableInteractiveSnapshot(snapshot)
        ? snapshot.workspaceRef
        : undefined;
    if (!workspaceDir) {
      throw new AiRunIngestError(
        'Completed terminal ingest requires a workspace reference',
        'AI_RUN_ILLEGAL_TRANSITION',
      );
    }
    // Runs before markTerminal so a completed run's output is durable before
    // anything observes the run as finished. A throw here therefore leaves the
    // run non-terminal and answers the worker with a bare 500, which is
    // retryable but anonymous — name the subsystem so a recurrence is
    // diagnosable without reproducing it.
    try {
      await (
        dependencies.consumeCompletedArtifacts ?? consumeCompletedArtifacts
      )(existing.threadId, workspaceDir);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'AiRunTerminalArtifactSyncFailed',
        runId,
        threadId: existing.threadId,
        lane: existing.lane ?? null,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        errorMessage:
          error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      }));
      throw error;
    }

    // Persist Cursor agent id for interactive restart recovery (best effort).
    if (existing.lane === INTERACTIVE_LANE) {
      const cursorAgentId = sanitizeCursorAgentId(body.cursorAgentId);
      if (cursorAgentId !== undefined) {
        const { setCursorAgentId } = await import('./chatThreadRepository');
        await setCursorAgentId(existing.threadId, cursorAgentId).catch(() => {});
      }
    }
  } else {
    await reflectFailedGeneration(existing.threadId, dependencies);
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
  await persistBackgroundRunUsage(existing, body, dependencies);
  return { run, cancelRequested: run.cancelRequested };
}
