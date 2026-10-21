import { ManagedIdentityCredential } from '@azure/identity';
import type { AccessToken, TokenCredential } from '@azure/identity';
import { resolveStaticAiRunnerCallbackToken } from './aiRunnerCallbackAuthConfig';

const TOKEN_REFRESH_SKEW_MS = 60_000;
const TRANSIENT_RETRY_DELAYS_MS = [50, 150];
const TRANSIENT_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export type AiRunsCallbackTokenOptions = {
  forceRefresh?: boolean;
};

type CachedCallbackToken = {
  token: string;
  expiresOnTimestamp: number;
  scope: string;
};

let credential: TokenCredential | null = null;
let cached: CachedCallbackToken | null = null;
let inflight: Promise<string> | null = null;

function audienceScope(audience: string): string {
  return audience.endsWith('/.default') ? audience : `${audience}/.default`;
}

function readStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { statusCode?: unknown; status?: unknown };
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (typeof record.status === 'number') return record.status;
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown };
  return typeof record.code === 'string' ? record.code : undefined;
}

function isTransientTokenError(error: unknown): boolean {
  const status = readStatusCode(error);
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  const code = readErrorCode(error);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = (
    error instanceof Error ? error.message : String(error ?? '')
  ).toLowerCase();
  return (
    message.includes('timeout')
    || message.includes('throttl')
    || message.includes('temporarily unavailable')
    || message.includes('econnreset')
    || message.includes('network')
    || message.includes('empty ai runner callback token')
  );
}

function tokenErrorFields(error: unknown): {
  errorName: string;
  errorMessage: string;
  statusCode?: number;
  errorCode?: string;
} {
  return {
    errorName: error instanceof Error ? error.name || 'Error' : 'UnknownError',
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: readStatusCode(error),
    errorCode: readErrorCode(error),
  };
}

function createManagedIdentityCredential(env: NodeJS.ProcessEnv): TokenCredential {
  const clientId = env.AZURE_CLIENT_ID?.trim();
  return clientId
    ? new ManagedIdentityCredential({ clientId })
    : new ManagedIdentityCredential();
}

function getCredential(
  env: NodeJS.ProcessEnv,
  recreate: boolean,
): TokenCredential {
  if (!recreate && credential) return credential;
  credential = createManagedIdentityCredential(env);
  return credential;
}

async function delay(ms: number): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireManagedIdentityToken(
  scope: string,
  env: NodeJS.ProcessEnv,
  forceRefresh: boolean,
): Promise<string> {
  const attempts = TRANSIENT_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const token: AccessToken | null = await getCredential(
        env,
        forceRefresh && attempt === 0,
      ).getToken(scope);
      const value = token?.token?.trim();
      if (!value) {
        throw new Error('Managed identity returned an empty AI runner callback token');
      }
      cached = {
        token: value,
        expiresOnTimestamp: token?.expiresOnTimestamp ?? 0,
        scope,
      };
      return value;
    } catch (error) {
      lastError = error;
      if (!isTransientTokenError(error) || attempt === attempts - 1) {
        break;
      }
      console.warn(JSON.stringify({
        event: 'AiRunnerCallbackTokenRetry',
        attempt: attempt + 1,
        ...tokenErrorFields(error),
      }));
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }

  console.error(JSON.stringify({
    event: 'AiRunnerCallbackTokenFailed',
    ...tokenErrorFields(lastError),
  }));
  if (lastError instanceof Error) throw lastError;
  throw new Error('Failed to acquire AI runner callback token');
}

/**
 * Token for Apex `/api/internal/ai-runs` callbacks.
 *
 * When `AI_RUNS_CALLBACK_TOKEN_AUDIENCE` is set, only a managed-identity JWT
 * is returned — never a silent static fallback. Static tokens are used only
 * when audience is unset and {@link resolveStaticAiRunnerCallbackToken} allows it.
 */
export async function getAiRunnerCallbackToken(
  options: AiRunsCallbackTokenOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const audience = env.AI_RUNS_CALLBACK_TOKEN_AUDIENCE?.trim();
  if (!audience) {
    const staticToken = resolveStaticAiRunnerCallbackToken(env);
    if (staticToken) return staticToken;
    throw new Error(
      'AI_RUNS_CALLBACK_TOKEN_AUDIENCE is required for managed-identity callbacks',
    );
  }

  const scope = audienceScope(audience);
  const forceRefresh = options.forceRefresh === true;
  if (!forceRefresh && cached && cached.scope === scope) {
    if (cached.expiresOnTimestamp - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return cached.token;
    }
  }
  if (!forceRefresh && inflight) return inflight;

  const pending = acquireManagedIdentityToken(scope, env, forceRefresh);
  inflight = pending;
  try {
    return await pending;
  } finally {
    if (inflight === pending) inflight = null;
  }
}

/** Test-only: drop the module-level credential and cached JWT. */
export function __resetAiRunnerCallbackTokenStateForTests(): void {
  credential = null;
  cached = null;
  inflight = null;
}
