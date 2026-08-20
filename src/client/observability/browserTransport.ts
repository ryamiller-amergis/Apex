/**
 * Best-effort browser ingest transport. Never throws to the caller.
 */
import { OBSERVABILITY_INGEST_PATH } from '../../shared/types/observability';

export interface BrowserTransportDeps {
  sendBeacon?: typeof navigator.sendBeacon;
  fetchFn?: typeof fetch;
}

export async function sendBrowserBatch(
  body: unknown,
  mode: 'interval' | 'pagehide',
  deps: BrowserTransportDeps = {},
): Promise<boolean> {
  const payload = JSON.stringify(body);
  const blob = new Blob([payload], { type: 'application/json' });

  if (mode === 'pagehide') {
    const sendBeacon = deps.sendBeacon ?? navigator.sendBeacon?.bind(navigator);
    if (typeof sendBeacon === 'function') {
      try {
        if (sendBeacon(OBSERVABILITY_INGEST_PATH, blob)) return true;
      } catch {
        // Fall through to keepalive fetch.
      }
    }
  }

  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await fetchFn(OBSERVABILITY_INGEST_PATH, {
      method: 'POST',
      credentials: 'include',
      keepalive: mode === 'pagehide',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    return response.ok;
  } catch {
    return false;
  }
}
