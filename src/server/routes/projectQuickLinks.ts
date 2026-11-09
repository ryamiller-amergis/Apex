/**
 * Per-project Quick Links. Mounted at /api/projects/:projectId/quick-links from routes/api.ts.
 * Anyone assigned to the project can read; changes need quick-links:manage.
 */

import { Router, type Request } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import * as quickLinksService from '../services/projectQuickLinksService';
import type {
  CreateProjectQuickLinkInput,
  ImportQuickLinksInput,
  ReorderProjectQuickLinksInput,
  UpdateProjectQuickLinkInput,
} from '../../shared/types/projectQuickLinks';
import { quickLinkRoute as route } from './quickLinkRoute';

const router = Router({ mergeParams: true });

router.use(requireProjectAccess(resolveRequestProject));

function actorUserId(req: Request): string {
  const user = req.user as { profile?: { oid?: unknown } } | undefined;
  return typeof user?.profile?.oid === 'string' ? user.profile.oid : 'unknown';
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

router.post(
  '/import',
  requirePermission('quick-links:manage'),
  route(async (req, res) => {
    const body = (req.body ?? {}) as Partial<ImportQuickLinksInput>;
    const result = await quickLinksService.importLinks(req.params.projectId, body.items, actorUserId(req));
    res.json(result);
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
