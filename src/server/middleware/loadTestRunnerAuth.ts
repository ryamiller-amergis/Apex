/**
 * Runner callback auth for load-test ingest (FEAT-007 / A-009 / PBI-009 AC-1).
 * Human session RBAC is NOT a substitute for callback identity.
 *
 * Accepted credentials (either is enough):
 * 1. Managed-identity AAD access token (preferred in Azure)
 *    - Runner acquires token for LT_CALLBACK_TOKEN_AUDIENCE (or api://AZURE_CLIENT_ID)
 *    - Server verifies JWT via Entra JWKS and requires appid/azp ∈ LT_RUNNER_ALLOWED_CLIENT_IDS
 * 2. Static shared secret LT_RUNNER_CALLBACK_TOKEN (local/tests only; optional)
 */
import type { Request, Response, NextFunction } from 'express';
import {
  clearEntraJwksCache,
  parseBearerToken,
  verifyEntraManagedIdentityJwt,
} from '../utils/entraJwtVerifier';

export const LOAD_TEST_RUNNER_AUTH_HEADER = 'authorization';

function csvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAudienceCandidates(): string[] {
  const explicit =
    process.env.LT_CALLBACK_TOKEN_AUDIENCE?.trim() ||
    process.env.APEX_API_APP_ID_URI?.trim();
  if (explicit) {
    return [explicit.replace(/\/\.default$/i, '')];
  }
  const clientId = process.env.AZURE_CLIENT_ID?.trim();
  if (clientId) {
    return [`api://${clientId}`, clientId];
  }
  return [];
}

function resolveAllowedClientIds(): string[] {
  return csvEnv('LT_RUNNER_ALLOWED_CLIENT_IDS');
}

function authConfigured(): boolean {
  const staticToken = process.env.LT_RUNNER_CALLBACK_TOKEN?.trim();
  return Boolean(staticToken) || (resolveAudienceCandidates().length > 0 && resolveAllowedClientIds().length > 0);
}

/**
 * Express middleware — validates runner Bearer token (MI JWT preferred, static optional).
 */
export function requireLoadTestRunnerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    if (!authConfigured()) {
      res.status(503).json({
        error:
          'Load-test runner callback auth is not configured (set LT_CALLBACK_TOKEN_AUDIENCE + LT_RUNNER_ALLOWED_CLIENT_IDS, or LT_RUNNER_CALLBACK_TOKEN for local/tests)',
        code: 'LOAD_TEST_RUNNER_AUTH_UNCONFIGURED',
      });
      return;
    }

    const token = parseBearerToken(req.header(LOAD_TEST_RUNNER_AUTH_HEADER));
    if (!token) {
      res.status(401).json({
        error: 'Invalid load-test runner identity',
        code: 'LOAD_TEST_RUNNER_UNAUTHORIZED',
      });
      return;
    }

    const staticExpected = process.env.LT_RUNNER_CALLBACK_TOKEN?.trim();
    if (staticExpected && token === staticExpected) {
      next();
      return;
    }

    // Prefer MI JWT when allowed-client list is configured.
    if (resolveAllowedClientIds().length > 0 && resolveAudienceCandidates().length > 0) {
      try {
        if (
          await verifyEntraManagedIdentityJwt(token, {
            audiences: resolveAudienceCandidates(),
            allowedClientIds: resolveAllowedClientIds(),
          })
        ) {
          next();
          return;
        }
      } catch {
        // fall through to 401
      }
    }

    res.status(401).json({
      error: 'Invalid load-test runner identity',
      code: 'LOAD_TEST_RUNNER_UNAUTHORIZED',
    });
  })().catch(next);
}

/** Test helper — clear JWKS cache between cases. */
export function __resetLoadTestRunnerAuthJwksCacheForTests(): void {
  clearEntraJwksCache();
}
