/**
 * Formal Agent Run Lifecycle deep module (FEAT-001 / TBI-001 / PBI-001).
 *
 * Owns enqueue, legal transitions, frozen execution snapshots, dispatch fencing,
 * and terminal idempotency on the DB-authoritative `agent_runs` queue (BR-001).
 * No public HTTP surface — callers are internal services (admission FEAT-002,
 * worker ingest FEAT-004).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../db/drizzle';
import { agentRuns } from '../db/schema';
import {
  AGENT_RUN_TERMINAL_STATUSES,
  isAgentRunTerminalReason,
  isAgentRunTerminalStatus,
  type AgentRunCancelState,
  type AgentRunLane,
  type AgentRunStatus,
  type AgentRunTerminalReason,
  type ExecutionSnapshot,
} from '../../shared/types/agentRunLifecycle';
import {
  finalizeReconciledAgentRun,
  nextRunEventSequence,
  notifyRunEvent,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  runAdmissionCycle,
  type AdmissionReason,
} from './admissionGovernorService';
import { workerTierTelemetry } from './workerTierTelemetry';

const QUEUED_PROGRESS_LABEL = 'Queued — waiting for available worker';

/**
 * Existing terminal finalizer contract. It owns the atomic terminal CAS,
 * durable event persistence, and post-commit PostgreSQL fan-out.
 */
export type TerminalCompletionHandler = (input: {
  runId: string;
  threadId: string;
  status: 'completed' | 'failed' | 'cancelled';
  detail: string;
  events: AgentRunEventEnvelope[];
  dispatchMessageId?: string;
  terminalReason?: AgentRunTerminalReason;
}) => Promise<boolean>;

export type TerminalGroundingDeactivator = (
  threadId: string,
  projectId: string,
) => Promise<void>;

export class AgentRunLifecycleConflictError extends Error {
  readonly code = 'AGENT_RUN_LIFECYCLE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'AgentRunLifecycleConflictError';
  }
}

/** Legal edges for worker-aware lifecycle (BR-002). */
const ALLOWED_TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(['dispatched', 'cancelled']),
  dispatched: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export type AgentRunLifecycleRow = {
  id: string;
  threadId: string;
  status: string;
  projectId: string | null;
  lane: AgentRunLane | null;
  queuedAt: string | null;
  dispatchedAt: string | null;
  dispatchMessageId: string | null;
  executionSnapshot: ExecutionSnapshot | null;
  cancelRequested: boolean;
  cancelState: AgentRunCancelState | null;
  terminalReason: AgentRunTerminalReason | null;
  timeoutAt: string | null;
  ownerInstance: string | null;
  updatedAt: string;
};

export type LifecycleResult =
  | { ok: true; run: AgentRunLifecycleRow }
  | { ok: false; conflict: true; run: AgentRunLifecycleRow | null; reason: string };

export interface EnqueueAgentRunInput {
  threadId: string;
  projectId: string;
  snapshot: ExecutionSnapshot;
  /** Required for queued status by agent_runs_non_terminal_timeout_at_check. */
  timeoutAt: string;
  lane?: AgentRunLane;
  ownerInstance?: string | null;
  runId?: string;
}

export interface TransitionOptions {
  expectedFrom?: AgentRunStatus | AgentRunStatus[];
  dispatchMessageId?: string;
  terminalReason?: AgentRunTerminalReason;
  lastError?: string | null;
  ownerInstance?: string | null;
}

export interface MarkTerminalInput {
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  terminalReason?: AgentRunTerminalReason;
  dispatchMessageId?: string;
  detail?: string;
  events?: AgentRunEventEnvelope[];
  /** Injected for tests; defaults to durable event persist + NOTIFY fan-out. */
  completionHandler?: TerminalCompletionHandler;
  /** Injected for tests; defaults to best-effort background grounding cleanup. */
  deactivateGrounding?: TerminalGroundingDeactivator;
}

