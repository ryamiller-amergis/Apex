/**
 * Internal callback authentication middleware for build deployments (FEAT-013, TBI-025 / S4).
 *
 * Accepts either:
 * 1. An Entra managed-identity JWT (`BUILD_DEPLOY_CALLBACK_AUDIENCE` + `BUILD_DEPLOY_ALLOWED_CLIENT_IDS`)
 * 2. A static secret (`BUILD_DEPLOY_CALLBACK_TOKEN`) compared with `crypto.timingSafeEqual`.
 *
 * Returns 503 when neither is configured, and 401 when missing or invalid.
 */
import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { trackEvent } from '../services/telemetry';
import {
  parseBearerToken,
  verifyEntraManagedIdentityJwt,
} from '../utils/entraJwtVerifier';

export const BUILD_DEPLOY_CALLBACK_AUTH_HEADER = 'authorization';

function csvEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAudiences(): string[] {
  const explicit =
    process.env.BUILD_DEPLOY_CALLBACK_AUDIENCE?.trim() ||
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
  return csvEnv('BUILD_DEPLOY_ALLOWED_CLIENT_IDS');
}

function isAuthConfigured(): boolean {
  const staticToken = process.env.BUILD_DEPLOY_CALLBACK_TOKEN?.trim();
  return (
    Boolean(staticToken)
    || (resolveAudiences().length > 0 && resolveAllowedClientIds().length > 0)
  );
}

function constantTimeEquals(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireBuildDeploymentCallbackAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    if (!isAuthConfigured()) {
      trackEvent('build.deployment.callback.rejected', { reason: 'unconfigured' });
      res.status(503).json({
        error: 'Build deployment callback auth is not configured.',
        code: 'BUILD_DEPLOY_CALLBACK_AUTH_UNCONFIGURED',
      });
      return;
    }

    const token = parseBearerToken(req.header(BUILD_DEPLOY_CALLBACK_AUTH_HEADER));
    if (!token) {
      trackEvent('build.deployment.callback.rejected', { reason: 'unauthorized' });
      res.status(401).json({
        error: 'Invalid build deployment callback identity.',
        code: 'BUILD_DEPLOY_CALLBACK_UNAUTHORIZED',
      });
      return;
    }

    const staticExpected = process.env.BUILD_DEPLOY_CALLBACK_TOKEN?.trim();
    if (staticExpected && constantTimeEquals(token, staticExpected)) {
      next();
      return;
    }

    const audiences = resolveAudiences();
    const allowedClientIds = resolveAllowedClientIds();
    if (audiences.length > 0 && allowedClientIds.length > 0) {
      try {
        const ok = await verifyEntraManagedIdentityJwt(token, {
          audiences,
          allowedClientIds,
        });
        if (ok) {
          next();
          return;
        }
      } catch {
        // Fall through to 401
      }
    }

    trackEvent('build.deployment.callback.rejected', { reason: 'unauthorized' });
    res.status(401).json({
      error: 'Invalid build deployment callback identity.',
      code: 'BUILD_DEPLOY_CALLBACK_UNAUTHORIZED',
    });
  })().catch(next);
}
