import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';

const router = Router({ mergeParams: true });

/**
 * GET /api/projects/:projectId/load-tests
 *
 * Stub list endpoint for FEAT-003 acceptance criteria.
 * Returns an empty item list until FEAT-004 replaces this handler with
 * loadTestService.listDefinitions(). Permission enforcement is live now so
 * callers without load-test:view receive 403 before any data is returned.
 */
router.get(
  '/',
  requirePermission('load-test:view'),
  (_req, res) => {
    res.json({ items: [] });
  },
);

/**
 * POST /api/projects/:projectId/load-tests/:definitionId/runs
 *
 * Stub enqueue endpoint for FEAT-003 acceptance criteria (d).
 * Callers without load-test:run receive 403 and no load_test_run row is
 * created. Callers with the permission receive 501 until FEAT-007 ships
 * loadTestRunService.enqueue().
 */
router.post(
  '/:definitionId/runs',
  requirePermission('load-test:run'),
  (_req, res) => {
    res.status(501).json({ error: 'Run execution not yet implemented' });
  },
);

export default router;
