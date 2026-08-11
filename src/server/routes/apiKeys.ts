/**
 * Project-scoped API key management routes — FEAT-001 / TBI-002
 * Mounted at /api/projects/:projectId/api-keys
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import * as apiKeyLifecycleService from '../services/apiKeyLifecycleService';
import {
  ApiKeyValidationError,
  type ApiKeyCadence,
  type CreateApiKeyInput,
  type UpdateApiKeyInput,
} from '../../shared/types/apiKey';

const router = Router({ mergeParams: true });

router.use(requireProjectAccess(resolveRequestProject));

function getUserId(req: Request): string {
  return (req.user as { profile?: { oid?: string } } | undefined)?.profile?.oid ?? 'unknown';
}

function handleServiceError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ApiKeyValidationError) {
    const status =
      err.code === 'NAME_TAKEN' || err.code === 'LIMIT_REACHED'
        ? 409
        : err.code === 'NOT_FOUND'
          ? 404
          : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

// GET /api/projects/:projectId/api-keys
router.get(
  '/',
  requirePermission('api-keys:manage'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const statusRaw = typeof req.query.status === 'string' ? req.query.status : 'all';
      const status =
        statusRaw === 'active' || statusRaw === 'expired' || statusRaw === 'all'
          ? statusRaw
          : 'all';
      const items = await apiKeyLifecycleService.listKeys(projectId, { status });
      res.json({ items });
    } catch (err) {
      try {
        handleServiceError(err, res, next);
      } catch {
        next(err);
      }
    }
  },
);

// POST /api/projects/:projectId/api-keys
router.post(
  '/',
  requirePermission('api-keys:manage'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const body = (req.body ?? {}) as CreateApiKeyInput;
      const result = await apiKeyLifecycleService.createKey(
        projectId,
        {
          name: body.name,
          cadence: body.cadence as ApiKeyCadence,
          scopes: body.scopes ?? [],
        },
        getUserId(req),
      );
      res.status(201).json(result);
    } catch (err) {
      try {
        handleServiceError(err, res, next);
      } catch {
        next(err);
      }
    }
  },
);

// PATCH /api/projects/:projectId/api-keys/:id
router.patch(
  '/:id',
  requirePermission('api-keys:manage'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      const body = (req.body ?? {}) as UpdateApiKeyInput;
      const key = await apiKeyLifecycleService.updateKey(projectId, id, {
        name: body.name,
        cadence: body.cadence,
        scopes: body.scopes,
      });
      res.json(key);
    } catch (err) {
      try {
        handleServiceError(err, res, next);
      } catch {
        next(err);
      }
    }
  },
);

// POST /api/projects/:projectId/api-keys/:id/regenerate
router.post(
  '/:id/regenerate',
  requirePermission('api-keys:manage'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      const result = await apiKeyLifecycleService.regenerateKey(projectId, id);
      res.json(result);
    } catch (err) {
      try {
        handleServiceError(err, res, next);
      } catch {
        next(err);
      }
    }
  },
);

// DELETE /api/projects/:projectId/api-keys/:id
router.delete(
  '/:id',
  requirePermission('api-keys:manage'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      await apiKeyLifecycleService.deleteKey(projectId, id, getUserId(req));
      res.status(204).send();
    } catch (err) {
      try {
        handleServiceError(err, res, next);
      } catch {
        next(err);
      }
    }
  },
);

export default router;
