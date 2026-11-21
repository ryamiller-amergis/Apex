import type {
  AgentRunPhase,
  ChatMessage,
  ChatThreadStatus,
  SseEvent,
} from '../../shared/types/chat';
import type {
  AgentActivityItem,
  AgentActivityToolItem,
  HarnessAgentPhase,
  HarnessAreaId,
  HarnessCommandBody,
  HarnessCommandKind,
  HarnessErrorFrame,
  HarnessReceipt,
  HarnessReceiptFrame,
  HarnessReceiptStatus,
  HarnessStateFrame,
  HarnessSummaryMarker,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../../shared/types/chatHarness';
import type {
  GroundingPreparationProgress,
  RunHealthProgress,
  RunPhaseProgress,
  ToolProgress,
} from '../hooks/useChatStream';

export type {
  AgentActivityItem,
  AgentActivityToolItem,
  HarnessAgentPhase,
  HarnessAreaId,
  HarnessCommandBody,
  HarnessCommandKind,
  HarnessErrorFrame,
  HarnessReceipt,
  HarnessReceiptFrame,
  HarnessReceiptStatus,
  HarnessStateFrame,
  HarnessSummaryMarker,
  HarnessThreadSnapshot,
  HarnessThreadState,
};

export type ConnectionState =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'restored'
  | 'unavailable'
  | 'signed-out'
  | 'closed';

export interface PendingCommand {
  commandId: string;
  kind: HarnessCommandKind;
  status: 'pending' | 'accepted' | 'queued';
  sentAt: number;
}

export interface HarnessReceiptView {
  commandId: string;
  kind: HarnessCommandKind;
  status: HarnessReceiptStatus;
  text: string;
  tone: 'info' | 'warning' | 'error';
  reason?: string;
  autoDismissMs: number | null;
  updatedAt: string;
}

export interface HarnessSummaryNoticeState {
  status: 'running' | 'completed' | 'fallback' | 'error';
  text: string;
  isFallback: boolean;
  error?: string;
}

export interface HarnessMessageFailureState {
  commandId?: string;
  runId: string | null;
  reason: string;
  failedAt: string;
  messageId?: string;
}

export interface HarnessTranscriptItem {
  id: string;
  role: ChatMessage['role'];
  text: string;
  ts: string;
  commandId?: string;
  attachments?: ChatMessage['attachments'];
  hidden?: boolean;
  pending?: boolean;
  failed?: boolean;
  failureReason?: string;
  retryableRunId?: string | null;
  activity?: AgentActivityItem[];
  activityUnavailable?: boolean;
}

export type HarnessTimingMetric =
  | 'send_to_first_feedback'
  | 'send_to_first_token'
  | 'longest_silent_gap'
  | 'stop_ui_halt'
  | 'stop_confirmed'
  | 'steer_acknowledged'
  | 'reconnect_restored'
  | 'reload_restored';

export interface HarnessTimingRecord {
  area: string;
  threadId: string;
  runId?: string;
  commandId?: string;
  metric: HarnessTimingMetric;
  durationMs: number;
  status: string;
  recordedAt: number;
}

export interface GatewayEventFrame {
  type: 'event';
  id: string;
  data: SseEvent;
}

export type GatewayInboundFrame =
  | GatewayEventFrame
  | HarnessReceiptFrame
  | HarnessStateFrame
  | HarnessErrorFrame
  | { type: string; [key: string]: unknown };

export interface OptimisticMessageEntry {
  commandId: string;
  message: ChatMessage;
  failed: boolean;
  failureReason?: string;
}

export interface RuntimeState {
  threadId: string | null;
  harnessArea: HarnessAreaId | null;
  /** True once initial snapshot attempt has settled (success or error). */
  snapshotLoaded: boolean;
  snapshotError: string | null;
  snapshotStatusCode: number | null;
  /** True when the server snapshot or state frame grants write access (defaults true until server says false). */
  canWrite: boolean;
  connectionState: ConnectionState;
  isConnected: boolean;
  hasConnectionError: boolean;
  lastEventId: string | null;

  // Thread state owned by server
  status: ChatThreadStatus;
  activeRunId: string | null;
  phase: HarnessAgentPhase;
  latestSummary: HarnessSummaryMarker | null;
  summaryNotice: HarnessSummaryNoticeState | null;

  // Transcript & live stream
  messages: ChatMessage[];
  optimisticMessages: OptimisticMessageEntry[];
  streamingText: string;
  thinkingText: string;
  toolProgress: ToolProgress[];
  activity: AgentActivityItem[];
  phaseEvents: RunPhaseProgress[];
  runHealth: RunHealthProgress | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
  lastProgressAt: number | null;
  prdReady: boolean;
  backlogReady: boolean;
  isRetrying: boolean;
  retryReason: string | null;
  retryableRunId: string | null;
  groundingPreparation: GroundingPreparationProgress | null;

  // Command & UI lifecycle
  pendingCommands: PendingCommand[];
  lastReceipt: HarnessReceiptView | null;
  stopping: boolean;
  lastFailure: HarnessMessageFailureState | null;
  /** Incremented whenever a run reaches a terminal state (used by Brainstorm to invalidate queries once). */
  terminalRevision: number;
}

export interface HarnessReceiptRaw {
  commandId: string;
  kind: HarnessCommandKind;
  status: HarnessReceiptStatus;
  reason?: string;
  runId?: string;
  updatedAt?: string;
}

const REASON_ALIAS_MAP: Readonly<Record<string, string>> = {
  steer_cap: 'Wait for this step to finish',
  turn_ended: 'Turn had finished, sent as a new message',
  queued_behind_turn: 'Queued as follow-up',
  no_write_access: 'You have read-only access to this thread.',
  'You have read-only access to this chat': 'You have read-only access to this thread.',
  summarizing: 'Steer received',
  turn_running: 'Wait for this reply to finish',
  not_delivered: 'Did not reach the agent',
  stop_unconfirmed: 'Stop did not reach the agent',
  turn_already_finished: 'Turn had already finished',
  command_id_reused: 'Command id already used',
  sign_in_required: 'Your session expired. Sign in again to continue.',
  'Sign in again to continue': 'Your session expired. Sign in again to continue.',
};

export function isSignInRequiredReason(reason: string | undefined): boolean {
  return (
    reason === 'sign_in_required' ||
    reason === 'Sign in again to continue'
  );
}

export function normalizeReceiptReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return REASON_ALIAS_MAP[reason] ?? reason;
}