export function isLegalAgentRunTransition(from: AgentRunStatus, to: AgentRunStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * The lane is authoritative for lifecycle partitioning. A legacy row remains
 * in-process even if historical data happens to contain a dispatch identity.
 */
export function isLegacyInProcessAgentRun(row: {
  lane?: string | null;
  dispatchMessageId?: string | null;
}): boolean {
  return row.lane !== 'background';
}

/** Worker-aware lifecycle / reaper clocks apply only to the bounded background lane. */
export function shouldApplyWorkerLifecycle(row: {
  lane?: string | null;
  dispatchMessageId?: string | null;
}): boolean {
  return row.lane === 'background';
}

function mapRow(row: typeof agentRuns.$inferSelect): AgentRunLifecycleRow {
  return {
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    projectId: row.projectId ?? null,
    lane: (row.lane as AgentRunLane | null) ?? null,
    queuedAt: row.queuedAt ?? null,
    dispatchedAt: row.dispatchedAt ?? null,
    dispatchMessageId: row.dispatchMessageId ?? null,
    executionSnapshot: row.executionSnapshot ?? null,
    cancelRequested: row.cancelRequested ?? false,
    cancelState: (row.cancelState as AgentRunCancelState | null) ?? null,
    terminalReason: (row.terminalReason as AgentRunTerminalReason | null) ?? null,
    timeoutAt: row.timeoutAt ?? null,
    ownerInstance: row.ownerInstance ?? null,
    updatedAt: row.updatedAt,
  };
}

function logTransition(fields: Record<string, string | null | undefined>): void {
  // Never log snapshot / prompt / workspace content (PBI-001 security NFR).
  console.info('[agent-run-lifecycle]', JSON.stringify(fields));
}

function workerTelemetryContext(run: {
  id: string;
  projectId: string | null;
  lane: AgentRunLane | null;
  dispatchMessageId: string | null;
}): {
  runId: string;
  project?: string;
  lane?: string;
  dispatchMessageId?: string;
} {
  return {
    runId: run.id,
    ...(run.projectId ? { project: run.projectId } : {}),
    ...(run.lane ? { lane: run.lane } : {}),
    ...(run.dispatchMessageId
      ? { dispatchMessageId: run.dispatchMessageId }
      : {}),
  };
}

function emitWorkerTelemetry(emit: () => void): void {
  try {
    emit();
  } catch {
    // Telemetry must never affect lifecycle durability.
  }
}

async function publishQueuedEvent(
  runId: string,
  threadId: string,
  lane: AgentRunLane,
  timestamp: string,
): Promise<void> {
  const envelope: AgentRunEventEnvelope = {
    eventId: randomUUID(),
    threadId,
    runId,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(runId),
    timestamp,
    type: 'phase',
    phase: 'queued',
    status: 'pending',
    detail: QUEUED_PROGRESS_LABEL,
    event: {
      type: 'phase',
      phase: 'queued',
      status: 'pending',
      detail: QUEUED_PROGRESS_LABEL,
      runId,
      eventTimestamp: timestamp,
    },
  };
  try {
    await notifyRunEvent(envelope, { persist: true });
  } catch {
    console.error('[agent-run-lifecycle] queued event publish failed', JSON.stringify({
      runId,
      lane,
    }));
  }
}

async function attemptAdmission(
  reason: AdmissionReason,
  fields: {
    runId: string;
    projectId: string | null;
    lane: AgentRunLane | null;
  },
): Promise<void> {
  try {
    await runAdmissionCycle(reason);
  } catch {
    // The lifecycle write is already durable. Admission is best-effort here
    // and the S5 safety sweep is responsible for retrying missed triggers.
    console.error('[agent-run-lifecycle]', JSON.stringify({
      ...fields,
      reason,
      status: 'admission_failed',
    }));
  }
}

async function loadRun(runId: string): Promise<AgentRunLifecycleRow | null> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });
  return row ? mapRow(row) : null;
}

async function deactivateTerminalGrounding(
  threadId: string,
  projectId: string,
): Promise<void> {
  const { runGroundingService } = await import('./runGroundingService');
  await runGroundingService.persistThenMarkTerminalInactive(
    { runType: 'chat', runId: threadId, project: projectId },
    async () => undefined,
  );
}

