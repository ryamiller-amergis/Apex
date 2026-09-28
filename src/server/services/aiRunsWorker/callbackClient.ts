import type { DispatchMessage } from '../../../shared/types/agentRunAdmission';
import type {
  AiRunBootstrapResponse,
  AiRunIngestBody,
  AiRunIngestResponse,
} from '../../../shared/types/aiRunIngest';

export class AiRunCallbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AiRunCallbackError';
  }
}

/** A stale worker must stop without attempting any later callback or write. */
export class AiRunFenceConflictError extends AiRunCallbackError {
  constructor(message = 'AI run dispatch fence rejected') {
    super(message, 409, 'AI_RUN_DISPATCH_MISMATCH');
    this.name = 'AiRunFenceConflictError';
  }
}

export interface AiRunsCallbackClient {
  getBootstrap(dispatch: DispatchMessage): Promise<AiRunBootstrapResponse>;
  postIngest(
    projectId: string,
    runId: string,
    body: AiRunIngestBody,
  ): Promise<AiRunIngestResponse>;
}

type CallbackErrorBody = {
  code?: string;
};

/**
 * Statuses that describe an overloaded or briefly unavailable API rather than a
 * rejected request. Retrying these matters because the worker has no other way
 * to reach a terminal state: it dies before its first callback, leaving the run
 * `dispatched` with nothing to report the failure.
 */
const RETRYABLE_CALLBACK_STATUSES: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);
const MAX_CALLBACK_ATTEMPTS = 4;
const CALLBACK_RETRY_BASE_DELAY_MS = 500;

/**
 * A fence conflict means this worker has been superseded, so a replay can only
 * earn the same rejection. Failures that never reached HTTP (dropped socket,
 * DNS, token fetch) carry no status and are treated as transient.
 */
function isRetryableCallbackFailure(error: unknown): boolean {
  if (error instanceof AiRunFenceConflictError) return false;
  if (error instanceof AiRunCallbackError) {
    return RETRYABLE_CALLBACK_STATUSES.has(error.status);
  }
  return true;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function callbackErrorCode(body: unknown): string | undefined {
  return body && typeof body === 'object' && typeof (body as CallbackErrorBody).code === 'string'
    ? (body as CallbackErrorBody).code
    : undefined;
}

async function assertOk(response: Response): Promise<unknown> {
  const body = await readJson(response);
  if (response.ok) return body;

  const code = callbackErrorCode(body);
  if (response.status === 409 && code === 'AI_RUN_DISPATCH_MISMATCH') {
    throw new AiRunFenceConflictError();
  }
  throw new AiRunCallbackError(
    `AI run callback failed (${response.status})`,
    response.status,
    code,
  );
}

export type AiRunsCallbackGetToken = (options?: {
  forceRefresh?: boolean;
}) => Promise<string>;

export function createAiRunsCallbackClient(options: {
  callbackBaseUrl: string;
  getToken: AiRunsCallbackGetToken;
  fetchImpl?: typeof fetch;
  /** Injectable delay so retry backoff does not slow tests down. */
  sleepImpl?: (ms: number) => Promise<void>;
}): AiRunsCallbackClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const base = options.callbackBaseUrl.replace(/\/+$/, '');

  const send = async (
    url: string,
    init: RequestInit,
    forceRefresh: boolean,
  ): Promise<Response> => {
    const token = await options.getToken(
      forceRefresh ? { forceRefresh: true } : undefined,
    );
    return fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  };

  const request = async (
    url: string,
    init: RequestInit,
  ): Promise<unknown> => {
    let response = await send(url, init, false);
    if (response.status === 401) {
      const body = await readJson(response);
      const code = callbackErrorCode(body);
      if (code === 'AI_RUNNER_UNAUTHORIZED') {
        response = await send(url, init, true);
        return assertOk(response);
      }
      throw new AiRunCallbackError(
        `AI run callback failed (${response.status})`,
        response.status,
        code,
      );
    }
    return assertOk(response);
  };

  /**
   * Replays a call whose failure was unrelated to its content.
   *
   * Used for the bootstrap read and for terminal ingest only. Repeating a
   * terminal is a no-op server side when the status matches, so a replay cannot
   * double-apply the transition. Heartbeat and progress stay unretried: they
   * are latency-sensitive and losing one costs nothing.
   */
  const requestWithRetry = async (
    url: string,
    init: RequestInit,
  ): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await request(url, init);
      } catch (error) {
        if (
          !isRetryableCallbackFailure(error)
          || attempt >= MAX_CALLBACK_ATTEMPTS
        ) {
          throw error;
        }
        await sleepImpl(CALLBACK_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
      }
    }
  };

  return {
    async getBootstrap(dispatch) {
      const query = new URLSearchParams({
        dispatchMessageId: dispatch.dispatchMessageId,
      });
      return requestWithRetry(
        `${base}/api/internal/ai-runs/${encodeURIComponent(dispatch.runId)}/bootstrap?${query}`,
        { method: 'GET' },
      ) as Promise<AiRunBootstrapResponse>;
    },

    async postIngest(projectId, runId, body) {
      const url = `${base}/api/internal/ai-runs/${encodeURIComponent(projectId)}/${encodeURIComponent(runId)}/ingest`;
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };
      // Losing a terminal report is unrecoverable: the worker exits right after
      // it, so the run falls to the reaper and work that actually succeeded is
      // recorded as a failure.
      return (body.kind === 'terminal'
        ? requestWithRetry(url, init)
        : request(url, init)) as Promise<AiRunIngestResponse>;
    },
  };
}
