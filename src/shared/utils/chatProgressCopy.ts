import type { AgentRunPhase } from '../types/chat';

type RepoReadTool = 'get_skill_file' | 'list_repo_dir' | 'search_repo_code';

const REPO_READ_RUNNING: Record<RepoReadTool, string> = {
  get_skill_file: 'Reading…',
  list_repo_dir: 'Listing…',
  search_repo_code: 'Searching…',
};

const RAW_TO_FRIENDLY: Record<string, string> = {
  'Queued — waiting for available worker': 'Waiting…',
  'Starting…': 'Starting…',
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
      return 'Waiting…';
    case 'dispatched':
      return 'Starting…';
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
 */
export function friendlyChatProgressLabel(
  raw?: string | null,
  phase?: AgentRunPhase | null,
): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (text && ALREADY_FRIENDLY.has(text)) return text;

  const tool = text ? matchRepoReadTool(text) : null;
  if (tool) return REPO_READ_RUNNING[tool];
  if (text && RAW_TO_FRIENDLY[text]) return RAW_TO_FRIENDLY[text];
  if (text.toLowerCase().startsWith('retrying')) return 'Retrying…';
  if (text) return text;
  if (phase) return copyForPhase(phase);
  return 'Thinking…';
}
