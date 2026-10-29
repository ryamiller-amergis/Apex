import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { requirePermission, requireProjectAccess, resolveRequestProject } from './rbac';
import { isBuildFromPromptEnabled, isBuildPairAllowed } from '../services/buildAccessService';
import { getUserId } from '../utils/requestUser';
import {
  BUILDS_RUN,
  BUILDS_VIEW,
  BUILD_FLAG_DISABLED_CODE,
  BUILD_FLAG_DISABLED_MESSAGE,
  BUILD_PAIR_NOT_ALLOWED_CODE,
  BUILD_PAIR_NOT_ALLOWED_MESSAGE,
  type BuildAccessRefusal,
} from '../../shared/types/buildAccess';

export const MISSING_PROJECT_ERROR = 'project query or x-apex-project header is required';
export const MISSING_REPOSITORY_ERROR = 'repository is required';

function refuse(res: Response, body: BuildAccessRefusal, project: string): void {
  console.info(`[build-access] refused code=${body.code} project=${project}`);
  res.status(403).json(body);
}

/**
 * Refuses start and action routes when `build-from-prompt` is off for the
 * caller. Super admins are not exempt.
 * Cleanup plan for `build-from-prompt`: retain the enabled branch after two
 * stable sprints at full rollout.
 */
export const requireBuildFlag: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const project = resolveRequestProject(req);
    if (!project) {
      res.status(400).json({ error: MISSING_PROJECT_ERROR });
      return;
    }
    const enabled = await isBuildFromPromptEnabled({ userId: getUserId(req), project });
    // @feature-flag:build-from-prompt start winner=enabled
    if (!enabled) {
      // @feature-flag:build-from-prompt disabled-start
      refuse(res, { error: BUILD_FLAG_DISABLED_MESSAGE, code: BUILD_FLAG_DISABLED_CODE }, project);
      return;
      // @feature-flag:build-from-prompt disabled-end
    }
    // @feature-flag:build-from-prompt enabled-start
    next();
    // @feature-flag:build-from-prompt enabled-end
    // @feature-flag:build-from-prompt end
  } catch (err) {
    next(err);
  }
};

/** Refuses the request unless the named project and repository pair is allow-listed. */
export function requireAllowlistedPair(resolveRepository: (req: Request) => unknown): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: MISSING_PROJECT_ERROR });
        return;
      }
      const raw = resolveRepository(req);
      const repository = typeof raw === 'string' ? raw.trim() : '';
      if (!repository) {
        res.status(400).json({ error: MISSING_REPOSITORY_ERROR });
        return;
      }
      if (!(await isBuildPairAllowed(project, repository))) {
        refuse(res, { error: BUILD_PAIR_NOT_ALLOWED_MESSAGE, code: BUILD_PAIR_NOT_ALLOWED_CODE }, project);
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Read routes. No flag check, so past builds stay readable when the flag is off. */
export const buildReadGuard: RequestHandler[] = [
  requirePermission(BUILDS_VIEW),
  requireProjectAccess(resolveRequestProject),
];

/** Start routes. Owning routes append `requireAllowlistedPair(...)`. */
export const buildRunGuard: RequestHandler[] = [
  requirePermission(BUILDS_RUN),
  requireProjectAccess(resolveRequestProject),
  requireBuildFlag,
];

/** Action routes. Requester and admin checks stay in the owning route's service. */
export const buildActionGuard: RequestHandler[] = [
  requireProjectAccess(resolveRequestProject),
  requireBuildFlag,
];
