import type { AgentRunPhase } from '../types/chat';

type RepoReadTool = 'get_skill_file' | 'list_repo_dir' | 'search_repo_code';

const REPO_READ_RUNNING: Record<RepoReadTool, string> = {
  get_skill_file: 'Reading…',
  list_repo_dir: 'Listing…',
  search_repo_code: 'Searching…',
};

const RAW_TO_FRIENDLY: Record<string, string> = {
  'Queued — waiting for available worker': 'Queued',
  Queued: 'Queued',
  'Starting…': 'Dispatched',
  Dispatched: 'Dispatched',
  'Preparing project repository…': 'Loading…',
  'Preparing the latest repository requirements…': 'Pinning…',
  'Refreshing the repository mirror…': 'Loading…',
  'Agent run started': 'Thinking…',
  'Analysis completed': 'Thinking…',
  'Getting the latest repository requirements so your interview starts with current context…':
    'Pinning…',
};

const ALREADY_FRIENDLY = new Set<string>([
  ...Object.values(REPO_READ_RUNNING),
  ...Object.values(RAW_TO_FRIENDLY),
  'Retrying…',
  'Planning…',
  'Checking…',
  'Thinking…',
]);

function matchRepoReadTool(label: string): RepoReadTool | null {
  const lower = label.toLowerCase();
  if (lower.includes('get_skill_file')) return 'get_skill_file';
  if (lower.includes('list_repo_dir')) return 'list_repo_dir';
  if (lower.includes('search_repo_code')) return 'search_repo_code';
  return null;
}

function copyForPhase(phase: AgentRunPhase): string {
  switch (phase) {
    case 'queued':
      return 'Queued';
    case 'dispatched':
      return 'Dispatched';
    case 'setup':
    case 'dependencies':
      return 'Loading…';
    case 'planning':
      return 'Planning…';
    case 'approval':
      return 'Checking…';
    case 'analysis':
      return 'Thinking…';
    case 'implementation':
    case 'testing':
    case 'typecheck':
    case 'push':
    case 'completion':
      return 'Checking…';
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/**
 * User-facing loading copy for the bare-mirror / repo-read / actor path.
 * Stored progress labels stay machine-readable for the reaper; this is display only.
 * Durable interactive turns show exactly "Queued" then "Dispatched" — never a
 * numeric position or wait estimate.
 */
export function friendlyChatProgressLabel(
  raw?: string | null,
  phase?: AgentRunPhase | null,
): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (phase === 'queued') return 'Queued';
  if (phase === 'dispatched') return 'Dispatched';
  if (text && ALREADY_FRIENDLY.has(text)) return text;

  const tool = text ? matchRepoReadTool(text) : null;
  if (tool) return REPO_READ_RUNNING[tool];
  if (text && RAW_TO_FRIENDLY[text]) return RAW_TO_FRIENDLY[text];
  if (text.toLowerCase().startsWith('retrying')) return 'Retrying…';
  if (text) return text;
  if (phase) return copyForPhase(phase);
  return 'Thinking…';
}

const TOOL_ACTIVITY: Record<string, string> = {
  grep: 'Searching the codebase',
  search_repo_code: 'Searching the codebase',
  codebase_search: 'Searching the codebase',
  semantic_search: 'Searching the codebase',
  glob: 'Browsing folders',
  ls: 'Browsing folders',
  list_dir: 'Browsing folders',
  list_repo_dir: 'Browsing folders',
  read: 'Reading files',
  read_file: 'Reading files',
  get_skill_file: 'Reading files',
  shell: 'Running a command',
  edit: 'Editing files',
  write: 'Editing files',
  delete: 'Editing files',
  task: 'Working on a subtask',
  web_search: 'Searching the web',
  web_fetch: 'Reading a web page',
};

/**
 * Chat copy for the tool an agent is running. Tool arguments arrive redacted to
 * their keys, so the label names the kind of work, not the file or query. MCP
 * calls carry the underlying tool name in `args.toolName`.
 */
export function friendlyToolActivityLabel(toolName: string, args?: unknown): string {
  const name = toolName.trim().toLowerCase();
  if (name === 'mcp') {
    const inner =
      args && typeof args === 'object'
        ? (args as { toolName?: unknown }).toolName
        : undefined;
    const innerLabel =
      typeof inner === 'string' ? TOOL_ACTIVITY[inner.trim().toLowerCase()] : undefined;
    return innerLabel ?? 'Using a connected tool';
  }
  return TOOL_ACTIVITY[name] ?? 'Working…';
}

const CHAT_ERROR_BY_CODE: Record<string, string> = {
  INTERACTIVE_V2_GROUNDING_UNAVAILABLE:
    "Apex couldn't load this project's repository for the chat. Try again in a minute.",
  INTERACTIVE_V2_SKILL_UNAVAILABLE:
    "This skill couldn't be loaded from the project's repository. Check the skill in Project Settings, or try again.",
  INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED:
    "This tool connection runs locally and isn't supported in chat. Choose a different tool.",
  INTERACTIVE_V2_MAXVIEW_UNAVAILABLE:
    "MaxView tools aren't available right now. Try again later.",
  THREAD_ACTIVE_TURN:
    'A reply is already in progress in this chat. Wait for it to finish or stop it first.',
  TURN_ID_CONFLICT: 'That message was already sent. Refresh the page and try again.',
  INVALID_TURN_ID: 'That message was already sent. Refresh the page and try again.',
};

const DEADLINE_ERRORS: Record<string, string> = {
  'Interactive absolute deadline exceeded':
    'The answer took too long and was stopped. Try a narrower question, or retry.',
  'Interactive turn exceeded its absolute deadline':
    'The answer took too long and was stopped. Try a narrower question, or retry.',
  'Interactive tool deadline exceeded':
    "One of the agent's steps took too long and was stopped. Please retry.",
};

/**
 * User-facing copy for a refused send or a failed turn. Server codes and raw
 * turn failures become plain guidance; anything already readable passes
 * through. The raw detail stays in server logs and the thread's last error.
 */
export function friendlyChatErrorMessage(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return 'Something went wrong. Please retry.';
  const limit = friendlyDurableInteractiveLimitError(text);
  if (limit) return limit;
  if (CHAT_ERROR_BY_CODE[text]) return CHAT_ERROR_BY_CODE[text];
  if (text === 'Agent is already running') return CHAT_ERROR_BY_CODE.THREAD_ACTIVE_TURN;
  if (DEADLINE_ERRORS[text]) return DEADLINE_ERRORS[text];
  if (/model[^a-z]*blocked|model is not allowed/i.test(text)) {
    return "The selected model isn't allowed for your team. Pick a different model and retry.";
  }
  if (text.startsWith('Interactive turn failed:')) {
    return 'Something went wrong while answering. Please retry.';
  }
  return text;
}

/** Exact client copy for durable per-user cap errors (stable API codes). */
export function friendlyDurableInteractiveLimitError(
  code: string | null | undefined,
): string | null {
  switch (code) {
    case 'USER_INTERACTIVE_LIMIT':
      return 'You already have two active AI turns. Finish or stop one before starting another.';
    case 'USER_AGENTIC_LIMIT':
      return 'You already have an agentic AI turn running. Finish or stop it before starting another.';
    default:
      return null;
  }
}