async function bestEffortDeactivateGrounding(
  run: AgentRunLifecycleRow,
  deactivate: TerminalGroundingDeactivator,
): Promise<void> {
  if (run.lane !== 'background' || !run.projectId) return;
  try {
    await deactivate(run.threadId, run.projectId);
  } catch {
    console.error('[agent-run-lifecycle]', JSON.stringify({
      runId: run.id,
      projectId: run.projectId,
      lane: run.lane,
      status: run.status,
      reason: 'grounding_deactivation_failed',
    }));
  }
}

/**
 * Create one queued worker-lane `agent_runs` row with a frozen execution snapshot (AC-a, AC-d).
 */
export async function enqueue(input: EnqueueAgentRunInput): Promise<{ runId: string }> {
  const nowIso = new Date().toISOString();
  const runId = input.runId ?? randomUUID();
  const lane: AgentRunLane = input.lane ?? 'background';

  // Deep-freeze snapshot at enqueue — callers mutating the input object later must not affect storage.
  const frozenSnapshot: ExecutionSnapshot = {
    prompt: input.snapshot.prompt,
    model: input.snapshot.model,
    workspaceRef: input.snapshot.workspaceRef,
    ...(input.snapshot.checkoutRef
      ? { checkoutRef: input.snapshot.checkoutRef }
      : {}),
    workflowClass: input.snapshot.workflowClass,
    skillPath: input.snapshot.skillPath,
    projectId: input.snapshot.projectId,
    threadId: input.snapshot.threadId,
  };

  await db.insert(agentRuns).values({
    id: runId,
    threadId: input.threadId,
    status: 'queued',
    projectId: input.projectId,
    lane,
    queuedAt: nowIso,
    executionSnapshot: frozenSnapshot,
    timeoutAt: input.timeoutAt,
    ownerInstance: input.ownerInstance ?? null,
    cancelRequested: false,
    progressPhase: 'queued',
    progressLabel: QUEUED_PROGRESS_LABEL,
    heartbeatAt: nowIso,
    startedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  logTransition({
    runId,
    projectId: input.projectId,
    lane,
    fromStatus: null,
    toStatus: 'queued',
    dispatchMessageId: null,
  });
  await publishQueuedEvent(runId, input.threadId, lane, nowIso);

  if (lane === 'background') {
    await attemptAdmission('enqueue', {
      runId,
      projectId: input.projectId,
      lane,
    });
  }

  return { runId };
}

/**
 * Atomic, legality-checked (and optionally fenced) status transition.
 * Zero-row updates yield conflict without mutating the row (AC-b / VT-02 / VT-05).
 */
export async function transition(
  runId: string,
  to: AgentRunStatus,
  options: TransitionOptions = {},
): Promise<LifecycleResult> {
  const existing = await loadRun(runId);
  if (!existing) {
    return { ok: false, conflict: true, run: null, reason: 'run_not_found' };
  }

  const fromStatus = existing.status as AgentRunStatus;
  if (!isLegalAgentRunTransition(fromStatus, to)) {
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: `illegal_transition:${fromStatus}->${to}`,
    };
  }

  if (fromStatus === to) {
    return { ok: true, run: existing };
  }

  if (options.expectedFrom) {
    const expected = Array.isArray(options.expectedFrom)
      ? options.expectedFrom
      : [options.expectedFrom];
    if (!expected.includes(fromStatus)) {
      return {
        ok: false,
        conflict: true,
        run: existing,
        reason: `expected_from_mismatch:${fromStatus}`,
      };
    }
  }

  if (to === 'dispatched' && !options.dispatchMessageId) {
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: 'dispatch_identity_required',
    };
  }

  if (options.terminalReason && !isAgentRunTerminalStatus(to)) {
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: 'terminal_reason_requires_terminal_status',
    };
  }

  // Fence: once a dispatch identity exists, fenced transitions must present the matching token (BR-005 / VT-05).
  const requiresFence =
    Boolean(existing.dispatchMessageId)
    && (to === 'running' || AGENT_RUN_TERMINAL_STATUSES.has(to) || to === 'dispatched');
  if (requiresFence) {
    if (options.dispatchMessageId === undefined) {
      return {
        ok: false,
        conflict: true,
        run: existing,
        reason: 'fence_required',
      };
    }
    if (options.dispatchMessageId !== existing.dispatchMessageId) {
      return {
        ok: false,
        conflict: true,
        run: existing,
        reason: 'fence_mismatch',
      };
    }
  }

  if (options.terminalReason && !isAgentRunTerminalReason(options.terminalReason)) {
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: 'invalid_terminal_reason',
    };
  }

  const nowIso = new Date().toISOString();
  const setValues: Record<string, unknown> = {
    status: to,
    updatedAt: nowIso,
  };

  if (to === 'dispatched') {
    setValues.dispatchedAt = nowIso;
    if (options.dispatchMessageId) {
      setValues.dispatchMessageId = options.dispatchMessageId;
    }
  }

  if (options.ownerInstance !== undefined) {
    setValues.ownerInstance = options.ownerInstance;
  }
  if (options.lastError !== undefined) {
    setValues.lastError = options.lastError;
  }
  if (options.terminalReason) {
    setValues.terminalReason = options.terminalReason;
  }
  if (isAgentRunTerminalStatus(to)) {
    // Domain terminal — clear cooperative cancel latch if still set.
    setValues.cancelRequested = existing.cancelRequested;
  }

  const fromClause = options.expectedFrom
    ? Array.isArray(options.expectedFrom)
      ? options.expectedFrom
      : [options.expectedFrom]
    : [fromStatus];

  const conditions = [
    eq(agentRuns.id, runId),
    sql`${agentRuns.status} IN (${sql.join(fromClause.map((s) => sql`${s}`), sql`, `)})`,
  ];

  if (existing.dispatchMessageId && options.dispatchMessageId) {
    conditions.push(eq(agentRuns.dispatchMessageId, options.dispatchMessageId));
  }

  const updated = await db
    .update(agentRuns)
    .set(setValues)
    .where(and(...conditions))
    .returning();

  if (updated.length === 0) {
    const latest = await loadRun(runId);
    return {
      ok: false,
      conflict: true,
      run: latest,
      reason: 'race_or_illegal',
    };
  }

  const run = mapRow(updated[0]);
  logTransition({
    runId,
    projectId: run.projectId,
    lane: run.lane,
    fromStatus,
    toStatus: to,
    dispatchMessageId: run.dispatchMessageId,
    terminalReason: run.terminalReason,
  });
  return { ok: true, run };
}

