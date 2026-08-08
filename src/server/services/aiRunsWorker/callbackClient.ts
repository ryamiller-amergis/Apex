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

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function assertOk(response: Response): Promise<unknown> {
  const body = await readJson(response);
  if (response.ok) return body;

  const code =
    body && typeof body === 'object' && typeof (body as CallbackErrorBody).code === 'string'
      ? (body as CallbackErrorBody).code
      : undefined;
  if (response.status === 409 && code === 'AI_RUN_DISPATCH_MISMATCH') {
    throw new AiRunFenceConflictError();
  }
  throw new AiRunCallbackError(
    `AI run callback failed (${response.status})`,
    response.status,
    code,
  );
}

export function createAiRunsCallbackClient(options: {
  callbackBaseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): AiRunsCallbackClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.callbackBaseUrl.replace(/\/+$/, '');

  const request = async (
    url: string,
    init: RequestInit,
  ): Promise<unknown> => {
    const token = await options.getToken();
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
    return assertOk(response);
  };

  return {
    async getBootstrap(dispatch) {
      const query = new URLSearchParams({
        dispatchMessageId: dispatch.dispatchMessageId,
      });
      return request(
        `${base}/api/internal/ai-runs/${encodeURIComponent(dispatch.runId)}/bootstrap?${query}`,
        { method: 'GET' },
      ) as Promise<AiRunBootstrapResponse>;
    },

    async postIngest(projectId, runId, body) {
      return request(
        `${base}/api/internal/ai-runs/${encodeURIComponent(projectId)}/${encodeURIComponent(runId)}/ingest`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ) as Promise<AiRunIngestResponse>;
    },
  };
}
