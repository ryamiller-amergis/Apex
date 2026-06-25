import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  listDesigns,
  getDesign,
  createDesign,
  deleteDesign,
  saveHtml,
  runGeneration,
  runRegeneration,
  listComments,
  addComment,
  resolveComment,
  reopenComment,
} from '../services/uiLabService';
import type {
  CreateUiLabDesignRequest,
  RegenerateUiLabDesignRequest,
  AddUiLabCommentRequest,
} from '../../shared/types/uiLab';

const router = Router();

// GET / — list designs for a project
router.get('/', requirePermission('ui-lab:view'), async (req, res, next) => {
  try {
    const project = req.query.project as string | undefined;
    if (!project) {
      res.status(400).json({ error: 'project query param is required' });
      return;
    }
    const designs = await listDesigns(project);
    res.json(designs);
  } catch (err) {
    next(err);
  }
});

// POST / — create a new design (kicks off async generation via SSE)
router.post('/', requirePermission('ui-lab:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as CreateUiLabDesignRequest & { project?: string };
    if (!body.project || !body.title || !body.prompt) {
      res.status(400).json({ error: 'project, title, and prompt are required' });
      return;
    }
    const design = await createDesign(body.project, userId, {
      title: body.title,
      prompt: body.prompt,
      targetRoute: body.targetRoute,
    });
    res.status(201).json(design);
  } catch (err) {
    next(err);
  }
});

// GET /:id — get a single design (full HTML)
router.get('/:id', requirePermission('ui-lab:view'), async (req, res, next) => {
  try {
    const design = await getDesign(req.params.id);
    if (!design) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(design);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id
router.delete('/:id', requirePermission('ui-lab:manage'), async (req, res, next) => {
  try {
    await deleteDesign(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PATCH /:id/html — manual HTML edit (from BoundaryEditor)
router.patch('/:id/html', requirePermission('ui-lab:manage'), async (req, res, next) => {
  try {
    const { html } = req.body as { html?: string };
    if (typeof html !== 'string') {
      res.status(400).json({ error: 'html string is required' });
      return;
    }
    await saveHtml(req.params.id, html);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /:id/stream — SSE endpoint for initial generation
router.get('/:id/stream', requirePermission('ui-lab:view'), async (req, res) => {
  const { id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (type: string, data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    await runGeneration(id, (chunk) => {
      send('token', { text: chunk });
    });
    send('complete', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send('error', { error: message });
  } finally {
    res.end();
  }
});

// POST /:id/regenerate — SSE-capable regeneration (whole design or scoped element)
router.post('/:id/regenerate', requirePermission('ui-lab:manage'), async (req, res) => {
  const { id } = req.params;
  const body = req.body as RegenerateUiLabDesignRequest;

  if (!body.feedback) {
    res.status(400).json({ error: 'feedback is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (type: string, data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    await runRegeneration(id, body, (chunk) => {
      send('token', { text: chunk });
    });
    send('complete', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send('error', { error: message });
  } finally {
    res.end();
  }
});

// GET /:id/comments
router.get('/:id/comments', requirePermission('ui-lab:view'), async (req, res, next) => {
  try {
    const comments = await listComments(req.params.id);
    res.json(comments);
  } catch (err) {
    next(err);
  }
});

// POST /:id/comments
router.post('/:id/comments', requirePermission('ui-lab:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as AddUiLabCommentRequest;
    if (!body.text || body.version == null) {
      res.status(400).json({ error: 'text and version are required' });
      return;
    }
    const comment = await addComment(req.params.id, userId, body);
    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// POST /comments/:commentId/resolve
router.post('/comments/:commentId/resolve', requirePermission('ui-lab:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await resolveComment(req.params.commentId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /comments/:commentId/reopen
router.post('/comments/:commentId/reopen', requirePermission('ui-lab:manage'), async (req, res, next) => {
  try {
    await reopenComment(req.params.commentId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
