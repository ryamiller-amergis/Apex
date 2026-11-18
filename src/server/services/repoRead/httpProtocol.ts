import type { SkillProvider } from '../../../shared/types/projectSettings';
import type {
  RepoDirEntry,
  RepoSearchResult,
} from '../../../shared/types/repoReader';
import type { RepoReaderErrorCode } from '../repoReader';

export const REPO_READ_SERVICE_URL_ENV = 'REPO_READ_SERVICE_URL';
export const REPO_READ_SERVICE_TOKEN_ENV = 'REPO_READ_SERVICE_TOKEN';

const SHA_RE = /^[0-9a-f]{40}$/i;

export type RepoReadOperation = 'read' | 'list' | 'search';

export interface RepoReadHttpRequest {
  provider: SkillProvider;
  project: string;
  repo: string;
  sha: string;
  path?: string;
  query?: string;
  limit?: number;
}

export type RepoReadHttpSuccess =
  | { ok: true; operation: 'read'; content: string }
  | { ok: true; operation: 'list'; entries: RepoDirEntry[] }
  | { ok: true; operation: 'search'; results: RepoSearchResult[] };

export interface RepoReadHttpFailure {
  ok: false;
  code: RepoReaderErrorCode;
  message: string;
  fallbackEligible: boolean;
}

export type RepoReadHttpResponse = RepoReadHttpSuccess | RepoReadHttpFailure;

export function isRepoReadOperation(value: unknown): value is RepoReadOperation {
  return value === 'read' || value === 'list' || value === 'search';
}

export function parseRepoReadHttpRequest(
  body: unknown,
): RepoReadHttpRequest | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  const candidate = body as Record<string, unknown>;
  const provider = candidate.provider;
  if (provider !== 'ado' && provider !== 'github') {
    return { error: 'provider must be ado or github' };
  }
  const project = asNonEmptyString(candidate.project);
  const repo = asNonEmptyString(candidate.repo);
  const sha = asNonEmptyString(candidate.sha);
  if (!project || !repo || !sha) {
    return { error: 'project, repo, and sha are required' };
  }
  if (!SHA_RE.test(sha)) {
    return { error: 'sha must be a 40-character commit hash' };
  }
  return {
    provider,
    project,
    repo,
    sha,
    path: optionalString(candidate.path),
    query: optionalString(candidate.query),
    limit:
      typeof candidate.limit === 'number' && Number.isFinite(candidate.limit)
        ? candidate.limit
        : undefined,
  };
}

/** Publish one commit of a Brainstorm temporary repository as its Blob bundle. */
export interface PublishBundleHttpRequest {
  provider: 'github' | 'ado';
  project: string;
  repository: string;
  url: string;
  sha: string;
}

export type PublishBundleHttpResponse =
  | { ok: true; state: 'ok' | 'moved' }
  | { ok: false; message: string };

export function parsePublishBundleHttpRequest(
  body: unknown,
): PublishBundleHttpRequest | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  const candidate = body as Record<string, unknown>;
  const provider = candidate.provider;
  if (provider !== 'ado' && provider !== 'github') {
    return { error: 'provider must be ado or github' };
  }
  const project = asNonEmptyString(candidate.project);
  const repository = asNonEmptyString(candidate.repository);
  const url = asNonEmptyString(candidate.url);
  const sha = asNonEmptyString(candidate.sha);
  if (!project || !repository || !url || !sha) {
    return { error: 'project, repository, url, and sha are required' };
  }
  if (!SHA_RE.test(sha)) {
    return { error: 'sha must be a 40-character commit hash' };
  }
  return { provider, project, repository, url, sha: sha.toLowerCase() };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
