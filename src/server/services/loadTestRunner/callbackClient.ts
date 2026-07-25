import type { LoadTestRunIngestBody } from '../../../shared/types/loadTest';

export type IngestResponse = {
  ok: boolean;
  cancelRequested: boolean;
};

export type CallbackClient = {
  postIngest(
    projectId: string,
    runId: string,
    body: LoadTestRunIngestBody,
  ): Promise<IngestResponse>;
};

/**
 * HTTP callback client for FEAT-007 ingest (progress | final | cancel_ack).
 * Auth: Authorization Bearer LT_RUNNER_CALLBACK_TOKEN (or MI token provider).
 */
export function createHttpCallbackClient(options: {
  callbackBaseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): CallbackClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.callbackBaseUrl.replace(/\/+$/, '');

  return {
    async postIngest(projectId, runId, body) {
      const token = await options.getToken();
      const url = `${base}/api/internal/load-test-runs/${encodeURIComponent(projectId)}/${encodeURIComponent(runId)}/ingest`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `${body.dispatchMessageId}:${body.kind}:${body.heartbeatAt ?? body.status ?? 'na'}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Load-test ingest callback failed (${res.status}): ${text || res.statusText}`,
        );
      }

      const json = (await res.json()) as {
        ok?: boolean;
        cancelRequested?: boolean;
        run?: { cancelRequested?: boolean };
      };

      return {
        ok: json.ok !== false,
        cancelRequested: Boolean(
          json.cancelRequested ?? json.run?.cancelRequested,
        ),
      };
    },
  };
}
