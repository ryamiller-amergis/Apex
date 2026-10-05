import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { requirePermission, requireGroupMembership } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { getMenuConfig } from '../services/menuSettingsService';
import {
  listDesigns,
  listSharedDesigns,
  getDesignProject,
  getCommentProject,
  createDesign,
  deleteDesign,
  saveHtml,
  runGeneration,
  runRegeneration,
  listComments,
  addComment,
  resolveComment,
  reopenComment,
  resolveDesignAccess,
  requireManageAccess,
  listDesignShares,
  listDesignShareTargets,
  createDesignShare,
  revokeDesignShare,
  UiLabForbiddenError,
  UiLabNotFoundError,
  UiLabValidationError,
} from '../services/uiLabService';
import type {
  CreateUiLabDesignRequest,
  RegenerateUiLabDesignRequest,
  AddUiLabCommentRequest,
  CreateUiLabShareRequest,
} from '../../shared/types/uiLab';

const router = Router();

/**
 * Resolves the project a request targets. Returns undefined when the project
 * cannot be determined (e.g. missing param or a record that doesn't exist), in
 * which case enforcement defers to the route handler's own 400/404 handling.
 */
type ProjectResolver = (req: Request) => Promise<string | null | undefined> | string | null | undefined;

async function isUiLabEnabled(project: string): Promise<boolean> {
  const config = await getMenuConfig(project);
  return !!config && config.enabledViews.includes('ui-lab');
}

/**
 * Blocks a request when `ui-lab` is not enabled in the target project's menu
 * settings. Super admins always bypass, mirroring the RBAC middleware.
 */
