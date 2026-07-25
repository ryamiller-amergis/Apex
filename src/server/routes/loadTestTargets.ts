/**
 * Routes: /api/projects/:projectId/load-test-targets
 * FEAT-005 — Per-Project Target Allowlist
 *
 * GET:    requirePermission('load-test:view')
 * POST/PATCH/DELETE: requirePermission('admin:roles')  // Project Admin (not load-test:manage)
 */

import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import * as loadTestTargetService from '../services/loadTestTargetService';
import { LoadTestValidationError } from '../../shared/types/loadTest';
import type {
  CreateLoadTestTargetInput,
  UpdateLoadTestTargetInput,
} from '../../shared/types/loadTest';

const router = Router({ mergeParams: true });

/** Ensure project-scoped RBAC resolves from :projectId when ?project= is absent. */
router.use((req, _res, next) => {
  const projectId = req.params.projectId;
  if (projectId && typeof req.query.project !== 'string') {
    (req.query as Record<string, string>).project = projectId;
  }
  next();
});

function handleServiceError(
  err: unknown,
  res: import('express').Response,
): boolean {
  if (err instanceof LoadTestValidationError) {
    const status =
      err.code === 'LOAD_TEST_TARGET_PROD_REFUSED'
        ? 400
        : err.code === 'LOAD_TEST_NOT_FOUND'
          ? 404
          : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

function getUserId(req: import('express').Request): string {
  return (req.user as { profile?: { oid?: string } } | undefined)?.profile?.oid ?? 'unknown';
}

/** Accept design-spec field aliases (environment / reachable) alongside FEAT-001 names. */
function parseCreateBody(body: Record<string, unknown>): CreateLoadTestTargetInput {
  const environmentLabel =
    (typeof body.environmentLabel === 'string' && body.environmentLabel) ||
    (typeof body.environment === 'string' && body.environment) ||
    '';
  const isReachable =
    typeof body.isReachable === 'boolean'
      ? body.isReachable
      : typeof body.reachable === 'boolean'
        ? body.reachable
        : undefined;
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : undefined;
  return {
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
    environmentLabel,
    isReachable,
    isActive,
  };
}

function parseUpdateBody(body: Record<string, unknown>): UpdateLoadTestTargetInput {
  const input: UpdateLoadTestTargetInput = {};
  if (typeof body.baseUrl === 'string') input.baseUrl = body.baseUrl;
  if (typeof body.environmentLabel === 'string') input.environmentLabel = body.environmentLabel;
  else if (typeof body.environment === 'string') input.environmentLabel = body.environment;
  if (typeof body.isReachable === 'boolean') input.isReachable = body.isReachable;
  else if (typeof body.reachable === 'boolean') input.isReachable = body.reachable;
  if (typeof body.isActive === 'boolean') input.isActive = body.isActive;
  return input;
}

// ── GET /api/projects/:projectId/load-test-targets ────────────────────────────

router.get(
  '/',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const includeInactive =
        req.query.includeInactive === 'true' || req.query.includeInactive === '1';
      const items = await loadTestTargetService.listTargets(projectId, { includeInactive });
      res.json({ items });
    } catch (err) {
      if (handleServiceError(err, res)) return;
      next(err);
    }
  },
);

// ── POST /api/projects/:projectId/load-test-targets ───────────────────────────

router.post(
  '/',
  requirePermission('admin:roles'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const input = parseCreateBody((req.body ?? {}) as Record<string, unknown>);
      const item = await loadTestTargetService.createTarget(projectId, input, getUserId(req));
      res.status(201).json({ item });
    } catch (err) {
      if (handleServiceError(err, res)) return;
      next(err);
    }
  },
);

// ── PATCH /api/projects/:projectId/load-test-targets/:targetId ────────────────

router.patch(
  '/:targetId',
  requirePermission('admin:roles'),
  async (req, res, next) => {
    try {
      const { projectId, targetId } = req.params;
      const input = parseUpdateBody((req.body ?? {}) as Record<string, unknown>);
      const item = await loadTestTargetService.updateTarget(
        projectId,
        targetId,
        input,
        getUserId(req),
      );
      if (!item) {
        res.status(404).json({ error: 'Target not found', code: 'LOAD_TEST_TARGET_NOT_FOUND' });
        return;
      }
      res.json({ item });
    } catch (err) {
      if (handleServiceError(err, res)) return;
      next(err);
    }
  },
);

// ── DELETE /api/projects/:projectId/load-test-targets/:targetId ───────────────

router.delete(
  '/:targetId',
  requirePermission('admin:roles'),
  async (req, res, next) => {
    try {
      const { projectId, targetId } = req.params;
      const deleted = await loadTestTargetService.deleteTarget(projectId, targetId);
      if (!deleted) {
        res.status(404).json({ error: 'Target not found', code: 'LOAD_TEST_TARGET_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      if (handleServiceError(err, res)) return;
      next(err);
    }
  },
);

export default router;
