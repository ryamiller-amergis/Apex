export const AUTH_STATUS_TIMEOUT_MS = 8_000;

/**
 * GET /auth/status with a hard timeout so a wedged App Service instance cannot
 * leave the shell on the Apex loader indefinitely.
 */
export function fetchAuthStatus(init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), AUTH_STATUS_TIMEOUT_MS);
  const parentSignal = init?.signal;
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  return fetch('/auth/status', { ...init, credentials: 'include', signal: controller.signal })
    .finally(() => window.clearTimeout(timeoutId));
}
