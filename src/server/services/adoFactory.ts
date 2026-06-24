import type { Request } from 'express';
import { AzureDevOpsService } from './azureDevOps';
import { getAdoTokenForUser, AdoUserAuthError } from './adoUserToken';

/**
 * Build an AzureDevOpsService for a per-user WRITE operation.
 *
 * Acquires the logged-in user's Azure DevOps token and binds it to the service so
 * the resulting ADO changes are attributed to that user. If no user token can be
 * obtained:
 *   - In production: throws AdoUserAuthError (HTTP 403) — no silent PAT fallback.
 *   - In non-production (local dev / dev-login mock): falls back to the PAT so
 *     local development keeps working.
 */
export async function adoWriteForRequest(
  req: Request,
  project?: string,
  areaPath?: string,
): Promise<AzureDevOpsService> {
  const token = await getAdoTokenForUser(req);
  return adoWriteFromToken(token, project, areaPath);
}

/**
 * Same hard-fail/dev-fallback policy as adoWriteForRequest, but for callers that
 * have already resolved the token (e.g. service functions that receive a token
 * threaded down from the route layer instead of the Express request).
 */
export function adoWriteFromToken(
  token: string | null,
  project?: string,
  areaPath?: string,
): AzureDevOpsService {
  if (token) {
    return new AzureDevOpsService(project, areaPath, { bearerToken: token });
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      '[adoFactory] No per-user Azure DevOps token available; falling back to PAT (non-production only).',
    );
    return new AzureDevOpsService(project, areaPath);
  }
  throw new AdoUserAuthError();
}

/**
 * Build an AzureDevOpsService for endpoints that can be reached either by a
 * logged-in user OR by a non-user caller (e.g. the agent-token /backlog/update-figma-url
 * callback). Prefers the user's token for attribution, but falls back to the PAT
 * when there is no user context instead of hard-failing.
 */
export async function adoWritePreferUser(
  req: Request,
  project?: string,
  areaPath?: string,
): Promise<AzureDevOpsService> {
  const token = await getAdoTokenForUser(req);
  return token
    ? new AzureDevOpsService(project, areaPath, { bearerToken: token })
    : new AzureDevOpsService(project, areaPath);
}

/** Narrow an unknown error to AdoUserAuthError for route-level 403 mapping. */
export function isAdoUserAuthError(err: unknown): err is AdoUserAuthError {
  return err instanceof AdoUserAuthError;
}
