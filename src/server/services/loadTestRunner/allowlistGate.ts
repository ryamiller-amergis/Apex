import type { LoadTestDispatchMessage } from '../../../shared/types/loadTest';

const PROD_ENV_EXACT = new Set(['prod', 'production', 'prd']);
const PROD_ENV_PREFIX = /^(prod|production|prd)([-_.]|$)/i;

/** Local copy of non-prod helpers so the runner image does not import Drizzle. */
function isProdEnvironmentLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return false;
  if (PROD_ENV_EXACT.has(normalized)) return true;
  return PROD_ENV_PREFIX.test(normalized);
}

function isProdHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (/(?:^|[.-])prod(?:[.-]|$)/.test(host)) return true;
  if (/(?:^|[.-])production(?:[.-]|$)/.test(host)) return true;
  return false;
}

/**
 * Local fail-closed non-prod gate (BR-001). Used by the runner before traffic.
 * Full allowlist membership is optionally checked via HTTP against Apex.
 */
export function assertDispatchNonProd(dispatch: LoadTestDispatchMessage): void {
  const env = dispatch.environment?.trim() ?? '';
  if (!env || isProdEnvironmentLabel(env)) {
    throw new Error(
      `Target environment "${dispatch.environment}" appears to be production and is refused (allowlist/non-prod check).`,
    );
  }

  let hostname = '';
  try {
    hostname = new URL(dispatch.targetUrl).hostname;
  } catch {
    throw new Error(`Target URL "${dispatch.targetUrl}" is invalid and is refused.`);
  }

  if (isProdHostname(hostname)) {
    throw new Error(
      `Hostname "${hostname}" appears to be a production host and is refused (allowlist/non-prod check).`,
    );
  }
}

export type AllowlistAsserter = (dispatch: LoadTestDispatchMessage) => Promise<void>;

/**
 * Calls Apex internal validate endpoint (runner MI / callback token).
 * Falls back to local non-prod only when base URL is empty (local unit wiring).
 */
export function createHttpAllowlistAsserter(options: {
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): AllowlistAsserter {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (dispatch) => {
    assertDispatchNonProd(dispatch);
    const base = dispatch.callbackBaseUrl?.replace(/\/+$/, '');
    if (!base) {
      return;
    }

    const token = await options.getToken();
    const url = `${base}/api/internal/load-test-runs/${encodeURIComponent(dispatch.projectId)}/targets/validate`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetUrl: dispatch.targetUrl,
        environment: dispatch.environment,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Allowlist validation failed (${res.status}): ${text || res.statusText}`,
      );
    }

    const body = (await res.json()) as { allowed?: boolean; reason?: string };
    if (!body.allowed) {
      throw new Error(
        body.reason ||
          'Target failed the runner final allowlist/non-prod check and is refused.',
      );
    }
  };
}
