/**
 * Authenticated worker-to-web ingest for background AI runs (FEAT-004).
 *
 * The project-scoped row and exact dispatch fence are checked before every
 * mutation, including idempotent terminal callbacks. Durable progress uses the
 * established PostgreSQL event spine; terminal writes delegate to lifecycle.
 */
import { randomUUID } from 'crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  agentRuns,
  aiRunAttempts,
  aiTurnStageTimings,
  chatThreadCommands,
  chatThreads,
  chatMessages,
} from '../db/schema';
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
import { notifyOutbox } from './aiRunV2/outboxRepository';
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
  type AiRunBootstrapResult,
  type AiRunIngestErrorCode,
  type AiRunProgressIngest,
  type AiRunSummaryIngest,
  type AiRunSummaryIngestStatus,
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
import { trackEvent } from './telemetry';
import { recordCursorChatUsage } from './aiUsageService';
import type { RecordUsageInput } from '../../shared/types/aiCostAnalytics';
import type { InteractiveTerminalInput } from './brainstormTurnLedger';
import { clampInteractiveDeadlinePolicy } from './interactiveDeadlinePolicy';
import { issueInteractiveToolProxyToken } from './interactiveToolProxyToken';
import { deriveInteractiveCursorExecutionFields } from './cursorExecutionSpecification';
import {
  isHarnessRecreateReason,
  resolveChatAreaId,
  type HarnessPendingControl,
  type HarnessReceiptReason,
} from '../../shared/types/chatHarness';
import {
  chatHarnessSummaryStore,
  type HarnessSummaryRecord,
  type SaveSummaryInput,
} from './chatHarness/chatHarnessSummaryStore';
import { chatHarnessCommandRepository } from './chatHarness/chatHarnessCommandRepository';
import {
  InteractiveArtifactApplyError,
  createBlobInteractiveArtifactReader,
  interactiveTranscript,
  readInteractiveArtifacts,
  verifyInlineInteractiveArtifacts,
  writeInteractiveArtifacts,
  type VerifiedInteractiveArtifact,
} from './interactiveArtifactApplier';
import { resolveArtifactContainerClient } from './aiRunV2/artifactContainer';
import { updateThreadKickoffTranscript } from './chatAgentService';
import { saveThreadOutputs } from './chatThreadOutputStore';
import { keepsThreadFolder } from './threadFolder';
import { isCursorModelBlockedMessage } from '../../shared/utils/modelAvailability';

// Ingest persists worker events without emitting them to this instance's
// in-memory thread subscribers, so they must not carry this instance's id or
// the SSE route drops the PostgreSQL echo as already delivered.
export const AI_RUN_INGEST_SOURCE_INSTANCE = `${RUN_EVENT_SOURCE_INSTANCE}:ai-run-ingest`;

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
const SUMMARY_STATUSES: ReadonlySet<AiRunSummaryIngestStatus> = new Set([
  'running',
  'completed',
  'error',
  'fallback',
]);

function isDurableInteractiveSnapshot(
  snapshot: AgentRunExecutionSnapshot,
): snapshot is Extract<
  AgentRunExecutionSnapshot,
  { kind: 'interactive-turn' }
> {
  return 'kind' in snapshot && snapshot.kind === 'interactive-turn';
}

const STAGE_TIMING_FIELDS = [
  'workspaceMs',
  'agentAcquireMs',
  'firstEventMs',
  'firstTokenMs',
  'workerTurnMs',
] as const;

function elapsedSince(startIso: string | null, endMs: number): number | undefined {
  if (!startIso) return undefined;
  const startMs = Date.parse(startIso);
  return Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : undefined;
}

const MAX_PG_INT32 = 2_147_483_647;

function toPgDurationInt(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), MAX_PG_INT32);
}

