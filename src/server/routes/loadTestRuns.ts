/**
 * Load-test run routes — FEAT-007
 *
 * Mounted under /api/projects/:projectId/load-tests (via loadTests.ts).
 *
 * Human routes: load-test:view / load-test:run
 * Ingest: requireLoadTestRunnerAuth (MI/service token) — not end-user RBAC
 */
import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { requireLoadTestRunnerAuth } from '../middleware/loadTestRunnerAuth';
import * as loadTestRunService from '../services/loadTestRunService';
import { LoadTestValidationError } from '../../shared/types/loadTest';
import { writeSseEvent, startSseHeartbeat } from '../utils/sseResponse';

const router = Router({ mergeParams: true });

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

// ── POST /:definitionId/runs — enqueue (PBI-008) ─────────────────────────────

router.post(
  '/:definitionId/runs',
  requirePermission('load-test:run'),
  async (req, res, next) => {
    try {
      const { projectId, definitionId } = req.params;
      const runSource = req.body?.runSource === 'pipeline' ? 'pipeline' : 'app';
      const run = await loadTestRunService.enqueue(projectId, definitionId, {
        runSource,
      });
      res.status(201).json({ run });
    } catch (err) {
      if (!handleServiceError(err, res)) next(err);
    }
  },
);

// ── GET /runs — list (TBI-007) ────────────────────────────────────────────────

router.get(
  '/runs',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const definitionId =
        typeof req.query.definitionId === 'string' ? req.query.definitionId : undefined;
      const status =
        typeof req.query.status === 'string'
          ? (req.query.status as import('../../shared/types/loadTest').RunStatus)
          : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = await loadTestRunService.listRuns(projectId, {
        definitionId,
        status,
        limit,
      });
      res.json(result);
    } catch (err) {
      if (!handleServiceError(err, res)) next(err);
    }
  },
);

// ── GET /runs/:runId ──────────────────────────────────────────────────────────

router.get(
  '/runs/:runId',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId, runId } = req.params;
      const run = await loadTestRunService.getRun(projectId, runId);
      if (!run) {
        res.status(404).json({
          error: 'Load test run not found',
          code: 'LOAD_TEST_NOT_FOUND',
        });
        return;
      }
      res.json({ run });
    } catch (err) {
      if (!handleServiceError(err, res)) next(err);
    }
  },
);

// ── POST /runs/:runId/cancel ──────────────────────────────────────────────────

router.post(
  '/runs/:runId/cancel',
  requirePermission('load-test:run'),
  async (req, res, next) => {
    try {
      const { projectId, runId } = req.params;
      const run = await loadTestRunService.cancel(projectId, runId);
      res.json({ run });
    } catch (err) {
      if (!handleServiceError(err, res)) next(err);
    }
  },
);

// ── GET /runs/:runId/stream — SSE (A-012 / VT-13) ─────────────────────────────

router.get(
  '/runs/:runId/stream',
  requirePermission('load-test:view'),
  async (req, res, next) => {
    try {
      const { projectId, runId } = req.params;
      const run = await loadTestRunService.getRun(projectId, runId);
      if (!run) {
        res.status(404).json({
          error: 'Load test run not found',
          code: 'LOAD_TEST_NOT_FOUND',
        });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      writeSseEvent(res, {
        type: 'status',
        runId: run.id,
        projectId: run.projectId,
        status: run.status,
        cancelRequested: run.cancelRequested,
        at: new Date().toISOString(),
      });

      const stopHeartbeat = startSseHeartbeat(res);
      const unsubscribe = loadTestRunService.subscribeRunProgress(
        projectId,
        runId,
        (event) => {
          if (!writeSseEvent(res, event)) {
            unsubscribe();
            stopHeartbeat();
          }
        },
      );

      req.on('close', () => {
        unsubscribe();
        stopHeartbeat();
      });
    } catch (err) {
      if (!handleServiceError(err, res)) next(err);
    }
  },
);

// ── POST /runs/:runId/ingest — runner callback (PBI-009) ──────────────────────

router.post(
  '/runs/:runId/ingest',
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
