import type { RepoReader } from '../../shared/types/repoReader';

export const DEFAULT_REPO_SEARCH_LIMIT = 10;
export const MAX_REPO_SEARCH_LIMIT = 30;
export const MAX_REPO_DIRECTORY_ENTRIES = 1_000;

export type RepoReaderErrorCode =
  | 'ACCESS_DENIED'
  | 'LOCAL_READ_UNAVAILABLE'
  | 'PROFILE_UNAVAILABLE'
  | 'REMOTE_SEARCH_DISABLED';

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

export interface RepoReaderFactories {
  local(): RepoReader;
  remote(): RepoReader;
}

/**
 * Central construction point used by the resolver's top-level feature split.
 * The resolver deliberately chooses the mode only after authorization.
 */
export function createRepoReader(
  mode: 'local' | 'remote',
  factories: RepoReaderFactories
): RepoReader {
  return mode === 'local' ? factories.local() : factories.remote();
}
