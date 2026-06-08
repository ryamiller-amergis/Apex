import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  listPrototypes,
  listPrototypesForPrd,
  getPrototype,
  deletePrototype,
  regeneratePrototype,
  retryPrototype,
  reviewPrototype,
  listComments,
  addComment,
  resolveComment,
} from '../services/designPrototypeService';
import { getAssignments } from '../services/documentApprovalService';
import type {
  ReviewDesignPrototypeRequest,
  RegeneratePrototypeRequest,
  AddPrototypeCommentRequest,
} from '../../shared/types/designPrototype';

const router = Router();

// GET / — list all prototypes (project-wide, with optional filters)
router.get('/', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const prototypes = await listPrototypes({
      status: req.query.status as string | undefined,
      project: req.query.project as string | undefined,
      author: req.query.author as string | undefined,
      requestUserId: userId,
    });
    res.json(prototypes);
  } catch (err) {
    next(err);
  }
});

// GET /prd/:prdId — list all prototypes for a PRD
router.get('/prd/:prdId', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const prototypes = await listPrototypesForPrd(req.params.prdId);
    res.json(prototypes);
  } catch (err) {
    next(err);
  }
});

// GET /prd/:prdId/assignments — designated design-prototype approvers for the PRD
router.get('/prd/:prdId/assignments', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const assignments = await getAssignments(req.params.prdId, 'design_prototype');
    res.json(assignments);
  } catch (err) {
    next(err);
  }
});

// GET /:id — get a single prototype with full HTML + PBI requirements
router.get('/:id', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const proto = await getPrototype(req.params.id);
    if (!proto) {
      res.status(404).json({ error: 'Prototype not found' });
      return;
    }
    res.json(proto);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — delete a prototype
router.delete('/:id', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    await deletePrototype(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /:id/regenerate — regenerate with feedback
router.post('/:id/regenerate', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const body = req.body as RegeneratePrototypeRequest;
    if (!body.feedback?.trim()) {
      res.status(400).json({ error: 'Feedback is required for regeneration' });
      return;
    }
    await regeneratePrototype(req.params.id, body.feedback.trim());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /:id/retry — retry a failed generation
router.post('/:id/retry', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    await retryPrototype(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /:id/review — approve or request revision
router.post('/:id/review', requirePermission('design-prototypes:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as ReviewDesignPrototypeRequest;
    await reviewPrototype(req.params.id, userId, body.action, body.comment);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.status === 403) {
      res.status(403).json({ error: err.message });
      return;
    }
    if (err.status === 409) {
      res.status(409).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// GET /:id/comments — list comments for a prototype
router.get('/:id/comments', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const comments = await listComments(req.params.id);
    res.json(comments);
  } catch (err) {
    next(err);
  }
});

// POST /:id/comments — add a comment
router.post('/:id/comments', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as AddPrototypeCommentRequest;
    if (!body.text?.trim()) {
      res.status(400).json({ error: 'Comment text is required' });
      return;
    }
    const comment = await addComment(
      req.params.id,
      userId,
      body.text.trim(),
      body.mockVersion,
      body.pinX,
      body.pinY,
    );
    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// POST /comments/:commentId/resolve — resolve a comment
router.post('/comments/:commentId/resolve', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await resolveComment(req.params.commentId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
