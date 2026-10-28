/**
 * Per-project Quick Links. Mounted at /api/projects/:projectId/quick-links from routes/api.ts.
 * Anyone assigned to the project can read; changes need quick-links:manage.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import * as quickLinksService from '../services/projectQuickLinksService';
import {
  ProjectQuickLinkError,
  type CreateProjectQuickLinkInput,
  type ProjectQuickLinkErrorCode,
  type ReorderProjectQuickLinksInput,
  type UpdateProjectQuickLinkInput,
} from '../../shared/types/projectQuickLinks';

const router = Router({ mergeParams: true });

router.use(requireProjectAccess(resolveRequestProject));

function actorUserId(req: Request): string {
  const user = req.user as { profile?: { oid?: unknown } } | undefined;
  return typeof user?.profile?.oid === 'string' ? user.profile.oid : 'unknown';
}

function statusForCode(code: ProjectQuickLinkErrorCode): number {
  switch (code) {
    case 'VALIDATION':
      return 422;
    case 'NOT_FOUND':
      return 404;
    default: {
      const unhandled: never = code;
      return unhandled;
    }
  }
}

function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof ProjectQuickLinkError) {
        res.status(statusForCode(err.code)).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  };
}

router.get(
  '/',
  route(async (req, res) => {
    const items = await quickLinksService.listLinks(req.params.projectId);
    res.json({ items });
  }),
);

router.post(
  '/',
  requirePermission('quick-links:manage'),
  route(async (req, res) => {
    const body = (req.body ?? {}) as CreateProjectQuickLinkInput;
    const link = await quickLinksService.createLink(req.params.projectId, body, actorUserId(req));
    res.status(201).json(link);
  }),
);

router.put(
  '/order',
  requirePermission('quick-links:manage'),
  route(async (req, res) => {
    const body = (req.body ?? {}) as Partial<ReorderProjectQuickLinksInput>;
    const items = await quickLinksService.reorderLinks(
      req.params.projectId,
      body.ids,
      actorUserId(req),
    );
    res.json({ items });
  }),
);

router.patch(
  '/:id',
  requirePermission('quick-links:manage'),
  route(async (req, res) => {
    const body = (req.body ?? {}) as UpdateProjectQuickLinkInput;
    const link = await quickLinksService.updateLink(
      req.params.projectId,
      req.params.id,
      body,
      actorUserId(req),
    );
    res.json(link);
  }),
);

router.delete(
  '/:id',
  requirePermission('quick-links:manage'),
  route(async (req, res) => {
    await quickLinksService.deleteLink(req.params.projectId, req.params.id);
    res.status(204).send();
  }),
);

export default router;
