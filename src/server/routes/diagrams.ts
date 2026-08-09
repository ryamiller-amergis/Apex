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
import { DiagramServiceError } from '../../shared/types/diagram';
import * as diagramService from '../services/diagramService';

const router = Router({ mergeParams: true });

router.use(requireProjectAccess(resolveRequestProject));

function actorUserId(req: Request): string {
  const user = req.user as { profile?: { oid?: unknown } } | undefined;
  return typeof user?.profile?.oid === 'string' ? user.profile.oid : '';
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number(value);
}

function mapServiceError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof DiagramServiceError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  next(error);
}

function route(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      mapServiceError(error, res, next);
    }
  };
}

router.get(
  '/',
  requirePermission('diagram:view'),
  route(async (req, res) => {
    const result = await diagramService.listDiagrams(
      req.params.projectId,
      {
        scope: req.query.scope as 'owned' | 'shared',
        limit: parseOptionalInteger(req.query.limit),
        offset: parseOptionalInteger(req.query.offset),
      },
      actorUserId(req),
    );
    res.json(result);
  }),
);

router.post(
  '/',
  requirePermission('diagram:create'),
  route(async (req, res) => {
    const result = await diagramService.createDiagram(
      req.params.projectId,
      req.body,
      actorUserId(req),
    );
    res.status(201).json(result);
  }),
);

// Register static collection routes before /:id.
router.get(
  '/:id/share-targets',
  requirePermission('diagram:share'),
  route(async (req, res) => {
    const members = await diagramService.listShareTargets(
      req.params.projectId,
      req.params.id,
      typeof req.query.query === 'string' ? req.query.query : '',
      actorUserId(req),
    );
    res.json({ members });
  }),
);

router.get(
  '/:id',
  requirePermission('diagram:view'),
  route(async (req, res) => {
    const result = await diagramService.getDiagram(
      req.params.projectId,
      req.params.id,
      actorUserId(req),
    );
    res.json(result);
  }),
);

router.put(
  '/:id',
  requirePermission('diagram:edit'),
  route(async (req, res) => {
    const result = await diagramService.updateDiagram(
      req.params.projectId,
      req.params.id,
      req.body,
      actorUserId(req),
    );
    res.json(result);
  }),
);

router.delete(
  '/:id',
  requirePermission('diagram:delete'),
  route(async (req, res) => {
    await diagramService.deleteDiagram(
      req.params.projectId,
      req.params.id,
      actorUserId(req),
    );
    res.status(204).send();
  }),
);

router.get(
  '/:id/shares',
  requirePermission('diagram:share'),
  route(async (req, res) => {
    const shares = await diagramService.listShares(
      req.params.projectId,
      req.params.id,
      actorUserId(req),
    );
    res.json({ shares });
  }),
);

router.post(
  '/:id/shares',
  requirePermission('diagram:share'),
  route(async (req, res) => {
    const share = await diagramService.createShare(
      req.params.projectId,
      req.params.id,
      req.body,
      actorUserId(req),
    );
    res.status(201).json(share);
  }),
);

router.patch(
  '/:id/shares/:granteeId',
  requirePermission('diagram:share'),
  route(async (req, res) => {
    const share = await diagramService.updateShare(
      req.params.projectId,
      req.params.id,
      req.params.granteeId,
      req.body,
      actorUserId(req),
    );
    res.json(share);
  }),
);

router.delete(
  '/:id/shares/:granteeId',
  requirePermission('diagram:share'),
  route(async (req, res) => {
    await diagramService.revokeShare(
      req.params.projectId,
      req.params.id,
      req.params.granteeId,
      actorUserId(req),
    );
    res.status(204).send();
  }),
);

export default router;
