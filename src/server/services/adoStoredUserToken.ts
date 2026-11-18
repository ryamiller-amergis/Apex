/**
 * Azure DevOps access as a user who is not in the request: the saved refresh
 * token is redeemed for an access token. Playbook Cloud Agent steps use it to
 * open the pull request as the Playbook author, often hours after they signed in.
 */
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { userAdoCredentials } from '../db/schema';
import { ADO_SCOPE, DEV_MOCK_REFRESH_TOKEN, getMsalClient } from './adoUserToken';
import {
  decryptMcpServerCredential,
  encryptMcpServerCredential,
} from './mcpServerCredentialCrypto';
import { getUserId } from '../utils/requestUser';

/** Binds the ciphertext to its row, so a token copied to another user does not decrypt. */
function binding(userId: string) {
  return { project: 'user-ado-credential', connectionId: userId };
}

export async function saveAdoRefreshToken(userId: string, refreshToken: string): Promise<void> {
  if (!userId || userId === 'anonymous') return;
  if (!refreshToken || refreshToken === DEV_MOCK_REFRESH_TOKEN) return;
  const encryptedRefreshToken = encryptMcpServerCredential(refreshToken, binding(userId));
  const updatedAt = new Date().toISOString();
  await db
    .insert(userAdoCredentials)
    .values({ userId, encryptedRefreshToken, updatedAt })
    .onConflictDoUpdate({
      target: userAdoCredentials.userId,
      set: { encryptedRefreshToken, updatedAt },
    });
}

/** Saves the signed-in user's refresh token. Logs and continues on failure. */
export async function saveRequestAdoRefreshToken(req: Request): Promise<void> {
  const refreshToken: string | undefined = (req as { user?: { refreshToken?: string } }).user?.refreshToken;
  if (!refreshToken) return;
  try {
    await saveAdoRefreshToken(getUserId(req), refreshToken);
  } catch (err) {
    console.warn(
      '[ado-stored-token] could not save the Azure DevOps refresh token',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function hasStoredAdoToken(userId: string): Promise<boolean> {
  const row = await db.query.userAdoCredentials.findFirst({
    where: eq(userAdoCredentials.userId, userId),
    columns: { userId: true },
  });
  return Boolean(row);
}

/** The refresh token MSAL cached for this account after a redeem. Rotated tokens last longer. */
function cachedRefreshToken(
  client: NonNullable<ReturnType<typeof getMsalClient>>,
  homeAccountId: string | undefined,
): string | null {
  if (!homeAccountId) return null;
  try {
    const cache = JSON.parse(client.getTokenCache().serialize()) as {
      RefreshToken?: Record<string, { home_account_id?: string; secret?: string }>;
    };
    const entry = Object.values(cache.RefreshToken ?? {})
      .find((item) => item.home_account_id === homeAccountId && item.secret);
    return entry?.secret ?? null;
  } catch {
    return null;
  }
}

/**
 * An Azure DevOps access token for the user, from their saved refresh token.
 * Null when nothing is saved or the token no longer redeems (expired, revoked,
 * or the key changed); the caller then uses the service account.
 */
export async function getStoredAdoTokenForUser(userId: string): Promise<string | null> {
  const row = await db.query.userAdoCredentials.findFirst({
    where: eq(userAdoCredentials.userId, userId),
  });
  if (!row) return null;
  const client = getMsalClient();
  if (!client) return null;

  try {
    const refreshToken = decryptMcpServerCredential(row.encryptedRefreshToken, binding(userId));
    const result = await client.acquireTokenByRefreshToken({ refreshToken, scopes: [ADO_SCOPE] });
    if (!result?.accessToken) return null;
    const rotated = cachedRefreshToken(client, result.account?.homeAccountId);
    if (rotated && rotated !== refreshToken) {
      await saveAdoRefreshToken(userId, rotated).catch((err) => {
        console.warn(
          '[ado-stored-token] could not save the rotated refresh token',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    return result.accessToken;
  } catch (err) {
    console.warn('[ado-stored-token] saved Azure DevOps token did not redeem', JSON.stringify({
      userId,
      error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}