/** Malformed timings are dropped: telemetry must not reject a terminal. */
function trackInteractiveTurnStages(
  existing: typeof agentRuns.$inferSelect,
  body: AiRunTerminalIngest,
  nowIso: string,
): void {
  const timings: Record<string, unknown> =
    body.stageTimings && typeof body.stageTimings === 'object'
      ? body.stageTimings
      : {};
  const measurements: Record<string, number> = {};
  for (const field of STAGE_TIMING_FIELDS) {
    const value = timings[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      measurements[field] = value;
    }
  }
  const nowMs = Date.parse(nowIso);
  const admittedToTerminalMs = elapsedSince(existing.createdAt, nowMs);
  if (admittedToTerminalMs !== undefined) {
    measurements.admittedToTerminalMs = admittedToTerminalMs;
  }
  const dispatchedToTerminalMs = elapsedSince(existing.dispatchedAt, nowMs);
  if (dispatchedToTerminalMs !== undefined) {
    measurements.dispatchedToTerminalMs = dispatchedToTerminalMs;
  }
  const snapshot = existing.executionSnapshot;
  const specification =
    snapshot && isDurableInteractiveSnapshot(snapshot) ? snapshot : null;
  const agentMode = timings.agentMode;
  const acquisitionMode =
    agentMode === 'warm' || agentMode === 'resumed' || agentMode === 'recreated'
      ? agentMode
      : undefined;
  const rawRecreateReason = body.recreateReason ?? timings.recreateReason;
  const recreateReason = isHarnessRecreateReason(rawRecreateReason)
    ? rawRecreateReason
    : undefined;
  const area =
    specification?.harness?.area ??
    resolveChatAreaId(specification?.workflowClass ?? null);
  trackEvent(
    'InteractiveTurnStages',
    {
      status: body.status,
      agentMode: acquisitionMode ?? 'unknown',
      ...(recreateReason ? { recreateReason } : {}),
      workflowClass: specification?.workflowClass ?? 'unknown',
      ...(area ? { area } : {}),
      interviewPhase: specification?.guidedInterview?.phase ?? 'none',
      grounded: specification?.grounding ? 'true' : 'false',
    },
    measurements,
  );
  // Best-effort durable telemetry row for Platform Admin AI Experience.
  // Never blocks or fails terminal ingest.
  const stageStatus =
    body.status === 'completed' || body.status === 'failed' || body.status === 'cancelled'
      ? body.status
      : null;
  if (stageStatus) {
    try {
      const insertChain = db.insert(aiTurnStageTimings);
      const valuesChain = insertChain?.values?.({
        runId: existing.id,
        threadId: existing.threadId,
        projectId: existing.projectId ?? null,
        area: area ?? null,
        workflowClass: specification?.workflowClass ?? null,
        status: stageStatus,
        agentMode: acquisitionMode ?? 'unknown',
        recreateReason: recreateReason ?? null,
        grounded: Boolean(specification?.grounding),
        workspaceMs: toPgDurationInt(measurements.workspaceMs),
        agentAcquireMs: toPgDurationInt(measurements.agentAcquireMs),
        firstEventMs: toPgDurationInt(measurements.firstEventMs),
        firstTokenMs: toPgDurationInt(measurements.firstTokenMs),
        workerTurnMs: toPgDurationInt(measurements.workerTurnMs),
        admittedToTerminalMs: toPgDurationInt(measurements.admittedToTerminalMs),
        dispatchedToTerminalMs: toPgDurationInt(measurements.dispatchedToTerminalMs),
        recordedAt: nowIso,
      });
      const pending = valuesChain?.onConflictDoNothing?.();
      if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(pending).catch((err) => {
          console.error('[aiRunIngestService] Failed to persist turn stage timings:', err);
        });
      }
    } catch {
      // Best-effort telemetry: ignore persistence failures so terminal ingest always succeeds.
    }
  }
  const turnDurationMs =
    measurements.workerTurnMs ??
    body.durationMs ??
    admittedToTerminalMs ??
    0;
  emitWorkerTelemetry(() => {
    workerTierTelemetry.interactiveTurn?.(
      {
        runId: existing.id,
        dispatchMessageId: body.dispatchMessageId,
        project: existing.projectId ?? undefined,
        lane: existing.lane ?? INTERACTIVE_LANE,
        ...(area ? { area } : {}),
        ...(acquisitionMode ? { acquisitionMode } : {}),
        ...(recreateReason ? { recreateReason } : {}),
      },
      turnDurationMs,
    );
  });
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
  pendingControl?: ReadonlyArray<HarnessPendingControl>;
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
    reportedCostUsd?: number;
    tokenSource?: RecordUsageInput['tokenSource'];
    durationMs: number;
    status: RecordUsageInput['status'];
  }) => Promise<void>;
  /** Called when a failed run reports that the Cursor team admin blocked its model. */
  onModelBlocked?: () => void;
  /** Called after an interactive V2 terminal commits. Errors are logged, never thrown. */
  onInteractiveTerminal?: (input: InteractiveTerminalInput) => Promise<void>;
  /** Summary persistence seam for `summary` ingest (defaults to chatHarnessSummaryStore). */
  summaryStore?: {
    saveSummary: (input: SaveSummaryInput) => Promise<HarnessSummaryRecord>;
    countVisibleMessagesBefore: (
      threadId: string,
      beforeMessageId?: string | null,
    ) => Promise<number>;
  };
  /** Updates matching `chat_thread_commands` row when a `summary` ingest carries `commandId`. */
  updateCommandReceipt?: (input: {
    threadId: string;
    commandId: string;
    status: 'applied' | 'rejected';
    reason: HarnessReceiptReason | null;
    updatedAt: string;
  }) => Promise<void>;
  /** Slow-path pending steer/cancel commands for an active interactive run. */
  listPendingControlForRun?: (
    threadId: string,
    runId: string,
  ) => Promise<HarnessPendingControl[]>;
}

