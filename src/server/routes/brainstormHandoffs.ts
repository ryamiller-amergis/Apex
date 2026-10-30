/**
 * FEAT-003 — next actions and handoffs for one Brainstorm session.
 *
 * Mounted under `/api/brainstorm/sessions/:id`; `read` and `mutate` are the
 * session access handlers from `brainstorm.ts`. The engine re-checks the creator
 * and every target permission, so these routes only parse input.
 */
import { Router, type NextFunction, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { BRAINSTORM_CREATE, BRAINSTORM_VIEW } from '../../shared/types/brainstorm';
import { isCanonicalUuid } from '../../shared/types/durableInteractiveTurn';
import { BrainstormHandoffError, type HandoffEngine, type HandoffSession } from '../services/brainstormHandoffEngine';

export interface BrainstormHandoffRouteDeps {
  engine: () => Pick<HandoffEngine, 'listActions' | 'preview' | 'confirm' | 'keepStandalone' | 'getHandoff'>;
  read: RequestHandler;
  mutate: RequestHandler;
}

interface SessionRequest {
  brainstorm?: { session: HandoffSession };
}

const expectedVersion = z.number().int().min(0);
const previewBody = z.object({ actionId: z.string(), expectedVersion });
const keepBody = z.object({ expectedVersion });

function sessionOf(req: unknown): HandoffSession {
  return (req as SessionRequest).brainstorm!.session;
}

function sendHandoffError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof BrainstormHandoffError) {
    res.status(err.status).json({ error: err.code, code: err.code, ...err.details });
    return;
  }
  next(err);
}

function invalid(res: Response, code = 'INVALID_REQUEST'): void {
  res.status(400).json({ error: code, code });
}

export function createBrainstormHandoffsRouter(deps: BrainstormHandoffRouteDeps): Router {
  const router = Router({ mergeParams: true });
  const view = requirePermission(BRAINSTORM_VIEW);
  const create = requirePermission(BRAINSTORM_VIEW, BRAINSTORM_CREATE);

  router.get('/actions', view, deps.read, async (req, res, next) => {
    try {
      res.json(await deps.engine().listActions(sessionOf(req), getUserId(req)));
    } catch (err) {
      sendHandoffError(res, err, next);
    }
  });

  router.post('/handoffs/preview', create, deps.mutate, async (req, res, next) => {
    try {
      const body = previewBody.safeParse(req.body ?? {});
      if (!body.success) {
        invalid(res);
        return;
      }
      res.status(201).json(await deps.engine().preview(sessionOf(req), getUserId(req), body.data));
    } catch (err) {
      sendHandoffError(res, err, next);
    }
  });

  router.post('/handoffs/keep-standalone', create, deps.mutate, async (req, res, next) => {
    try {
      const body = keepBody.safeParse(req.body ?? {});
      if (!body.success) {
        invalid(res);
        return;
      }
      res.json(await deps.engine().keepStandalone(sessionOf(req), getUserId(req), body.data));
    } catch (err) {
      sendHandoffError(res, err, next);
    }
  });

  router.post('/handoffs/:handoffId/confirm', create, deps.mutate, async (req, res, next) => {
    try {
      if (!isCanonicalUuid(req.params.handoffId)) {
        res.status(404).json({ error: 'HANDOFF_NOT_FOUND', code: 'HANDOFF_NOT_FOUND' });
        return;
      }
      if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
        invalid(res, 'CONFIRMATION_REQUIRED');
        return;
      }
      const header = req.get('Idempotency-Key');
      const outcome = await deps.engine().confirm(sessionOf(req), getUserId(req), {
        handoffId: req.params.handoffId,
        idempotencyKey: header?.trim() || undefined,
      });
      res.status(outcome.state === 'executing' ? 202 : 200).json(outcome);
    } catch (err) {
      sendHandoffError(res, err, next);
    }
  });

  router.get('/handoffs/:handoffId', view, deps.read, async (req, res, next) => {
    try {
      if (!isCanonicalUuid(req.params.handoffId)) {
        res.status(404).json({ error: 'HANDOFF_NOT_FOUND', code: 'HANDOFF_NOT_FOUND' });
        return;
      }
      res.json(await deps.engine().getHandoff(sessionOf(req), getUserId(req), req.params.handoffId));
    } catch (err) {
      sendHandoffError(res, err, next);
    }
  });

  return router;
}
