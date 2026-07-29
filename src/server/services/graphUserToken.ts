/**
 * Acquire a Microsoft Graph access token for the signed-in user.
 * Mirrors adoUserToken.ts: refresh-token exchange + short session cache.
 */
import type { Request } from 'express';
import { ConfidentialClientApplication } from '@azure/msal-node';

const GRAPH_SCOPES = ['User.Read'];

/** Refresh the cached token this many ms before it actually expires. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Sentinel refresh token issued by the dev-login mock user (auth.ts). */
const DEV_MOCK_REFRESH_TOKEN = 'mock-refresh-token';

let cachedClient: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication | null {
  const clientId = process.env.AZURE_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!clientId || !tenantId || !clientSecret) return null;

  if (!cachedClient) {
    cachedClient = new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret,
      },
    });
  }
  return cachedClient;
}

interface GraphTokenCache {
  accessToken: string;
  expiresAt: number;
}

/**
 * Returns a Graph-scoped access token for the logged-in user, or null when
 * unavailable (dev mock, missing refresh token, or exchange failure).
 *
 * Prefers a session-cached refresh result; falls back to the access token
 * Passport stored at login (same Graph audience from User.Read at sign-in).
 */
export async function getGraphTokenForUser(req: Request): Promise<string | null> {
  const user = (req as any).user;
  const refreshToken: string | undefined = user?.refreshToken;
  const sessionAccessToken: string | undefined = user?.accessToken;

  if (!refreshToken || refreshToken === DEV_MOCK_REFRESH_TOKEN) {
    // Dev mock / no refresh — session token is usually unusable against Graph.
    if (
      typeof sessionAccessToken === 'string' &&
      sessionAccessToken.length > 0 &&
      sessionAccessToken !== 'mock-access-token'
    ) {
      return sessionAccessToken;
    }
    return null;
  }

  const session = (req as any).session as { graphToken?: GraphTokenCache } | undefined;
  const now = Date.now();

  const cached = session?.graphToken;
  if (cached?.accessToken && cached.expiresAt - EXPIRY_SKEW_MS > now) {
    return cached.accessToken;
  }

  const client = getMsalClient();
  if (!client) {
    return typeof sessionAccessToken === 'string' && sessionAccessToken.length > 0
      ? sessionAccessToken
      : null;
  }

  try {
    const result = await client.acquireTokenByRefreshToken({
      refreshToken,
      scopes: GRAPH_SCOPES,
    });
    if (!result?.accessToken) {
      return typeof sessionAccessToken === 'string' && sessionAccessToken.length > 0
        ? sessionAccessToken
        : null;
    }

    const expiresAt = result.expiresOn
      ? result.expiresOn.getTime()
      : now + 50 * 60 * 1000;

    if (session) {
      session.graphToken = { accessToken: result.accessToken, expiresAt };
    }
    return result.accessToken;
  } catch (err) {
    console.error(
      '[graphUserToken] Failed to acquire Graph token for user:',
      (err as any)?.message ?? err
    );
    return typeof sessionAccessToken === 'string' && sessionAccessToken.length > 0
      ? sessionAccessToken
      : null;
  }
}
