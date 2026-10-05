import type {
  RepoDirEntry,
  RepoReader,
  RepoSearchResult,
  RepositoryIdentity,
} from '../../../shared/types/repoReader';
import type { GroundingTelemetryContext } from '../../../shared/types/groundingOperations';
import { createGroundingTelemetry } from '../groundingTelemetry';
import { RepoReaderError } from '../repoReader';
import { trackEvent } from '../telemetry';
import {
  REPO_READ_SERVICE_TOKEN_ENV,
  REPO_READ_SERVICE_URL_ENV,
  type RepoReadHttpResponse,
  type RepoReadOperation,
} from './httpProtocol';

export interface RepoServiceReaderOptions {
  identity: RepositoryIdentity;
  baseUrl?: string;
  authToken?: string;
  telemetryContext?: GroundingTelemetryContext;
  telemetry?: typeof trackEvent;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const LOCAL_UNAVAILABLE_MESSAGE = 'Repository content is unavailable';

export function resolveRepoReadServiceUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[REPO_READ_SERVICE_URL_ENV]?.trim();
  return value || undefined;
}

export function resolveRepoReadServiceToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    env[REPO_READ_SERVICE_TOKEN_ENV]?.trim()
    || env.AI_RUNS_RUNNER_CALLBACK_TOKEN?.trim()
    || undefined
  );
}

export class RepoServiceReader implements RepoReader {
  readonly identity: RepositoryIdentity;
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly telemetryContext?: GroundingTelemetryContext;
  private readonly telemetry: ReturnType<typeof createGroundingTelemetry>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: RepoServiceReaderOptions) {
    const baseUrl = options.baseUrl ?? resolveRepoReadServiceUrl();
    if (!baseUrl) {
      throw new RepoReaderError(
        'LOCAL_READ_UNAVAILABLE',
        'Repository read service URL is not configured',
        true,
      );
    }
    this.identity = { ...options.identity };
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authToken = options.authToken ?? resolveRepoReadServiceToken();
    this.telemetryContext = options.telemetryContext;
    this.telemetry = createGroundingTelemetry(options.telemetry ?? trackEvent);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async readFile(filePath: string): Promise<string> {
    const body = await this.request('read', { path: filePath });
    if (!body.ok || body.operation !== 'read') {
      throw unavailable();
    }
    return body.content;
  }

  async listDir(dirPath: string): Promise<RepoDirEntry[]> {
    const body = await this.request('list', { path: dirPath });
    if (!body.ok || body.operation !== 'list') {
      throw unavailable();
    }
    return body.entries;
  }

  async searchCode(query: string, limit?: number): Promise<RepoSearchResult[]> {
    const body = await this.request('search', { query, limit });
    if (!body.ok || body.operation !== 'search') {
      throw unavailable();
    }
    return body.results;
  }

  private async request(
    operation: RepoReadOperation,
    extra: { path?: string; query?: string; limit?: number },
  ): Promise<RepoReadHttpResponse> {
    const started = this.now();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/${operation}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: this.identity.provider,
          project: this.identity.project,
          repo: this.identity.repo,
          sha: this.identity.sha,
          ...extra,
        }),
      });
    } catch {
      throw unavailable();
    }

    const parsed = (await response.json().catch(() => null)) as
      | RepoReadHttpResponse
      | null;
    if (this.telemetryContext) {
      try {
        this.telemetry.localRead(this.telemetryContext, this.now() - started);
      } catch {
        // Observability must never change repository-read behavior.
      }
    }
    if (parsed && parsed.ok === false && 'code' in parsed) {
      throw new RepoReaderError(
        parsed.code,
        parsed.message,
        parsed.fallbackEligible,
      );
    }
    if (!response.ok || !parsed || parsed.ok !== true) {
      throw unavailable();
    }
    return parsed;
  }
}

function unavailable(): RepoReaderError {
  return new RepoReaderError(
    'LOCAL_READ_UNAVAILABLE',
    LOCAL_UNAVAILABLE_MESSAGE,
    true,
  );
}