/**
 * Synchronous cancel for queued; cooperative flag for dispatched/running (BR-002).
 */
export async function requestCancel(runId: string): Promise<LifecycleResult> {
  const existing = await loadRun(runId);
  if (!existing) {
    return { ok: false, conflict: true, run: null, reason: 'run_not_found' };
  }

  if (isAgentRunTerminalStatus(existing.status)) {
    return { ok: true, run: existing };
  }

  if (existing.status === 'queued') {
    const result = await markTerminal(runId, {
      status: 'cancelled',
      terminalReason: 'forced_cancel',
      detail: 'Cancelled before dispatch',
    });
    if (result.ok && result.run.lane === 'background') {
      emitWorkerTelemetry(() => {
        workerTierTelemetry.cancellation(workerTelemetryContext(result.run));
      });
    }
    return result;
  }

  const nowIso = new Date().toISOString();
  const updated = await db
    .update(agentRuns)
    .set({
      cancelRequested: true,
      cancelState: 'requested',
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(agentRuns.id, runId),
        sql`${agentRuns.status} IN ('dispatched', 'running')`,
      ),
    )
    .returning();

  if (updated.length === 0) {
    const latest = await loadRun(runId);
    return { ok: false, conflict: true, run: latest, reason: 'cancel_race' };
  }

  const run = mapRow(updated[0]);
  logTransition({
    runId,
    projectId: run.projectId,
    lane: run.lane,
    fromStatus: existing.status,
    toStatus: existing.status,
    dispatchMessageId: run.dispatchMessageId,
    terminalReason: null,
  });
  if (run.lane === 'background') {
    emitWorkerTelemetry(() => {
      workerTierTelemetry.cancellation(workerTelemetryContext(run));
    });
  }
  return { ok: true, run };
}