function requireUiLabEnabled(resolveProject: ProjectResolver): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (isSuperAdminRequest(req)) {
        next();
        return;
      }
      const project = await resolveProject(req);
      if (!project) {
        // Let the route handler surface the appropriate 400/404 for the
        // missing project param or non-existent record.
        next();
        return;
      }
      if (!(await isUiLabEnabled(project))) {
        res.status(403).json({ error: 'UI Lab is not enabled for this project' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Permissions resolve per project, but the record-scoped routes below carry no
 * project param, so `requirePermission` would fall back to global roles and
 * reject a user whose UI Lab access comes from a project-scoped role. Resolve
 * the owning project from the record first so the middleware scopes to the same
 * project the service layer authorizes against.
 */
function withRecordProject(resolveProject: ProjectResolver): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const project = await resolveProject(req);
      if (project) {
        req.headers['x-apex-project'] = project;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function handleServiceError(err: unknown, res: Response, next: NextFunction): void {
  if (
    err instanceof UiLabForbiddenError
    || err instanceof UiLabNotFoundError
    || err instanceof UiLabValidationError
  ) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

const requireUiUxGroup = requireGroupMembership('UI/UX');

const uiLabEnabledFromQuery = requireUiLabEnabled((req) => req.query.project as string | undefined);
const uiLabEnabledFromBody = requireUiLabEnabled(
  (req) => (req.body as { project?: string } | undefined)?.project,
);
const uiLabEnabledFromDesignId = requireUiLabEnabled((req) => getDesignProject(req.params.id));
const uiLabEnabledFromCommentId = requireUiLabEnabled((req) => getCommentProject(req.params.commentId));

const projectFromDesignId = withRecordProject((req) => getDesignProject(req.params.id));
const projectFromCommentId = withRecordProject((req) => getCommentProject(req.params.commentId));

// GET / — list designs for a project (UI/UX workspace only)
router.get('/', requirePermission('ui-lab:view'), requireUiUxGroup, uiLabEnabledFromQuery, async (req, res, next) => {
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

// GET /shared-with-me — designs shared with the caller. No UI/UX gate: this is
// the entry point for named viewers, who never see the workspace list. Declared
// before `/:id` so the literal path is not captured as a design id.
router.get('/shared-with-me', requirePermission('ui-lab:view'), uiLabEnabledFromQuery, async (req, res, next) => {
  try {
    const project = req.query.project as string | undefined;
    if (!project) {
      res.status(400).json({ error: 'project query param is required' });
      return;
    }
    const designs = await listSharedDesigns(project, getUserId(req));
    res.json(designs);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

// POST / — create a new design (kicks off async generation via SSE)
router.post('/', requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromBody, async (req, res, next) => {
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

// GET /:id — get a single design (workspace OR named share)
router.get('/:id', projectFromDesignId, requirePermission('ui-lab:view'), uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { design } = await resolveDesignAccess(req.params.id, userId, {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    res.json(design);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

// DELETE /:id
router.delete('/:id', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await requireManageAccess(req.params.id, userId, { isSuperAdmin: isSuperAdminRequest(req) });
    await deleteDesign(req.params.id);
    res.status(204).send();
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

// PATCH /:id/html — manual HTML edit (from BoundaryEditor); managers only
router.patch('/:id/html', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await requireManageAccess(req.params.id, userId, { isSuperAdmin: isSuperAdminRequest(req) });
    const { html } = req.body as { html?: string };
    if (typeof html !== 'string') {
      res.status(400).json({ error: 'html string is required' });
      return;
    }
    const updated = await saveHtml(req.params.id, html);
    res.json(updated);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

// GET /:id/stream — SSE endpoint for initial generation (managers only)
router.get('/:id/stream', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res) => {
  const { id } = req.params;
  const userId = getUserId(req);

  try {
    await requireManageAccess(id, userId, { isSuperAdmin: isSuperAdminRequest(req) });
  } catch (err) {
    const status = err instanceof UiLabForbiddenError || err instanceof UiLabNotFoundError
      ? err.status
      : 500;
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message });
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
    await runGeneration(id, (chunk) => {
      send('token', { text: chunk });
    }, (req.user as any)?.profile?.oid as string | undefined);
    send('complete', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send('error', { error: message });
  } finally {
    res.end();
  }
});

// POST /:id/regenerate — SSE-capable regeneration (managers only)
router.post('/:id/regenerate', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res) => {
  const { id } = req.params;
  const body = req.body as RegenerateUiLabDesignRequest;
  const userId = getUserId(req);

  if (!body.feedback) {
    res.status(400).json({ error: 'feedback is required' });
    return;
  }

  try {
    await requireManageAccess(id, userId, { isSuperAdmin: isSuperAdminRequest(req) });
  } catch (err) {
    const status = err instanceof UiLabForbiddenError || err instanceof UiLabNotFoundError
      ? err.status
      : 500;
    const message = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: message });
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
    }, (req.user as any)?.profile?.oid as string | undefined);
    send('complete', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send('error', { error: message });
  } finally {
    res.end();
  }
});

// GET /:id/comments — workspace OR named share
router.get('/:id/comments', projectFromDesignId, requirePermission('ui-lab:view'), uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await resolveDesignAccess(req.params.id, userId, { isSuperAdmin: isSuperAdminRequest(req) });
    const comments = await listComments(req.params.id);
    res.json(comments);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

// POST /:id/comments — any authorized viewer (workspace or shared) can comment
router.post('/:id/comments', projectFromDesignId, requirePermission('ui-lab:view'), uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await resolveDesignAccess(req.params.id, userId, { isSuperAdmin: isSuperAdminRequest(req) });
    const body = req.body as AddUiLabCommentRequest;
    if (!body.text || body.version == null) {
      res.status(400).json({ error: 'text and version are required' });
      return;
    }
    const comment = await addComment(req.params.id, userId, body);
    res.status(201).json(comment);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

// POST /comments/:commentId/resolve — managers only
router.post('/comments/:commentId/resolve', projectFromCommentId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromCommentId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const project = await getCommentProject(req.params.commentId);
    if (!project) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Comment resolve is workspace-manage gated via middleware; design-level check is via group+permission.
    await resolveComment(req.params.commentId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /comments/:commentId/reopen — managers only
router.post('/comments/:commentId/reopen', projectFromCommentId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromCommentId, async (req, res, next) => {
  try {
    await reopenComment(req.params.commentId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Share management (managers / super admins) ───────────────────────────────

router.get('/:id/shares', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const shares = await listDesignShares(req.params.id, userId, {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    res.json(shares);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

router.get('/:id/share-targets', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const targets = await listDesignShareTargets(req.params.id, query, userId, {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    res.json(targets);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

router.post('/:id/shares', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as CreateUiLabShareRequest;
    const share = await createDesignShare(req.params.id, body?.granteeId, userId, {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    res.status(201).json(share);
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

router.delete('/:id/shares/:granteeId', projectFromDesignId, requirePermission('ui-lab:manage'), requireUiUxGroup, uiLabEnabledFromDesignId, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await revokeDesignShare(req.params.id, req.params.granteeId, userId, {
      isSuperAdmin: isSuperAdminRequest(req),
    });
    res.status(204).send();
  } catch (err) {
    handleServiceError(err, res, next);
  }
});

export default router;