export function formatHarnessReceipt(receipt: HarnessReceiptRaw): HarnessReceiptView {
  const updatedAt = receipt.updatedAt ?? new Date().toISOString();
  const normalizedReason = normalizeReceiptReason(receipt.reason);

  if (receipt.status === 'rejected') {
    return {
      commandId: receipt.commandId,
      kind: receipt.kind,
      status: receipt.status,
      text: normalizedReason ?? 'Command could not be completed.',
      tone: 'error',
      reason: receipt.reason,
      autoDismissMs: null,
      updatedAt,
    };
  }

  if (receipt.status === 'queued') {
    const text = normalizedReason ?? 'Queued as follow-up';
    return {
      commandId: receipt.commandId,
      kind: receipt.kind,
      status: receipt.status,
      text,
      tone: 'info',
      reason: receipt.reason,
      autoDismissMs: 5_000,
      updatedAt,
    };
  }

  if (receipt.status === 'accepted') {
    if (receipt.kind === 'steer') {
      return {
        commandId: receipt.commandId,
        kind: receipt.kind,
        status: receipt.status,
        text: 'Steer received',
        tone: 'info',
        reason: receipt.reason,
        autoDismissMs: null,
        updatedAt,
      };
    }
    return {
      commandId: receipt.commandId,
      kind: receipt.kind,
      status: receipt.status,
      text: normalizedReason ?? '',
      tone: 'info',
      reason: receipt.reason,
      autoDismissMs: 5_000,
      updatedAt,
    };
  }

  // status === 'applied'
  if (receipt.kind === 'steer') {
    return {
      commandId: receipt.commandId,
      kind: receipt.kind,
      status: receipt.status,
      text: 'Steer sent',
      tone: 'info',
      reason: receipt.reason,
      autoDismissMs: 5_000,
      updatedAt,
    };
  }

  return {
    commandId: receipt.commandId,
    kind: receipt.kind,
    status: receipt.status,
    text: normalizedReason ?? '',
    tone: 'info',
    reason: receipt.reason,
    autoDismissMs: 5_000,
    updatedAt,
  };
}
