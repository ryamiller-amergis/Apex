/**
 * Cancel and Resume sub-router for Build runs (FEAT-016, PBI-035, PBI-036, TBI-029 / S8).
 *
 * Mounted on the `builds` router (`/api/builds`).
 */
import { Router, type Request } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import {
  BuildRunControlError,
  defaultBuildRunControlService,
} from '../services/buildRunControlService';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LEN = 500;

const router = Router();
const projectAccess = requireProjectAccess((req) => resolveRequestProject(req));

router.post(
  '/:buildId/cancel',
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const { buildId } = req.params;
      if (!UUID_RE.test(buildId)) {
        res.status(400).json({
          error: 'buildId must be a valid UUID.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      const body = req.body as { reason?: unknown } | undefined;
      let reason: string | undefined;
      if (body?.reason !== undefined && body.reason !== null) {
        if (typeof body.reason !== 'string' || body.reason.length > MAX_REASON_LEN) {
          res.status(400).json({
            error: 'reason must be a string of at most 500 characters.',
            code: 'INVALID_REQUEST',
          });
          return;
        }
        reason = body.reason;
      }

      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const projectId = resolveRequestProject(req) as string;
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
      const isProjectAdmin = Boolean(userPerms?.has('admin:roles'));
      const isSuperAdmin = isSuperAdminRequest(req);

      const result = await defaultBuildRunControlService.cancel({
        buildId,
        projectId,
        reason,
        actor: {
          userId,
          isProjectAdmin,
          isSuperAdmin,
        },
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof BuildRunControlError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
          ...(error.remainingCause ? { remainingCause: error.remainingCause } : {}),
        });
        return;
      }
      next(error);
    }
  },
);

router.post(
  '/:buildId/resume',
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const { buildId } = req.params;
      if (!UUID_RE.test(buildId)) {
        res.status(400).json({
          error: 'buildId must be a valid UUID.',
          code: 'INVALID_REQUEST',
        });
        return;
      }

      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const projectId = resolveRequestProject(req) as string;
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
      const isProjectAdmin = Boolean(userPerms?.has('admin:roles'));
      const isSuperAdmin = isSuperAdminRequest(req);

      const result = await defaultBuildRunControlService.resume({
        buildId,
        projectId,
        actor: {
          userId,
          isProjectAdmin,
          isSuperAdmin,
        },
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof BuildRunControlError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
          ...(error.remainingCause ? { remainingCause: error.remainingCause } : {}),
        });
        return;
      }
      next(error);
    }
  },
);

export default router;
