import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import * as loadTestService from '../services/loadTestService';
import { LoadTestValidationError } from '../../shared/types/loadTest';
import loadTestRunsRouter from './loadTestRuns';

const router = Router({ mergeParams: true });

// ── Error mapper ───────────────────────────────────────────────────────────────

function handleServiceError(
  err: unknown,
  res: import('express').Response,
): void {
  if (err instanceof LoadTestValidationError) {
    const status =
      err.code === 'LOAD_TEST_ACTIVE_RUN'
        ? 409
        : err.code === 'LOAD_TEST_NOT_FOUND'
          ? 404
          : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

// ── Helper: extract userId from request ───────────────────────────────────────

function getUserId(req: import('express').Request): string {
  return (req.user as any)?.profile?.oid ?? 'unknown';
}

// ── GET /api/projects/:projectId/load-tests ───────────────────────────────────

router.get(
  '/',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const items = await loadTestService.listDefinitions(projectId);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/projects/:projectId/load-tests ──────────────────────────────────

router.post(
  '/',
  requirePermission('load-test:manage'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const userId = getUserId(req);
      const definition = await loadTestService.createDefinition(projectId, req.body, userId);
      res.status(201).json(definition);
    } catch (err) {
      try {
        handleServiceError(err, res);
      } catch {
        next(err);
      }
    }
  },
);

// ── Run lifecycle routes (FEAT-007) — enqueue, list, get, cancel, SSE, ingest ─
// Mounted before /:id so /runs is not captured as a definition id.
router.use(loadTestRunsRouter);

// ── GET /api/projects/:projectId/load-tests/:id ───────────────────────────────

router.get(
  '/:id',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      const definition = await loadTestService.getDefinition(projectId, id);
      if (!definition) {
        res.status(404).json({ error: 'Load test definition not found', code: 'LOAD_TEST_NOT_FOUND' });
        return;
      }
      res.json(definition);
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /api/projects/:projectId/load-tests/:id ─────────────────────────────

router.patch(
  '/:id',
  requirePermission('load-test:manage'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      const userId = getUserId(req);
      const definition = await loadTestService.updateDefinition(projectId, id, req.body, userId);
      res.json(definition);
    } catch (err) {
      try {
        handleServiceError(err, res);
      } catch {
        next(err);
      }
    }
  },
);

// ── DELETE /api/projects/:projectId/load-tests/:id ────────────────────────────

router.delete(
  '/:id',
  requirePermission('load-test:manage'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      const deleted = await loadTestService.deleteDefinition(projectId, id);
      if (!deleted) {
        res.status(404).json({ error: 'Load test definition not found', code: 'LOAD_TEST_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      try {
        handleServiceError(err, res);
      } catch {
        next(err);
      }
    }
  },
);

// ── GET /api/projects/:projectId/load-tests/:id/portable ─────────────────────
// Secret-free portable artifact for pipeline / CI use (PBI-005).

router.get(
  '/:id/portable',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId, id } = req.params;
      const portable = await loadTestService.getPortable(projectId, id);
      if (!portable) {
        // Consistent 404 for both missing and cross-project ids (A-010, VT-07)
        res.status(404).json({ error: 'Load test definition not found', code: 'LOAD_TEST_NOT_FOUND' });
        return;
      }
      res.json(portable);
    } catch (err) {
      next(err);
    }
  },
);

// Run lifecycle (enqueue/list/cancel/SSE/ingest) lives on loadTestRunsRouter
// mounted above — FEAT-007 replaced the 501 stub.

export default router;
