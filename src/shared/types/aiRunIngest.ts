import type {
  AgentRunEventStatus,
  AgentRunPhase,
  SseEvent,
} from './chat';
import type {
  HarnessPendingControl,
  HarnessRecreateReason,
} from './chatHarness';
import type {
  AgentRunCancelState,
  AgentRunExecutionSnapshot,
  AgentRunLane,
  AgentRunStatus,
  AgentRunTerminalReason,
} from './agentRunLifecycle';

export const AI_RUN_INGEST_KINDS = [
  'heartbeat',
  'progress',
  'cancel_ack',
  'terminal',
  'summary',
] as const;

export type AiRunIngestKind = (typeof AI_RUN_INGEST_KINDS)[number];
export type AiRunTerminalIngestStatus = Extract<
  AgentRunStatus,
  'completed' | 'failed' | 'cancelled'
>;

type AiRunIngestBase = {
  dispatchMessageId: string;
  /**
   * Attempt id for dapr-actor-v2 fenced ingest. Required when the run uses
   * attempt-scoped dispatch; omitted for legacy background workers.
   */
  attemptId?: string;
  detail?: string;
};

export type AiRunHeartbeatIngest = AiRunIngestBase & {
  kind: 'heartbeat';
};

export type AiRunProgressIngest = AiRunIngestBase & {
  kind: 'progress';
  phase?: AgentRunPhase;
  status?: AgentRunEventStatus;
  event?: SseEvent;
  /**
   * Optional caller-supplied durable event id. When live Redis fan-out and
   * Postgres share a chunk boundary, both sides must use the same id so
   * reconnect dedupe works. Inserts use ON CONFLICT DO NOTHING.
   */
  eventId?: string;
};

export type AiRunCancelAckIngest = AiRunIngestBase & {
  kind: 'cancel_ack';
};

export type AiRunSummaryIngestStatus = 'running' | 'completed' | 'error' | 'fallback';

export type AiRunSummaryIngest = AiRunIngestBase & {
  kind: 'summary';
  status: AiRunSummaryIngestStatus;
  text?: string;
  commandId?: string;
  coversThroughOrdinal?: number;
};

/**
 * S6 owns enforcing artifact durability before unchanged completion. S3/S4
 * establish and safely parse the flag without claiming that final ordering.
 */
