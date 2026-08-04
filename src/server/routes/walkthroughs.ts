/**
 * Authenticated project-scoped Walkthrough routes (FEAT-001 TBI-002).
 * Mount at /api/projects/:projectId/walkthroughs
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import * as walkthroughService from '../services/walkthroughService';
import { getUserId } from '../utils/requestUser';
import {
  WalkthroughDomainError,
  type UpdateWalkthroughProgressRequest,
} from '../../shared/types/walkthrough';

const router = Router({ mergeParams: true });

function mapDomainError(err: unknown, res: Response): boolean {
  if (!(err instanceof WalkthroughDomainError)) return false;
  switch (err.code) {
    case 'WALKTHROUGH_NOT_FOUND':
    case 'INACCESSIBLE':
      res.status(404).json({ error: err.message, code: err.code });
      return true;
    case 'REVISION_CONFLICT':
      res.status(409).json({ error: err.message, code: err.code });
      return true;
    case 'INVALID_TRANSITION':
    case 'INVALID_TARGET':
    case 'INVALID_PROGRESS':
    case 'VALIDATION_ERROR':
      res.status(422).json({ error: err.message, code: err.code });
      return true;
    default:
      res.status(400).json({ error: err.message, code: err.code });
      return true;
  }
}

function projectIdOf(req: Request): string {
  return req.params.projectId;
}

function callerId(req: Request): string {
  const id = getUserId(req);
  if (!id) {
    throw new WalkthroughDomainError('INACCESSIBLE', 'Authenticated user required');
  }
  return id;
}

// GET /next — one eligible Walkthrough or null
router.get('/next', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = callerId(req);
    const projectId = projectIdOf(req);
    // FEAT-007: reconcile newly included audience members before eligibility.
    try {
      const { reconcileForUser } = await import('../services/walkthroughNotificationService');
      await reconcileForUser(userId, projectId);
    } catch {
      // Delivery failures must not block eligibility reads.
    }
    const walkthrough = await walkthroughService.getNextEligible(projectId, userId);
    res.json({ walkthrough });
  } catch (err) {
    if (mapDomainError(err, res)) return;
    next(err);
  }
});

// GET /replay — New + Acknowledged list for live audience
router.get('/replay', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = callerId(req);
    const projectId = projectIdOf(req);
    // FEAT-007: reconcile newly included audience members before replay list.
    try {
      const { reconcileForUser } = await import('../services/walkthroughNotificationService');
      await reconcileForUser(userId, projectId);
    } catch {
      // Delivery failures must not block replay reads.
    }
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const page = await walkthroughService.listReplay(projectId, userId, {
      cursor,
      limit,
    });
    res.json(page);
  } catch (err) {
    if (mapDomainError(err, res)) return;
    next(err);
  }
});

// GET /:id — single accessible definition (404 for cross-project / removed audience)
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const walkthrough = await walkthroughService.getAccessibleDefinition(
      projectIdOf(req),
      req.params.id,
      callerId(req),
    );
    res.json(walkthrough);
  } catch (err) {
    if (mapDomainError(err, res)) return;
    next(err);
  }
});

// PUT /:id/progress — caller-owned progress only (no writable userId in body)
router.put('/:id/progress', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const body = req.body as UpdateWalkthroughProgressRequest & { userId?: string };
    // Ignore any client-supplied userId — ownership is server-derived (VT-10 / DoD)
    const { userId: _ignored, ...safeBody } = body ?? {};
    void _ignored;
    const progress = await walkthroughService.updateOwnProgress(
      projectIdOf(req),
      req.params.id,
      callerId(req),
      safeBody as UpdateWalkthroughProgressRequest,
    );
    res.json(progress);
  } catch (err) {
    if (mapDomainError(err, res)) return;
    next(err);
  }
});

// POST /:id/steps/:stepId/anchor-misses — durable idempotent miss (FEAT-005 + FEAT-008)
router.post(
  '/:id/steps/:stepId/anchor-misses',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as {
        occurrenceId?: string;
        revision?: number;
        anchorKey?: string;
        targetRoute?: string;
        reason?: string;
        userId?: string;
      };
      const { userId: _ignored, ...safeBody } = body;
      void _ignored;
      const result = await walkthroughService.recordAnchorMiss(
        projectIdOf(req),
        req.params.id,
        req.params.stepId,
        callerId(req),
        {
          occurrenceId: String(safeBody.occurrenceId ?? ''),
          revision: Number(safeBody.revision),
          anchorKey: String(safeBody.anchorKey ?? ''),
          targetRoute: String(safeBody.targetRoute ?? ''),
          reason: typeof safeBody.reason === 'string' ? safeBody.reason : undefined,
        },
      );
      res.status(202).json(result);
    } catch (err) {
      if (mapDomainError(err, res)) return;
      next(err);
    }
  },
);

export default router;
