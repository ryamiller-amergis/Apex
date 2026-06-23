import type { Request } from 'express';
import { ConfidentialClientApplication } from '@azure/msal-node';

/**
 * Azure DevOps resource (app) ID. The "/.default" scope requests a token whose
 * audience is Azure DevOps, redeemable against the ADO REST API as the user.
 */
const ADO_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

/** Refresh the cached token this many ms before it actually expires. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Sentinel refresh token issued by the dev-login mock user (auth.ts). */
const DEV_MOCK_REFRESH_TOKEN = 'mock-refresh-token';

/**
 * Thrown when an ADO write is attempted but no per-user Azure DevOps token can be
 * obtained (user not signed in with Azure AD, no refresh token, or the token
 * exchange failed). Carries a 403 status for the global error handler.
 */
export class AdoUserAuthError extends Error {
  status = 403;
  constructor(
    message = 'You do not have Azure DevOps access to perform this action. Ask an administrator to add you to the Azure DevOps organization and project.',
  ) {
    super(message);
    this.name = 'AdoUserAuthError';
  }
}

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

interface AdoTokenCache {
  accessToken: string;
  expiresAt: number;
}

/**
 * Acquire an Azure DevOps access token for the logged-in user.
 *
 * Uses the refresh token Passport captured at login (stored in the session via
 * serializeUser) and exchanges it for an ADO-scoped access token. The result is
 * cached on the session until shortly before expiry, so subsequent writes in the
 * same session reuse it without another network round trip.
 *
 * Returns null when there is no usable user context (e.g. the dev-login mock user,
 * agent-token requests, background jobs) or when the exchange fails. Callers that
 * require per-user attribution should treat null as a hard failure
 * (see adoFactory.ts).
 */
export async function getAdoTokenForUser(req: Request): Promise<string | null> {
  const user = (req as any).user;
  const refreshToken: string | undefined = user?.refreshToken;
  if (!refreshToken || refreshToken === DEV_MOCK_REFRESH_TOKEN) return null;

  const session = (req as any).session as { adoToken?: AdoTokenCache } | undefined;
  const now = Date.now();

  const cached = session?.adoToken;
  if (cached?.accessToken && cached.expiresAt - EXPIRY_SKEW_MS > now) {
    return cached.accessToken;
  }

  const client = getMsalClient();
  if (!client) return null;

  try {
    const result = await client.acquireTokenByRefreshToken({
      refreshToken,
      scopes: [ADO_SCOPE],
    });
    if (!result?.accessToken) return null;

    const expiresAt = result.expiresOn
      ? result.expiresOn.getTime()
      : now + 50 * 60 * 1000;

    if (session) {
      session.adoToken = { accessToken: result.accessToken, expiresAt };
    }
    return result.accessToken;
  } catch (err) {
    console.error(
      '[adoUserToken] Failed to acquire Azure DevOps token for user:',
      (err as any)?.message ?? err,
    );
    return null;
  }
}
