import type {
  AgentRunEventStatus,
  AgentRunPhase,
  SseEvent,
} from './chat';
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
  /** Runtime-reported token counts. Omitted when the runtime reported none. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type AiRunIngestBody =
  | AiRunHeartbeatIngest
  | AiRunProgressIngest
  | AiRunCancelAckIngest
  | AiRunTerminalIngest;

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
}>;

export type AiRunBootstrapResult =
  | AiRunBootstrapResponse
  | InteractiveActorBootstrap;

export type AiRunIngestResponse = Readonly<{
  ok: boolean;
  cancelRequested: boolean;
}>;

export function isInteractiveActorBootstrap(
  value: unknown,
): value is InteractiveActorBootstrap {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as InteractiveActorBootstrap).kind === 'interactive-actor-v2'
  );
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
