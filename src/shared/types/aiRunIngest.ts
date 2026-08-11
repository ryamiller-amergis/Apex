import type {
  AgentRunEventStatus,
  AgentRunPhase,
  SseEvent,
} from './chat';
import type {
  AgentRunCancelState,
  AgentRunLane,
  AgentRunStatus,
  AgentRunTerminalReason,
  ExecutionSnapshot,
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
  executionSnapshot: ExecutionSnapshot;
  cancelRequested: boolean;
  cancelState: AgentRunCancelState | null;
  terminalReason: AgentRunTerminalReason | null;
  timeoutAt: string | null;
  ownerInstance: string | null;
  updatedAt: string;
}>;

export type AiRunBootstrapResponse = Readonly<{
  projectId: string;
  run: AiRunBootstrapRun;
  /** Thread-persisted Cursor agent id for interactive resume after actor restart. */
  cursorAgentId?: string | null;
}>;

export type AiRunIngestResponse = Readonly<{
  ok: boolean;
  cancelRequested: boolean;
}>;

export function isAiRunIngestKind(value: unknown): value is AiRunIngestKind {
  return typeof value === 'string'
    && (AI_RUN_INGEST_KINDS as readonly string[]).includes(value);
}

export function isAiRunTerminalIngestStatus(
  value: unknown,
): value is AiRunTerminalIngestStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}
