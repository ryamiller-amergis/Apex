/**
 * The current user's personal Quick Links for one project.
 * Mounted at /api/projects/:projectId/my-quick-links from routes/api.ts.
 * The owner is always the authenticated user; a user id in the body is ignored.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import * as userQuickLinksService from '../services/userQuickLinksService';
import type {
  CreateUserQuickLinkInput,
  ImportUserQuickLinksInput,
  UpdateUserQuickLinkInput,
} from '../../shared/types/projectQuickLinks';
import { quickLinkRoute as route } from './quickLinkRoute';

const router = Router({ mergeParams: true });

function authUserId(req: Request): string {
  const user = req.user as { profile?: { oid?: unknown } } | undefined;
  return typeof user?.profile?.oid === 'string' ? user.profile.oid : '';
}

function requireUserId(req: Request, res: Response, next: NextFunction): void {
  if (!authUserId(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.use(requireProjectAccess(resolveRequestProject));
router.use(requirePermission('quick-links:personal'));
router.use(requireUserId);

router.get(
  '/',
  route(async (req, res) => {
    const items = await userQuickLinksService.listUserLinks(authUserId(req), req.params.projectId);
    res.json({ items });
  }),
);

router.post(
  '/',
  route(async (req, res) => {
    const body = (req.body ?? {}) as CreateUserQuickLinkInput;
    const link = await userQuickLinksService.createUserLink(authUserId(req), req.params.projectId, {
      label: body.label,
      url: body.url,
      category: body.category,
    });
    res.status(201).json(link);
  }),
);

router.post(
  '/import',
  route(async (req, res) => {
    const body = (req.body ?? {}) as Partial<ImportUserQuickLinksInput>;
    const result = await userQuickLinksService.importUserLinks(
      authUserId(req),
      req.params.projectId,
      body.items,
    );
    res.json(result);
  }),
);

router.patch(
  '/:id',
  route(async (req, res) => {
    const body = (req.body ?? {}) as UpdateUserQuickLinkInput;
    const link = await userQuickLinksService.updateUserLink(
      authUserId(req),
      req.params.projectId,
      req.params.id,
      { label: body.label, url: body.url, category: body.category },
    );
    res.json(link);
  }),
);

router.delete(
  '/:id',
  route(async (req, res) => {
    await userQuickLinksService.deleteUserLink(authUserId(req), req.params.projectId, req.params.id);
    res.status(204).send();
  }),
);

export default router;
