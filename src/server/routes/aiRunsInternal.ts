/**
 * Session-free internal ingest for the background AI runner (FEAT-004).
 *
 * Mount without ensureAuthenticated. Runner identity is enforced here and
 * project/run scope plus dispatch fencing are enforced by aiRunIngestService.
 */
import { Router } from 'express';
import { requireAiRunnerAuth } from '../middleware/aiRunnerAuth';
import {
  AiRunIngestError,
  getBootstrap,
  ingest,
} from '../services/aiRunIngestService';

const router = Router();

function handleServiceError(
  error: unknown,
  res: import('express').Response,
): boolean {
  if (!(error instanceof AiRunIngestError)) return false;

  const status =
    error.code === 'AI_RUN_DISPATCH_MISMATCH'
    || error.code === 'AI_RUN_ILLEGAL_TRANSITION'
      ? 409
      : error.code === 'AI_RUN_NOT_FOUND'
        ? 404
        : 422;
  res.status(status).json({ error: error.message, code: error.code });
  return true;
}

router.get(
  '/:runId/bootstrap',
  requireAiRunnerAuth,
  async (req, res, next) => {
    try {
      const dispatchMessageId =
        typeof req.query.dispatchMessageId === 'string'
          ? req.query.dispatchMessageId
          : '';
      const result = await getBootstrap(req.params.runId, dispatchMessageId);
      res.status(200).json(result);
    } catch (error) {
      if (!handleServiceError(error, res)) next(error);
    }
  },
);

router.post(
  '/:projectId/:runId/ingest',
  requireAiRunnerAuth,
  async (req, res, next) => {
    try {
      const { projectId, runId } = req.params;
      const result = await ingest(projectId, runId, req.body);
      res.status(202).json({
        ok: true,
        cancelRequested: result.cancelRequested,
        run: result.run,
      });
    } catch (error) {
      if (!handleServiceError(error, res)) next(error);
    }
  },
);

export default router;
