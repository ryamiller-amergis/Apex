/**
 * Brief route guards for build-intake interviews (FEAT-006 TBI-010).
 *
 * Each guard loads the interview once by primary key. A non-build interview is handed to the
 * route's existing middleware unchanged; a build-intake interview is put on
 * `res.locals.buildIntakeInterview` after its own check.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { eq } from 'drizzle-orm';
import { BUILD_BRIEF_PAUSED_MESSAGE, BUILD_FLAG_DISABLED_CODE, BUILDS_VIEW } from '../../shared/types/buildAccess';
import { db } from '../db/drizzle';
import { interviews } from '../db/schema';
import { isBuildFromPromptEnabled } from '../services/buildAccessService';
import { canActOnBuildIntakeInterview, isBuildIntakeInterview } from '../services/buildIntakeAccess';
import type { BuildIntakeInterview } from '../services/buildBriefService';
import { BUILD_BRIEF_FORBIDDEN_MESSAGE } from '../services/buildBriefService';
import { getUserPermissions } from '../services/rbacService';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';

export const BUILD_BRIEF_READ_FORBIDDEN_MESSAGE = 'You need access to builds in this project to read this brief.';

async function loadInterviewRow(interviewId: string): Promise<BuildIntakeInterview | null> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
    columns: { id: true, project: true, authorId: true, playbookProfileKey: true },
  });
  return row ?? null;
}

export function buildIntakeInterviewOf(res: Response): BuildIntakeInterview | undefined {
  return res.locals.buildIntakeInterview as BuildIntakeInterview | undefined;
}

function runChain(handlers: readonly RequestHandler[], req: Request, res: Response, next: NextFunction): void {
  const [first, ...rest] = handlers;
  if (!first) {
    next();
    return;
  }
  first(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    runChain(rest, req, res, next);
  });
}

async function canReadBuildBrief(req: Request, interview: BuildIntakeInterview): Promise<boolean> {
  const userId = getUserId(req);
  if (isSuperAdminRequest(req)) return true;
  if (await canActOnBuildIntakeInterview(userId, interview)) return true;
  const perms = await getUserPermissions(userId, interview.project ?? undefined);
  return perms.has(BUILDS_VIEW);
}

/**
 * Read guard. A build-intake brief needs `builds:view` in the interview's project unless the caller
 * is the requester or an admin. `fallback` runs for every other interview.
 */
export function requireBriefReader(fallback: readonly RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const row = await loadInterviewRow(req.params.id);
      if (!row || !isBuildIntakeInterview(row)) {
        runChain(fallback, req, res, next);
        return;
      }
      if (!(await canReadBuildBrief(req, row))) {
        res.status(403).json({ error: BUILD_BRIEF_READ_FORBIDDEN_MESSAGE });
        return;
      }
      res.locals.buildIntakeInterview = row;
      next();
    })().catch(next);
  };
}

/**
 * Mutation guard for save, draft and approve. A build-intake interview admits only the requester,
 * a Project Admin or a Platform Admin, and refuses while `build-from-prompt` is off.
 */
export function requireBriefEditor(fallback: readonly RequestHandler[]): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const row = await loadInterviewRow(req.params.id);
      if (!row || !isBuildIntakeInterview(row)) {
        runChain(fallback, req, res, next);
        return;
      }
      const userId = getUserId(req);
      if (!(await canActOnBuildIntakeInterview(userId, row))) {
        res.status(403).json({ error: BUILD_BRIEF_FORBIDDEN_MESSAGE });
        return;
      }
      const enabled = await isBuildFromPromptEnabled({ userId, project: row.project ?? '' });
      // @feature-flag:build-from-prompt start winner=enabled
      if (!enabled) {
        // @feature-flag:build-from-prompt disabled-start
        res.status(403).json({ error: BUILD_BRIEF_PAUSED_MESSAGE, code: BUILD_FLAG_DISABLED_CODE });
        return;
        // @feature-flag:build-from-prompt disabled-end
      }
      // @feature-flag:build-from-prompt enabled-start
      res.locals.buildIntakeInterview = row;
      next();
      // @feature-flag:build-from-prompt enabled-end
      // @feature-flag:build-from-prompt end
    })().catch(next);
  };
}