export type AiRunTerminalIngest = AiRunIngestBase & {
  kind: 'terminal';
  status: AiRunTerminalIngestStatus;
  phase?: AgentRunPhase;
  terminalReason?: AgentRunTerminalReason;
  artifactsFlushed?: boolean;
  event?: SseEvent;
  /**
   * Cursor SDK agent id to persist on the chat thread for restart recovery.
   * Only applied on successful `completed` terminals for the interactive lane.
   */
  cursorAgentId?: string | null;
  /** Clears `chat_threads.cursor_agent_id` through fenced ingest after a stalled resume. */
  clearCursorAgentId?: boolean;
  /** Reason a recreated interactive turn could not resume its prior agent. */
  recreateReason?: HarnessRecreateReason;
  /**
   * Optional actor-uploaded artifact manifest ref. Verified/applied before
   * terminal success for dapr-actor-v2.
   */
  artifactManifestRef?: import('./aiRunV2').AiRunBlobRef | null;
  /**
   * V2 attempt failure category (hard_timeout / tool_timeout / …). Applied on
   * failed dapr-actor-v2 terminals.
   */
  failureCategory?: import('./aiRunV2').AiRunV2FailureCategory;
  /** Wall-clock duration of the worker execution, when known. */
  durationMs?: number;
  /** Interactive worker stage durations. Telemetry only; never rejects a terminal. */
  stageTimings?: InteractiveTurnStageTimings;
  /** Runtime-reported token counts. Omitted when the runtime reported none. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/**
 * Durations in milliseconds, each measured on the worker's own clock so no
 * cross-machine timestamp comparison is needed.
 */
export type InteractiveTurnStageTimings = Readonly<{
  workspaceMs?: number;
  agentAcquireMs?: number;
  agentMode?: 'warm' | 'resumed' | 'recreated';
  recreateReason?: HarnessRecreateReason;
  /** From `send` to the first SDK delta or stream event. */
  firstEventMs?: number;
  /** From `send` to the first assistant text token. */
  firstTokenMs?: number;
  workerTurnMs?: number;
}>;

export type AiRunIngestBody =
  | AiRunHeartbeatIngest
  | AiRunProgressIngest
  | AiRunCancelAckIngest
  | AiRunTerminalIngest
  | AiRunSummaryIngest;

export type AiRunIngestErrorCode =
  | 'AI_RUN_VALIDATION'
  | 'AI_RUN_NOT_FOUND'
  | 'AI_RUN_DISPATCH_MISMATCH'
  | 'AI_RUN_ARTIFACTS_NOT_FLUSHED'
  | 'AI_RUN_ILLEGAL_TRANSITION';

/**
 * Project-confidential worker bootstrap returned only after runner auth and
 * exact dispatch fencing. This data never travels on Service Bus.
 */
export type AiRunBootstrapRun = Readonly<{
  id: string;
  threadId: string;
  status: string;
  projectId: string | null;
  lane: AgentRunLane | null;
  queuedAt: string | null;
  dispatchedAt: string | null;
  dispatchMessageId: string | null;
  executionSnapshot: AgentRunExecutionSnapshot;
  cancelRequested: boolean;
  cancelState: AgentRunCancelState | null;
  terminalReason: AgentRunTerminalReason | null;
  timeoutAt: string | null;
  ownerInstance: string | null;
  updatedAt: string;
}>;

export type AiRunBootstrapResponse = Readonly<{
  kind?: 'legacy';
  projectId: string;
  run: AiRunBootstrapRun;
  /** Thread-persisted Cursor agent id for interactive resume after actor restart. */
  cursorAgentId?: string | null;
}>;

/**
 * Clamped sub-deadlines returned only from App Service bootstrap. The actor
 * never resolves or replaces these values.
 */
export type EffectiveInteractiveDeadlines = Readonly<{
  repositoryPreparationMs: number | null;
  firstEventMs: number;
  toolCallMs: number;
}>;

/**
 * Project-confidential interactive actor bootstrap. Selected by run id + exact
 * dispatch fence from `ai_run_attempts.spec_snapshot` (never a newer attempt).
 */
export type InteractiveActorBootstrap = Readonly<{
  kind: 'interactive-actor-v2';
  specification: import('./durableInteractiveTurn').DurableInteractiveTurnSpecification;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  attemptStatus: import('./aiRunV2').AiRunV2AttemptStatus;
  dispatchMessageId: string;
  absoluteDeadlineAt: string;
  effectiveDeadlines: EffectiveInteractiveDeadlines;
  cursorAgentId: string | null;
  mcpServers: Readonly<
    Record<string, Readonly<{ url: string; headers?: Readonly<Record<string, string>> }>>
  >;
  projectId: string;
  /** Explicit Cursor execution fields resolved on App Service (optional only for legacy test fixtures). */
  requestId?: string;
  toolAllowlist?: readonly string[] | null;
  disallowedTools?: readonly string[];
  settingSources?: readonly string[];
  sandbox?: Readonly<{ enabled: boolean; omitSandbox?: boolean }>;
}>;

export type AiRunBootstrapResult =
  | AiRunBootstrapResponse
  | InteractiveActorBootstrap;

export type AiRunIngestResponse = Readonly<{
  ok: boolean;
  cancelRequested: boolean;
  /** Slow-path pending control commands when a Redis control message was missed. */
  pendingControl?: ReadonlyArray<HarnessPendingControl>;
}>;

export function isInteractiveActorBootstrap(
  value: unknown,
): value is InteractiveActorBootstrap {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'interactive-actor-v2') return false;
  if (
    candidate.requestId !== undefined
    && (typeof candidate.requestId !== 'string' || candidate.requestId.trim().length === 0)
  ) {
    return false;
  }
  if (
    candidate.toolAllowlist !== undefined
    && candidate.toolAllowlist !== null
    && !(
      Array.isArray(candidate.toolAllowlist)
      && candidate.toolAllowlist.every((entry) => typeof entry === 'string')
    )
  ) {
    return false;
  }
  if (
    candidate.disallowedTools !== undefined
    && (
      !Array.isArray(candidate.disallowedTools)
      || !candidate.disallowedTools.every((entry) => typeof entry === 'string')
    )
  ) {
    return false;
  }
  if (
    candidate.settingSources !== undefined
    && (
      !Array.isArray(candidate.settingSources)
      || !candidate.settingSources.every((entry) => typeof entry === 'string')
    )
  ) {
    return false;
  }
  if (candidate.sandbox !== undefined) {
    if (!candidate.sandbox || typeof candidate.sandbox !== 'object') return false;
    const sandbox = candidate.sandbox as Record<string, unknown>;
    if (typeof sandbox.enabled !== 'boolean') return false;
    if (sandbox.omitSandbox !== undefined && typeof sandbox.omitSandbox !== 'boolean') {
      return false;
    }
  }
  return true;
}

export function isAiRunIngestKind(value: unknown): value is AiRunIngestKind {
  return typeof value === 'string'
    && (AI_RUN_INGEST_KINDS as readonly string[]).includes(value);
}

export function isAiRunTerminalIngestStatus(
  value: unknown,
): value is AiRunTerminalIngestStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}