async function defaultUpdateCommandReceipt(input: {
  threadId: string;
  commandId: string;
  status: 'applied' | 'rejected';
  reason: HarnessReceiptReason | null;
  updatedAt: string;
}): Promise<void> {
  try {
    await db
      .update(chatThreadCommands)
      .set({
        status: input.status,
        reason: input.reason,
        updatedAt: input.updatedAt,
      })
      .where(
        and(
          eq(chatThreadCommands.threadId, input.threadId),
          eq(chatThreadCommands.commandId, input.commandId),
        ),
      );
  } catch (err) {
    console.warn(
      `[aiRunIngest] Command receipt update failed (commandId=${input.commandId}): ${err instanceof Error ? err.message : 'Unexpected error'}`,
    );
  }
}

async function defaultOnInteractiveTerminal(input: InteractiveTerminalInput): Promise<void> {
  const { finalizeBrainstormTerminal } = await import('./brainstormTurnLedger');
  await finalizeBrainstormTerminal(input);
}

function requestModelAvailabilityProbe(): void {
  void import('./modelsService')
    .then((models) => models.requestModelAvailabilityProbe())
    .catch(() => {});
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
  const { applyAdrGenerationResult } = await import('./adrService');
  await applyAdrGenerationResult(threadId, null, 'the agent run failed');
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
      ...(body.costUsd !== undefined ? { reportedCostUsd: body.costUsd } : {}),
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

  if (body.kind === 'summary') {
    if (!SUMMARY_STATUSES.has(body.status)) {
      throw new AiRunIngestError('Invalid summary status', 'AI_RUN_VALIDATION');
    }
    if (
      (body.status === 'completed' || body.status === 'fallback') &&
      (typeof body.text !== 'string' || body.text.trim().length === 0)
    ) {
      throw new AiRunIngestError(
        'Completed or fallback summary requires non-empty text',
        'AI_RUN_VALIDATION',
      );
    }
    if (
      body.coversThroughOrdinal !== undefined &&
      (!Number.isSafeInteger(body.coversThroughOrdinal) ||
        body.coversThroughOrdinal < 0)
    ) {
      throw new AiRunIngestError(
        'coversThroughOrdinal must be a non-negative integer',
        'AI_RUN_VALIDATION',
      );
    }
    if (body.commandId !== undefined && !isCanonicalUuid(body.commandId)) {
      throw new AiRunIngestError(
        'summary commandId must be a canonical UUID',
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
      body.clearCursorAgentId !== undefined
      && typeof body.clearCursorAgentId !== 'boolean'
    ) {
      throw new AiRunIngestError(
        'clearCursorAgentId must be a boolean',
        'AI_RUN_VALIDATION',
      );
    }
    if (
      body.recreateReason !== undefined
      && !isHarnessRecreateReason(body.recreateReason)
    ) {
      throw new AiRunIngestError(
        'Invalid recreateReason',
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
    if (body.inlineArtifacts !== undefined) {
      if (!Array.isArray(body.inlineArtifacts)) {
        throw new AiRunIngestError(
          'inlineArtifacts must be an array',
          'AI_RUN_VALIDATION',
        );
      }
      if (process.env.NODE_ENV === 'production' && body.inlineArtifacts.length > 0) {
        throw new AiRunIngestError(
          'inlineArtifacts is not permitted in production',
          'AI_RUN_VALIDATION',
        );
      }
    }
    for (const field of [
      'durationMs',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
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
    devSessionId: row.devSessionId ?? null,
    buildTaskId: row.buildTaskId ?? null,
    workflowClass: row.workflowClass ?? null,
    cloudAgentIdentity: row.cloudAgentIdentity ?? null,
    cloudAgentManaged: row.cloudAgentManaged ?? false,
    checkResults: row.checkResults ?? null,
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
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.APEX_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  // Actor hosts run in other containers, where localhost is not App Service.
  if (process.env.WEBSITE_SITE_NAME?.trim()) {
    throw new AiRunIngestError(
      'APEX_URL or AI_RUNS_APEX_CALLBACK_BASE_URL is required for interactive tool proxy URLs',
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }
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

  const mcpServers = buildInteractiveProxyMcpServers({
    runId: existing.id,
    attemptId: attempt.id,
    dispatchMessageId,
    absoluteDeadlineAt,
    specification: attempt.specSnapshot,
  });
  const explicitExecution = deriveInteractiveCursorExecutionFields({
    mcpServerNames: Object.keys(mcpServers),
    interviewPhase: attempt.specSnapshot.guidedInterview?.phase ?? null,
  });

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
    mcpServers,
    projectId: existing.projectId,
    requestId: existing.id,
    ...explicitExecution,
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
    sourceInstance: AI_RUN_INGEST_SOURCE_INSTANCE,
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
    sourceInstance: AI_RUN_INGEST_SOURCE_INSTANCE,
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
    sourceInstance: AI_RUN_INGEST_SOURCE_INSTANCE,
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

async function applyVerifiedInteractiveArtifacts(input: {
  threadId: string;
  runId: string;
  files: readonly VerifiedInteractiveArtifact[];
}): Promise<void> {
  const [thread] = await db
    .select({ workspaceDir: chatThreads.workspaceDir, kickoff: chatThreads.kickoff })
    .from(chatThreads)
    .where(eq(chatThreads.id, input.threadId))
    .limit(1);
  if (!thread) {
    throw new AiRunIngestError('Completed terminal ingest has no thread', 'AI_RUN_ILLEGAL_TRANSITION');
  }
  await saveThreadOutputs(
    input.threadId,
    input.runId,
    input.files.map((file) => ({ path: file.path, content: file.body.toString('utf8') })),
  );
  const workspaceRoot = thread.workspaceDir?.trim();
  if (workspaceRoot && (await keepsThreadFolder(thread.kickoff.project))) {
    await writeInteractiveArtifacts(workspaceRoot, input.files);
  }
  // Document runs build their inputs from the saved thread, so the transcript
  // the agent wrote must land there as well.
  const transcript = interactiveTranscript(input.files);
  if (transcript !== null) {
    await updateThreadKickoffTranscript(input.threadId, transcript).catch((error: unknown) => {
      console.warn(
        `[aiRunIngest] Transcript save failed (threadId=${input.threadId}): ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
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
  const files = await readInteractiveArtifacts({
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
  await applyVerifiedInteractiveArtifacts({
    threadId: input.threadId,
    runId: input.runId,
    files,
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
  } else if (
    status === 'completed' &&
    body.inlineArtifacts &&
    body.inlineArtifacts.length > 0
  ) {
    let files: VerifiedInteractiveArtifact[];
    try {
      files = verifyInlineInteractiveArtifacts(body.inlineArtifacts);
    } catch (error) {
      if (error instanceof InteractiveArtifactApplyError) {
        throw new AiRunIngestError(error.message, 'AI_RUN_VALIDATION');
      }
      throw error;
    }
    await applyVerifiedInteractiveArtifacts({
      threadId: existing.threadId,
      runId,
      files,
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
  const shouldClearCursorAgentId =
    existing.lane === INTERACTIVE_LANE &&
    (body.clearCursorAgentId === true || status === 'cancelled');
  const cursorAgentId = shouldClearCursorAgentId
    ? null
    : status === 'completed' && existing.lane === INTERACTIVE_LANE
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

    // 5.5. Settle harness commands owned by this run so state frames and
    // reload snapshots never keep a finished send/retry (or queued follow-up
    // steer) stuck as pending.
    if (existing.lane === INTERACTIVE_LANE) {
      const commandConditions = [
        and(
          inArray(chatThreadCommands.kind, ['send', 'retry']),
          eq(chatThreadCommands.status, 'accepted'),
        ),
        and(
          eq(chatThreadCommands.kind, 'steer'),
          eq(chatThreadCommands.status, 'queued'),
        ),
        ...(status === 'cancelled'
          ? [
              and(
                inArray(chatThreadCommands.kind, ['cancel', 'summarize']),
                eq(chatThreadCommands.status, 'accepted'),
              ),
            ]
          : []),
      ];
      await tx
        .update(chatThreadCommands)
        .set({
          status: 'applied',
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(chatThreadCommands.threadId, existing.threadId),
            eq(chatThreadCommands.runId, runId),
            or(...commandConditions),
          ),
        );
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

  if (
    existing.lane === INTERACTIVE_LANE
    && typeof (db as { execute?: unknown }).execute === 'function'
  ) {
    await notifyOutbox(db, {
      outboxId: 'interactive-slot-release',
      runId,
    }).catch(() => undefined);

    // Reconcile any mid-turn steer commands still in `accepted` for this now-
    // terminal run so they never sit stuck as "Steer received".
    try {
      const pending = await (
        dependencies.listPendingControlForRun ??
        ((tId: string, rId: string) =>
          chatHarnessCommandRepository.listPendingControlForRun(tId, rId))
      )(existing.threadId, runId);
      const unackedSteers = pending.filter((item) => item.kind === 'steer');
      if (unackedSteers.length > 0) {
        if (status === 'completed') {
          const { chatHarnessCommandHandler } = await import(
            './chatHarness/chatHarnessCommandHandler'
          );
          for (const steer of unackedSteers) {
            await chatHarnessCommandHandler
              .handleControlAck({
                threadId: existing.threadId,
                runId,
                commandId: steer.commandId,
                kind: 'steer',
                disposition: 'turn-ended',
                timestamp: nowIso,
              })
              .catch(() => undefined);
          }
        } else {
          for (const steer of unackedSteers) {
            await chatHarnessCommandRepository
              .updateReceipt(existing.threadId, steer.commandId, {
                status: 'rejected',
                reason: 'Did not reach the agent',
                runId,
                expectedStatus: 'accepted',
              })
              .catch(() => undefined);
          }
        }
      }
    } catch {
      // Best-effort post-terminal reconciliation; maintenance scheduler backstops.
    }
  }

  const snapshot = existing.executionSnapshot;
  const frozenWorkflowClass =
    snapshot && isDurableInteractiveSnapshot(snapshot) ? snapshot.workflowClass : null;
  if (existing.lane === INTERACTIVE_LANE && frozenWorkflowClass === 'brainstorm') {
    await (dependencies.onInteractiveTerminal ?? defaultOnInteractiveTerminal)({
      threadId: existing.threadId,
      runId,
      status,
      failureCategory,
      message: assistantMessage ? { id: assistantMessage.id, text: assistantMessage.text } : null,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      cacheReadTokens: body.cacheReadTokens,
      cacheWriteTokens: body.cacheWriteTokens,
      ...(body.costUsd !== undefined ? { costUsd: body.costUsd } : {}),
      durationMs: body.durationMs,
    }).catch((err: unknown) => {
      console.error(
        '[aiRunIngest] interactive terminal effect failed:',
        err instanceof Error ? err.message : 'Unexpected error',
      );
    });
  } else if (
    existing.lane === INTERACTIVE_LANE
    && snapshot
    && isDurableInteractiveSnapshot(snapshot)
    && (body.inputTokens !== undefined || body.outputTokens !== undefined)
  ) {
    const usageStatus =
      status === 'completed'
        ? 'success'
        : status === 'cancelled'
          ? 'cancelled'
          : 'error';
    await (dependencies.recordCursorChatUsage ?? recordCursorChatUsage)({
      kickoff: {
        project: snapshot.projectId,
        ...(snapshot.skill?.path ? { skillPath: snapshot.skill.path } : {}),
      },
      modelId: snapshot.model,
      threadId: existing.threadId,
      runId,
      inputTokens: body.inputTokens ?? 0,
      outputTokens: body.outputTokens ?? 0,
      cacheReadTokens: body.cacheReadTokens,
      cacheWriteTokens: body.cacheWriteTokens,
      ...(body.costUsd !== undefined ? { reportedCostUsd: body.costUsd } : {}),
      tokenSource: 'exact',
      durationMs: body.durationMs ?? 0,
      status: usageStatus,
    }).catch((err: unknown) => {
      console.error(
        `[aiRunIngest] Failed to record interactive usage (runId=${runId})`,
        err,
      );
    });
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

/**
 * Fenced handler for `summary` ingest events (`running | completed | fallback | error`).
 * Never writes summary text into `agent_run_events`, logs, or telemetry (BR-007).
 */
async function handleSummaryIngest(input: {
  projectId: string;
  runId: string;
  existing: typeof agentRuns.$inferSelect;
  body: AiRunSummaryIngest;
  nowIso: string;
  dependencies: AiRunIngestDependencies;
}): Promise<AiRunIngestResult> {
  const { projectId, runId, existing, body, nowIso, dependencies } = input;
  if (existing.status === 'cancelled') {
    return { run: mapRow(existing), cancelRequested: true };
  }
  if (isAgentRunTerminalStatus(existing.status) || existing.status === 'queued') {
    throw new AiRunIngestError(
      `Cannot apply summary to ${existing.status} run`,
      'AI_RUN_ILLEGAL_TRANSITION',
    );
  }
  if (existing.status === 'dispatched') {
    assertLifecycleSuccess(await transition(runId, 'running', {
      expectedFrom: 'dispatched',
      dispatchMessageId: body.dispatchMessageId,
    }));
  }

  const updated = await updateWorkerClocks(
    projectId,
    runId,
    body.dispatchMessageId,
    {
      heartbeatAt: nowIso,
      progressAt: nowIso,
      progressLabel: body.status === 'running' ? 'Summarizing conversation…' : null,
      progressPhase: body.status === 'running' ? 'analysis' : 'completion',
    },
  );

  const snapshot = existing.executionSnapshot;
  const interactiveSpec =
    snapshot && isDurableInteractiveSnapshot(snapshot) ? snapshot : null;
  const isSummarizeOperation =
    interactiveSpec?.harness?.operation === 'summarize';
  const source: 'auto' | 'user' = isSummarizeOperation ? 'user' : 'auto';
  const area =
    interactiveSpec?.harness?.area ??
    resolveChatAreaId(interactiveSpec?.workflowClass ?? null) ??
    'unknown';
  const summaryStore = dependencies.summaryStore ?? chatHarnessSummaryStore;
  const updateReceipt =
    dependencies.updateCommandReceipt ?? defaultUpdateCommandReceipt;

  if (body.status === 'completed' || body.status === 'fallback') {
    const coversThroughOrdinal =
      body.coversThroughOrdinal !== undefined
        ? body.coversThroughOrdinal
        : await summaryStore.countVisibleMessagesBefore(
            existing.threadId,
            isSummarizeOperation
              ? null
              : (interactiveSpec?.currentMessage.id ?? null),
          );
    const isFallback = body.status === 'fallback';
    await summaryStore.saveSummary({
      threadId: existing.threadId,
      runId: existing.id,
      summaryText: body.text!,
      source,
      isFallback,
      coversThroughOrdinal,
    });

    const envelope: AgentRunEventEnvelope = {
      eventId: randomUUID(),
      threadId: existing.threadId,
      runId: existing.id,
      sourceInstance: AI_RUN_INGEST_SOURCE_INSTANCE,
      sequence: nextRunEventSequence(existing.id),
      timestamp: nowIso,
      type: 'summary',
      phase: 'completion',
      status: 'completed',
      detail: undefined,
      event: {
        type: 'summary',
        status: body.status,
        runId: existing.id,
        eventTimestamp: nowIso,
      },
    };
    await notifyRunEvent(envelope, { persist: true });

    emitWorkerTelemetry(() => {
      trackEvent(
        'chat.harness.summary',
        {
          area,
          source,
          fallback: String(isFallback),
          runId: existing.id,
        },
        { coversThroughOrdinal },
      );
    });

    if (body.commandId) {
      await updateReceipt({
        threadId: existing.threadId,
        commandId: body.commandId,
        status: 'applied',
        reason: null,
        updatedAt: nowIso,
      });
    }
  } else if (body.status === 'running') {
    const envelope: AgentRunEventEnvelope = {
      eventId: randomUUID(),
      threadId: existing.threadId,
      runId: existing.id,
      sourceInstance: AI_RUN_INGEST_SOURCE_INSTANCE,
      sequence: nextRunEventSequence(existing.id),
      timestamp: nowIso,
      type: 'summary',
      phase: 'analysis',
      status: 'running',
      detail: 'Summarizing conversation…',
      event: {
        type: 'summary',
        status: 'running',
        runId: existing.id,
        eventTimestamp: nowIso,
      },
    };
    await notifyRunEvent(envelope, { persist: true });
  } else {
    const envelope: AgentRunEventEnvelope = {
      eventId: randomUUID(),
      threadId: existing.threadId,
      runId: existing.id,
      sourceInstance: AI_RUN_INGEST_SOURCE_INSTANCE,
      sequence: nextRunEventSequence(existing.id),
      timestamp: nowIso,
      type: 'summary',
      phase: 'completion',
      status: 'failed',
      detail: undefined,
      event: {
        type: 'summary',
        status: 'error',
        runId: existing.id,
        eventTimestamp: nowIso,
      },
    };
    await notifyRunEvent(envelope, { persist: true });

    if (body.commandId) {
      await updateReceipt({
        threadId: existing.threadId,
        commandId: body.commandId,
        status: 'rejected',
        reason: 'Could not summarize this conversation',
        updatedAt: nowIso,
      });
    }
  }

  const run = mapRow(updated);
  return { run, cancelRequested: run.cancelRequested };
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

  if (
    body.kind === 'terminal'
    && body.status === 'failed'
    && detail
    && isCursorModelBlockedMessage(detail)
  ) {
    (dependencies.onModelBlocked ?? requestModelAvailabilityProbe)();
  }

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
    let pendingControl: HarnessPendingControl[] | undefined;
    if (existing.lane === INTERACTIVE_LANE) {
      try {
        const listPending =
          dependencies.listPendingControlForRun ??
          ((tId: string, rId: string) =>
            chatHarnessCommandRepository.listPendingControlForRun(tId, rId));
        const items = await listPending(existing.threadId, runId);
        if (items.length > 0) {
          pendingControl = items;
        }
      } catch {
        // Best-effort slow-path control delivery; Redis fast path still operates.
      }
    }
    return {
      run,
      cancelRequested: run.cancelRequested,
      ...(pendingControl ? { pendingControl } : {}),
    };
  }

  if (body.kind === 'summary') {
    return handleSummaryIngest({
      projectId,
      runId,
      existing,
      body,
      nowIso,
      dependencies,
    });
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
    if (existing.lane === INTERACTIVE_LANE) {
      const { setCursorAgentId } = await import('./chatThreadRepository');
      await setCursorAgentId(existing.threadId, null).catch(() => {});
    }
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
    const result = await terminalizeDaprActorV2({
      existing,
      body,
      nowIso,
      detail,
      attemptNumber,
      dependencies,
    });
    if (existing.lane === INTERACTIVE_LANE) {
      trackInteractiveTurnStages(existing, body, nowIso);
    }
    return result;
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
      if (body.clearCursorAgentId === true) {
        const { setCursorAgentId } = await import('./chatThreadRepository');
        await setCursorAgentId(existing.threadId, null).catch(() => {});
      } else {
        const cursorAgentId = sanitizeCursorAgentId(body.cursorAgentId);
        if (cursorAgentId !== undefined) {
          const { setCursorAgentId } = await import('./chatThreadRepository');
          await setCursorAgentId(existing.threadId, cursorAgentId).catch(() => {});
        }
      }
    }
  } else {
    if (
      existing.lane === INTERACTIVE_LANE &&
      (body.clearCursorAgentId === true || body.status === 'cancelled')
    ) {
      const { setCursorAgentId } = await import('./chatThreadRepository');
      await setCursorAgentId(existing.threadId, null).catch(() => {});
    }
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
