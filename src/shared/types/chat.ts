export type ChatMessageRole = 'user' | 'agent' | 'tool' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  ts: string;
  /** For tool messages: the tool name that was called */
  toolName?: string;
  /** For tool messages: the raw input payload passed to the tool */
  toolInput?: Record<string, unknown>;
  /** User-uploaded context files attached to this message */
  attachments?: ChatAttachmentMeta[];
  /** When true, this message is an internal prompt and should not be shown in the UI */
  hidden?: boolean;
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  content: string;
  /** 'base64' for binary files (images); absent/undefined for plain text */
  encoding?: 'base64';
}

export interface ChatAttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  path?: string;
}

export interface ChatThreadKickoff {
  project: string;
  repo: string;
  branch?: string;
  /** Branch to fetch skills from (defaults to `branch` if not set) */
  skillBranch?: string;
  /** Skill provider — 'ado' (default) or 'github' */
  skillProvider?: import('./projectSettings').SkillProvider;
  /** Optional — omit for a free-chat session with no skill pre-loaded */
  skillPath?: string;
  /** Cursor SDK model ID to use for this thread (e.g. "claude-opus-4-6") */
  model?: string;
  /** Raw transcript text pasted by the user */
  transcript?: string;
  /** Additional freeform context */
  freeformContext?: string;
  /** MCP pill selected on the home page — wires an external MCP server into this thread */
  mcpPill?: import('./projectSettings').QuickMcpPill;
  /** Identifies the type of assistant thread — controls system prompt behavior */
  assistantType?: 'design-doc' | 'prd';
  /** Human-readable label from the QuickSkillPill or QuickMcpPill selected on the home page */
  pillLabel?: string;
  /** Short description from the pill, used as a subtitle in the thread title */
  pillDescription?: string;
  /** When true, the scope guardrail is omitted from the system prompt for this thread */
  pillBypassScopePolicy?: boolean;
  /** Thread mode — controls system prompt behavior */
  mode?: 'development' | 'standup-participant' | 'standup-facilitator' | 'standup-followup';
  /** Work item ID driving the development session */
  workItemId?: number;
  /** True only when server-side package-manager-aware dependency bootstrap completed */
  dependenciesPrepared?: boolean;
  /** Selected project_skill_settings row id — drives repo/branch/config resolution */
  skillSettingsId?: string | null;
  /** Standup session ID (for standup-* modes) */
  standupSessionId?: string;
  /** Standup participant row ID (for standup-participant mode) */
  standupParticipantId?: string;
  /** Resolved standup skill path (for standup-participant mode with custom skill) */
  standupSkillPath?: string;
  /** Display name of the standup participant (for grounding ADO queries by assignee) */
  standupUserDisplayName?: string;
  /** Email/ADO uniqueName of the standup participant (for [System.AssignedTo] filters) */
  standupUserEmail?: string;
}

export type ChatThreadStatus = 'idle' | 'running' | 'error' | 'closed';

export interface ChatThread {
  id: string;
  /** Azure AD user identifier from the session */
  userId: string;
  kickoff: ChatThreadKickoff;
  messages: ChatMessage[];
  status: ChatThreadStatus;
  /** Cursor SDK agentId — used to resume across process restarts */
  cursorAgentId?: string;
  /** Active run ID for the current turn */
  activeRunId?: string;
  /** Path to the temp workspace directory */
  workspaceDir: string;
  /** Latest error message if status === 'error' */
  lastError?: string;
  /** Wiki page URL if the PRD has been saved */
  savedWikiUrl?: string;
  /** True when the user has flagged this thread for follow-up */
  flagged: boolean;
  /** ISO timestamp of when the thread was flagged (undefined when not flagged) */
  flaggedAt?: string;
  /** Computed at request time: true when a durable PRD output file exists for this thread */
  prdReady?: boolean;
  createdAt: string;
  lastActivityAt: string;
}

// ── SSE event shapes sent to the browser ──────────────────────────────────────

export type SseEventType =
  | 'token'       // partial text from the agent
  | 'message'     // complete agent message (role + full text)
  | 'tool_call'   // agent invoked a tool
  | 'thinking'    // model thinking/reasoning text
  | 'phase'       // durable semantic run progress
  | 'health'      // durable watchdog/recovery state (not meaningful progress)
  | 'tool_status' // tool execution progress (running/completed/error)
  | 'status'      // thread status changed
  | 'error'       // run-level error
  | 'retrying'    // server is transparently retrying a transient failure
  | 'done';       // turn completed

export interface SseTokenEvent {
  type: 'token';
  text: string;
}

export interface SseMessageEvent {
  type: 'message';
  message: ChatMessage;
}

export interface SseToolCallEvent {
  type: 'tool_call';
  toolName: string;
  input: unknown;
}

export interface SseStatusEvent {
  type: 'status';
  status: ChatThreadStatus;
}

export type SseErrorCode = 'transient' | 'rate_limit' | 'context_overflow' | 'auth' | 'fatal';

export interface SseErrorEvent {
  type: 'error';
  error: string;
  errorCode?: SseErrorCode;
}

