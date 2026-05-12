export type ChatMessageRole = 'user' | 'agent' | 'tool' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  ts: string;
  /** For tool messages: the tool name that was called */
  toolName?: string;
  /** User-uploaded context files attached to this message */
  attachments?: ChatAttachmentMeta[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  content: string;
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
  /** Optional — omit for a free-chat session with no skill pre-loaded */
  skillPath?: string;
  /** Cursor SDK model ID to use for this thread (e.g. "claude-opus-4-6") */
  model?: string;
  /** Raw transcript text pasted by the user */
  transcript?: string;
  /** Additional freeform context */
  freeformContext?: string;
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
  createdAt: string;
  lastActivityAt: string;
}

// ── SSE event shapes sent to the browser ──────────────────────────────────────

export type SseEventType =
  | 'token'       // partial text from the agent
  | 'message'     // complete agent message (role + full text)
  | 'tool_call'   // agent invoked a tool
  | 'status'      // thread status changed
  | 'error'       // run-level error
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

export interface SseErrorEvent {
  type: 'error';
  error: string;
}

export interface SseDoneEvent {
  type: 'done';
  runId?: string;
  prdReady?: boolean;
  backlogReady?: boolean;
}

export type SseEvent =
  | SseTokenEvent
  | SseMessageEvent
  | SseToolCallEvent
  | SseStatusEvent
  | SseErrorEvent
  | SseDoneEvent;

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
