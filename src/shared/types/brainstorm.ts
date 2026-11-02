// ── Brainstorm — shared types ─────────────────────────────────────────────────

/** Feature flag that gates every Brainstorm route and the Build menu item. */
export const BRAINSTORM_FLAG = 'brainstorm' as const;

export const BRAINSTORM_VIEW = 'brainstorm:view' as const;
export const BRAINSTORM_CREATE = 'brainstorm:create' as const;

/** Repository-relative path of the built-in Brainstorm skill. */
export const BRAINSTORM_SKILL_PATH = '.cursor/skills/brainstorm/SKILL.md' as const;
export const BRAINSTORM_SKILL_NAME = 'Brainstorm' as const;

export const BRAINSTORM_TITLE_MAX_LENGTH = 80;
export const BRAINSTORM_MESSAGE_MAX_LENGTH = 20_000;
export const BRAINSTORM_BIO_MAX_LENGTH = 1_000;

export const BRAINSTORM_SESSION_STATES = ['active', 'ended', 'failed'] as const;
export type BrainstormSessionState = (typeof BRAINSTORM_SESSION_STATES)[number];

export const BRAINSTORM_MESSAGE_ROLES = ['user', 'assistant'] as const;
export type BrainstormMessageRole = (typeof BRAINSTORM_MESSAGE_ROLES)[number];

export const BRAINSTORM_MESSAGE_STATUSES = ['streaming', 'completed', 'failed', 'cancelled'] as const;
export type BrainstormMessageStatus = (typeof BRAINSTORM_MESSAGE_STATUSES)[number];

export const BRAINSTORM_FAILURE_CODES = [
  'run_not_started',
  'model_error',
  'deadline_exceeded',
  'worker_refused_spec',
  'cancelled',
  'unknown',
] as const;
export type BrainstormFailureCode = (typeof BRAINSTORM_FAILURE_CODES)[number];

/** Error codes returned in the `error` field of Brainstorm route responses. */
export const BRAINSTORM_ERROR_CODES = [
  'not_creator',
  'session_not_active',
  'turn_in_progress',
  'transport_unavailable',
  'not_retryable',
] as const;
export type BrainstormErrorCode = (typeof BRAINSTORM_ERROR_CODES)[number];

/** Creator-facing summaries for each failure code. Never contains model or worker text. */
export const BRAINSTORM_FAILURE_SUMMARIES: Readonly<Record<BrainstormFailureCode, string>> = {
  run_not_started: 'The response could not start. Try again.',
  model_error: 'The model returned an error before finishing.',
  deadline_exceeded: 'The response took too long and was stopped.',
  worker_refused_spec: 'The request was refused before it ran.',
  cancelled: 'The response was stopped.',
  unknown: 'Something went wrong while generating the response.',
};

export interface BrainstormSessionSummary {
  id: string;
  title: string | null;
  creatorId: string;
  creatorName: string | null;
  state: BrainstormSessionState;
  model: string;
  artifactType: string | null;
  lastActivityAt: string;
  createdAt: string;
  canMutate: boolean;
  canDelete?: boolean;
  isCreator?: boolean;
}

export interface BrainstormSessionDetail extends BrainstormSessionSummary {
  threadId: string;
  version: number;
  failureReason: string | null;
}

export interface BrainstormSessionListResponse {
  sessions: BrainstormSessionSummary[];
  total: number;
}

export interface BrainstormActivityItem {
  id: string;
  kind: 'thinking' | 'tool';
  text?: string;
  toolName?: string;
  status?: 'running' | 'completed' | 'error';
  target?: string | null;
  result?: string;
}

export interface BrainstormMessageDto {
  id: string;
  role: BrainstormMessageRole;
  content: string;
  status: BrainstormMessageStatus;
  runId: string | null;
  turnId: string;
  failureCode: BrainstormFailureCode | null;
  failureSummary: string | null;
  retryOfMessageId: string | null;
  supersededByMessageId: string | null;
  createdAt: string;
  completedAt: string | null;
  activity?: BrainstormActivityItem[];
}

export interface BrainstormTurnAcceptedResponse {
  turnId: string;
  runId: string;
  status: string;
  interactiveClass: string;
  messageId: string;
}
