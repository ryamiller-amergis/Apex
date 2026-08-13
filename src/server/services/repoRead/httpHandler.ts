import type { RepoReader, RepositoryIdentity } from '../../../shared/types/repoReader';
import { RepoReaderError } from '../repoReader';
import {
  isRepoReadOperation,
  parseRepoReadHttpRequest,
  type RepoReadHttpRequest,
  type RepoReadHttpResponse,
  type RepoReadOperation,
} from './httpProtocol';

export interface RepoReadHandlerDependencies {
  readerFor(identity: RepositoryIdentity): Promise<RepoReader>;
}

export interface RepoReadHandlerResult {
  status: number;
  body: RepoReadHttpResponse | { ok: false; error: string };
}

export async function handleRepoReadRequest(
  operation: unknown,
  body: unknown,
  dependencies: RepoReadHandlerDependencies,
): Promise<RepoReadHandlerResult> {
  if (!isRepoReadOperation(operation)) {
    return {
      status: 400,
      body: { ok: false, error: 'operation must be read, list, or search' },
    };
  }
  const parsed = parseRepoReadHttpRequest(body);
  if ('error' in parsed) {
    return { status: 400, body: { ok: false, error: parsed.error } };
  }

  const identity: RepositoryIdentity = {
    provider: parsed.provider,
    project: parsed.project,
    repo: parsed.repo,
    sha: parsed.sha,
  };

  try {
    const reader = await dependencies.readerFor(identity);
    const success = await executeOperation(operation, reader, parsed);
    return { status: 200, body: success };
  } catch (error) {
    if (error instanceof RepoReaderError) {
      return {
        status: statusForCode(error.code),
        body: {
          ok: false,
          code: error.code,
          message: error.message,
          fallbackEligible: error.fallbackEligible,
        },
      };
    }
    return {
      status: 500,
      body: {
        ok: false,
        code: 'LOCAL_READ_UNAVAILABLE',
        message: 'Repository content is unavailable',
        fallbackEligible: true,
      },
    };
  }
}

async function executeOperation(
  operation: RepoReadOperation,
  reader: RepoReader,
  parsed: RepoReadHttpRequest,
): Promise<Extract<RepoReadHttpResponse, { ok: true }>> {
  switch (operation) {
    case 'read':
      return {
        ok: true,
        operation: 'read',
        content: await reader.readFile(parsed.path ?? ''),
      };
    case 'list':
      return {
        ok: true,
        operation: 'list',
        entries: await reader.listDir(parsed.path ?? ''),
      };
    case 'search':
      return {
        ok: true,
        operation: 'search',
        results: await reader.searchCode(parsed.query ?? '', parsed.limit),
      };
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

function statusForCode(code: RepoReaderError['code']): number {
  switch (code) {
    case 'ACCESS_DENIED':
      return 403;
    case 'PROFILE_UNAVAILABLE':
      return 401;
    case 'REMOTE_SEARCH_DISABLED':
      return 409;
    case 'LOCAL_READ_UNAVAILABLE':
      return 404;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}
