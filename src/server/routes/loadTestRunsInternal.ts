/**
 * Session-free ingest routes for the load-test runner (FEAT-007 / A-009).
 *
 * Mount WITHOUT ensureAuthenticated, e.g.:
 *   app.use('/api/internal/load-test-runs', loadTestRunsInternalRouter);
 *
 * Auth is requireLoadTestRunnerAuth (LT_RUNNER_CALLBACK_TOKEN) only.
 * Project scope is enforced inside loadTestRunService.ingest via projectId + runId.
 */
import { Router } from 'express';
import { requireLoadTestRunnerAuth } from '../middleware/loadTestRunnerAuth';
import * as loadTestRunService from '../services/loadTestRunService';
import { LoadTestValidationError } from '../../shared/types/loadTest';

const router = Router();

function handleServiceError(
  err: unknown,
  res: import('express').Response,
): boolean {
  if (err instanceof LoadTestValidationError) {
    const status =
      err.code === 'LOAD_TEST_ILLEGAL_TRANSITION' ||
      err.code === 'LOAD_TEST_DISPATCH_MISMATCH'
        ? 409
        : err.code === 'LOAD_TEST_NOT_FOUND'
          ? 404
          : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

/**
 * POST /api/internal/load-test-runs/:projectId/:runId/ingest
 */
router.post(
  '/:projectId/:runId/ingest',
  requireLoadTestRunnerAuth,
  async (req, res, next) => {
    try {
      const { projectId, runId } = req.params;
      const run = await loadTestRunService.ingest(projectId, runId, req.body);
      res.status(202).json({ ok: true, run });
    } catch (err) {
      if (!handleServiceError(err, res)) next(err);
    }
  },
);

export default router;
