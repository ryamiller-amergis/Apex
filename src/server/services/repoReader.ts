import type { RepoReader } from '../../shared/types/repoReader';

export const DEFAULT_REPO_SEARCH_LIMIT = 10;
export const MAX_REPO_SEARCH_LIMIT = 30;
export const MAX_REPO_DIRECTORY_ENTRIES = 1_000;

export type RepoReaderErrorCode =
  | 'ACCESS_DENIED'
  | 'LOCAL_READ_UNAVAILABLE'
  | 'PROFILE_UNAVAILABLE'
  | 'REMOTE_SEARCH_DISABLED'
  | 'SEARCH_TIMEOUT';

export class RepoReaderError extends Error {
  constructor(
    readonly code: RepoReaderErrorCode,
    message: string,
    readonly fallbackEligible: boolean
  ) {
    super(message);
    this.name = 'RepoReaderError';
  }
}

export function boundedSearchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_REPO_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.floor(limit), 1), MAX_REPO_SEARCH_LIMIT);
}

let searchQueue: Promise<void> = Promise.resolve();

/**
 * Serializes `git grep` executions within a process so parallel `search_repo_code`
 * tool calls from an AI model cannot spawn multiple concurrent multi-threaded
 * packfile inflations and exceed the container memory limit.
 */
export function runSerializedSearch<T>(work: () => Promise<T>): Promise<T> {
  const next = searchQueue.then(work, work);
  searchQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const SEARCH_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'how',
  'what',
  'where',
  'when',
  'core',
  'module',
  'system',
  'integration',
  'base',
  'code',
  'codebase',
]);

const KNOWN_REPO_NAMES = new Set([
  'amego',
  'matterworx',
  'maxview',
  'apex',
]);

/**
 * Builds `git grep` pattern flags. Single terms or code expressions stay exact
 * literal (`-F -e <query>`), while multi-word natural-language keyword lists
 * (3+ space-separated words without code punctuation, e.g.
 * `"ATS applicant tracking core module"`) match any of the key terms (`-i -F -e ...`)
 * instead of requiring an entire English sentence to appear on one line.
 */
export function buildGitGrepPatternArgs(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return ['-F', '-e', ''];
  if (/[(){}[\];=.<>/\\'"`:]/.test(trimmed)) {
    return ['-F', '-e', trimmed];
  }
  const rawWords = trimmed.split(/\s+/).filter(Boolean);
  if (rawWords.length < 3) {
    return ['-F', '-e', trimmed];
  }
  const filtered = rawWords.filter((word) => {
    const lower = word.toLowerCase();
    return lower.length >= 3 && !SEARCH_STOP_WORDS.has(lower);
  });
  const withoutRepoNames = filtered.filter(
    (word) => !KNOWN_REPO_NAMES.has(word.toLowerCase()),
  );
  const terms = [
    ...new Set(
      (withoutRepoNames.length > 0 ? withoutRepoNames : filtered.length > 0 ? filtered : rawWords)
        .slice(0, 4),
    ),
  ];
  if (terms.length <= 1) {
    return ['-i', '-F', '-e', terms[0] ?? trimmed];
  }
  const args: string[] = ['-i', '-F'];
  for (const term of terms) {
    args.push('-e', term);
  }
  return args;
}

export interface RepoReaderFactories {
  local(): RepoReader;
  remote(): RepoReader;
  bare(): RepoReader;
}

/**
 * Central construction point used by the resolver's top-level feature split.
 * The resolver deliberately chooses the mode only after authorization.
 */
export function createRepoReader(
  mode: 'local' | 'remote' | 'bare',
  factories: RepoReaderFactories
): RepoReader {
  switch (mode) {
    case 'local':
      return factories.local();
    case 'remote':
      return factories.remote();
    case 'bare':
      return factories.bare();
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