/**
 * Idempotent terminal write; invokes completion handler only on first win (VT-06).
 * The existing finalizer owns the fenced status CAS, durable event persistence,
 * and post-commit fan-out.
 */
export async function markTerminal(
  runId: string,
  input: MarkTerminalInput,
): Promise<LifecycleResult> {
  const existing = await loadRun(runId);
  if (!existing) {
    return { ok: false, conflict: true, run: null, reason: 'run_not_found' };
  }

  if (isAgentRunTerminalStatus(existing.status)) {
    // Idempotent retry — skip completion but retry best-effort cleanup (BR-008).
    if (existing.status === input.status) {
      await bestEffortDeactivateGrounding(
        existing,
        input.deactivateGrounding ?? deactivateTerminalGrounding,
      );
      return { ok: true, run: existing };
    }
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: `already_terminal:${existing.status}`,
    };
  }

  const fromStatus = existing.status as AgentRunStatus;
  if (!isLegalAgentRunTransition(fromStatus, input.status)) {
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: `illegal_transition:${fromStatus}->${input.status}`,
    };
  }

  if (input.terminalReason && !isAgentRunTerminalReason(input.terminalReason)) {
    return {
      ok: false,
      conflict: true,
      run: existing,
      reason: 'invalid_terminal_reason',
    };
  }

  if (existing.dispatchMessageId) {
    if (!input.dispatchMessageId) {
      return { ok: false, conflict: true, run: existing, reason: 'fence_required' };
    }
    if (input.dispatchMessageId !== existing.dispatchMessageId) {
      return { ok: false, conflict: true, run: existing, reason: 'fence_mismatch' };
    }
  }

  const handler = input.completionHandler ?? finalizeReconciledAgentRun;
  const won = await handler({
    runId,
    threadId: existing.threadId,
    status: input.status,
    detail: input.detail ?? input.status,
    events: input.events ?? [],
    dispatchMessageId: input.dispatchMessageId,
    terminalReason: input.terminalReason,
  });

  const latest = await loadRun(runId);
  if (!won) {
    if (latest && latest.status === input.status) {
      return { ok: true, run: latest };
    }
    return {
      ok: false,
      conflict: true,
      run: latest,
      reason: 'terminal_race_or_illegal',
    };
  }
  if (!latest || latest.status !== input.status) {
    return {
      ok: false,
      conflict: true,
      run: latest,
      reason: 'completion_handler_did_not_finalize',
    };
  }

  await bestEffortDeactivateGrounding(
    latest,
    input.deactivateGrounding ?? deactivateTerminalGrounding,
  );

  logTransition({
    runId,
    projectId: latest.projectId,
    lane: latest.lane,
    fromStatus,
    toStatus: input.status,
    dispatchMessageId: latest.dispatchMessageId,
    terminalReason: latest.terminalReason,
  });
  if (latest.lane === 'background') {
    const terminalReason =
      latest.terminalReason ?? input.terminalReason ?? input.status;
    emitWorkerTelemetry(() => {
      workerTierTelemetry.terminalReason(
        workerTelemetryContext(latest),
        terminalReason,
      );
    });
  }

  if (
    latest.lane === 'background'
    && (fromStatus === 'dispatched' || fromStatus === 'running')
  ) {
    await attemptAdmission('slot-release', {
      runId,
      projectId: latest.projectId,
      lane: latest.lane,
    });
  }
  return { ok: true, run: latest };
}

/**
 * Read-only snapshot accessor for tests / callers verifying immutability (AC-d).
 */
export async function getExecutionSnapshot(runId: string): Promise<ExecutionSnapshot | null> {
  const run = await loadRun(runId);
  return run?.executionSnapshot ?? null;
}

export async function getAgentRunLifecycle(runId: string): Promise<AgentRunLifecycleRow | null> {
  return loadRun(runId);
}
