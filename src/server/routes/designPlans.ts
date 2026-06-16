import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  getPlanForPrd,
  savePlan,
  regeneratePlan,
  generatePrototypesFromPlan,
  getPlanById,
} from '../services/designPlanService';
import type { SaveDesignPlanRequest } from '../../shared/types/designPlan';

const router = Router();

function handleError(err: any, res: import('express').Response, next: import('express').NextFunction): void {
  if (err?.status === 403 || err?.status === 404 || err?.status === 409 || err?.status === 400) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

// GET /prd/:prdId — fetch the design plan for a PRD (with staleness flag)
router.get('/prd/:prdId', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const result = await getPlanForPrd(req.params.prdId);
    if (!result) {
      res.status(404).json({ error: 'Design plan not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /:id — fetch a single design plan
router.get('/:id', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const plan = await getPlanById(req.params.id);
    if (!plan) {
      res.status(404).json({ error: 'Design plan not found' });
      return;
    }
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

// PUT /:id — save reviewer edits (approver-gated)
router.put('/:id', requirePermission('design-prototypes:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as SaveDesignPlanRequest;
    const plan = await savePlan(req.params.id, body.features, userId);
    res.json(plan);
  } catch (err) {
    handleError(err, res, next);
  }
});

// POST /:id/regenerate — regenerate the plan from the current PRD backlog (approver-gated)
router.post('/:id/regenerate', requirePermission('design-prototypes:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const plan = await getPlanById(req.params.id);
    if (!plan) {
      res.status(404).json({ error: 'Design plan not found' });
      return;
    }
    await regeneratePlan(plan.prdId, userId);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res, next);
  }
});

// POST /:id/generate-prototypes — consume the plan and generate HTML prototypes (approver-gated)
router.post('/:id/generate-prototypes', requirePermission('design-prototypes:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const ids = await generatePrototypesFromPlan(req.params.id, userId);
    res.json({ ok: true, prototypeIds: ids });
  } catch (err) {
    handleError(err, res, next);
  }
});

export default router;