export interface SseRetryingEvent {
  type: 'retrying';
  attempt: number;
  maxAttempts: number;
}

export interface SseDoneEvent {
  type: 'done';
  runId?: string;
  prdReady?: boolean;
  backlogReady?: boolean;
}

export interface SseThinkingEvent {
  type: 'thinking';
  text: string;
  durationMs?: number;
}

export type AgentRunPhase =
  | 'setup'
  | 'planning'
  | 'approval'
  | 'dependencies'
  | 'analysis'
  | 'implementation'
  | 'testing'
  | 'typecheck'
  | 'push'
  | 'completion';

export type AgentRunEventStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SsePhaseEvent {
  type: 'phase';
  phase: AgentRunPhase;
  status: AgentRunEventStatus;
  detail?: string;
  durationMs?: number;
  /** Added by the durable SSE transport when the event is replayable. */
  runId?: string;
  /** Original server timestamp; clients must not replace replay time with Date.now(). */
  eventTimestamp?: string;
}

export type AgentRunHealth =
  | 'healthy'
  | 'progress_stale'
  | 'long_running'
  | 'worker_lost'
  | 'hard_timeout'
  | 'never_claimed';

export interface SseHealthEvent {
  type: 'health';
  health: AgentRunHealth;
  detail: string;
  runId?: string;
  eventTimestamp?: string;
}

export interface SseToolStatusEvent {
  type: 'tool_status';
  toolName: string;
  callId: string;
  status: 'running' | 'completed' | 'error';
  args?: unknown;
  result?: string;
}

export interface SseDurableEventMetadata {
  runId?: string;
  eventTimestamp?: string;
  semanticPhase?: AgentRunPhase;
  semanticStatus?: AgentRunEventStatus;
  semanticDetail?: string;
}

type SseEventPayload =
  | SseTokenEvent
  | SseMessageEvent
  | SseToolCallEvent
  | SseThinkingEvent
  | SsePhaseEvent
  | SseHealthEvent
  | SseToolStatusEvent
  | SseStatusEvent
  | SseErrorEvent
  | SseRetryingEvent
  | SseDoneEvent;

export type SseEvent = SseEventPayload & SseDurableEventMetadata;

// ── Durable run-event transport ───────────────────────────────────────────────

export type AgentRunEventType =
  | 'token'
  | 'message'
  | 'phase'
  | 'health'
  | 'tool'
  | 'status'
  | 'retrying'
  | 'error'
  | 'done'
  | 'cancel';

export interface AgentRunCancelEvent {
  type: 'cancel';
}

/**
 * One immutable event generated by the run owner before local delivery or
 * PostgreSQL fan-out. Event IDs are used as SSE IDs and for reconnect dedupe.
 */
export interface AgentRunEventEnvelope {
  eventId: string;
  threadId: string;
  runId: string;
  sourceInstance: string;
  sequence: number;
  timestamp: string;
  type: AgentRunEventType;
  phase: AgentRunPhase;
  status: AgentRunEventStatus;
  /** Sanitized, user-safe diagnostic. Never raw model thinking or secret values. */
  detail?: string;
  event: SseEvent | AgentRunCancelEvent;
}

export interface AgentRunStatusResponse {
  runId: string | null;
  status: string;
  health: AgentRunHealth;
  lastError: string | null;
  progressAt: string | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
  startedAt: string | null;
  elapsedMs: number;
}

// ── Thread summary (lightweight, no messages) ─────────────────────────────────

export interface ChatThreadSummary {
  id: string;
  userId: string;
  title: string;
  status: ChatThreadStatus;
  kickoff: Pick<ChatThreadKickoff, 'project' | 'repo' | 'skillPath' | 'pillLabel' | 'pillDescription'>;
  /** First user prompt snippet for `{process} - {description}` history labels */
  messagePreview?: string;
  flagged: boolean;
  flaggedAt?: string;
  createdAt: string;
  lastActivityAt: string;
}

/** Owner-visible context for the most recent visible message matching a thread search. */
export interface ChatThreadMatch {
  messageId: string;
  role: Extract<ChatMessageRole, 'user' | 'agent'>;
  snippet: string;
  matchedAt: string;
}

/** A thread summary enriched with either message-match context or a title-only marker. */
export type ChatThreadSearchResult = ChatThreadSummary & (
  | { match: ChatThreadMatch; titleOnly?: false }
  | { match?: undefined; titleOnly: true }
);

// ── REST request/response shapes ──────────────────────────────────────────────

export interface StartChatRequest {
  kickoff: ChatThreadKickoff;
  /**
   * When true, the server does not auto-send the hidden "Begin." message.
   * Use when the client will POST the user's first message immediately so the
   * transcript shows the request before the agent reply.
   */
  skipAutoKickoff?: boolean;
}

export interface StartChatResponse {
  threadId: string;
}

export interface SendMessageRequest {
  text: string;
  /** Optional model override for this turn. If different from the thread's current model,
   *  the agent will be disposed and resumed with the new model. */
  model?: string;
  /** Text file contents uploaded by the user as additional turn context. */
  attachments?: ChatAttachment[];
}
