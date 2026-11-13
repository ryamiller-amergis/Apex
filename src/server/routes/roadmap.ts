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
import { getDisplayName, getUserId } from '../utils/requestUser';
import { adoWriteForRequest, isAdoUserAuthError } from '../services/adoFactory';
import * as roadmapService from '../services/roadmapService';
import { RoadmapServiceError } from '../services/roadmapService';
import type {
  CreateRoadmapAdhocIdeaInput,
  PromoteRoadmapAdhocIdeaInput,
  UpdateRoadmapAdhocIdeaInput,
  UpdateRoadmapSettingsInput,
  UpsertRoadmapOverlayInput,
} from '../../shared/types/roadmap';

const router = Router({ mergeParams: true });

router.use(requireProjectAccess(resolveRequestProject));
router.use(requirePermission('planning:roadmap'));

function actorFromRequest(req: Request): roadmapService.RoadmapActor {
  return {
    actorId: getUserId(req),
    actorName: getDisplayName(req),
  };
}

function mapError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof RoadmapServiceError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (isAdoUserAuthError(error)) {
    res.status(403).json({ error: error.message });
    return;
  }
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Request failed',
    });
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
      mapError(error, res, next);
    }
  };
}

async function ensurePermission(
  req: Request,
  res: Response,
  permissionKey: string,
): Promise<boolean> {
  const middleware = requirePermission(permissionKey);
  let passed = false;
  let forwardedError: unknown;
  await Promise.resolve(
    middleware(req, res, (err?: unknown) => {
      if (err) {
        forwardedError = err;
        return;
      }
      passed = true;
    }),
  );
  if (forwardedError) {
    throw forwardedError;
  }
  return passed && !res.headersSent;
}

router.get(
  '/',
  route(async (req, res) => {
    const workspace = await roadmapService.getRoadmapWorkspace(
      req.params.projectId,
    );
    res.json(workspace);
  }),
);

router.put(
  '/settings',
  requirePermission('workitems:write'),
  route(async (req, res) => {
    const body = (req.body ?? {}) as UpdateRoadmapSettingsInput;
    const settings = await roadmapService.updateRoadmapSettings(
      req.params.projectId,
      body,
      getUserId(req),
    );
    res.json(settings);
  }),
);

router.put(
  '/overlays/:workItemId',
  route(async (req, res) => {
    const workItemId = Number(req.params.workItemId);
    const body = (req.body ?? {}) as UpsertRoadmapOverlayInput;
    const project = req.params.projectId;

    const result = await roadmapService.upsertRoadmapOverlay(
      project,
      workItemId,
      body,
      actorFromRequest(req),
      async ({ workItemId: targetWorkItemId, targetDate, historyComment }) => {
        const permitted = await ensurePermission(req, res, 'workitems:write');
        if (!permitted) {
          throw new RoadmapServiceError('Forbidden', 403);
        }
        const adoService = await adoWriteForRequest(
          req,
          project,
          body.areaPath || project,
        );
        await adoService.updateWorkItemField(
          targetWorkItemId,
          'targetDate',
          targetDate,
        );
        await adoService.updateWorkItemField(
          targetWorkItemId,
          'System.History',
          historyComment,
        );
      },
    );

    if (res.headersSent) return;
    res.json(result);
  }),
);

router.post(
  '/ideas',
  route(async (req, res) => {
    const body = (req.body ?? {}) as CreateRoadmapAdhocIdeaInput;
    const result = await roadmapService.createRoadmapIdea(
      req.params.projectId,
      body,
      actorFromRequest(req),
    );
    res.status(201).json(result);
  }),
);

router.patch(
  '/ideas/:ideaId',
  route(async (req, res) => {
    const body = (req.body ?? {}) as UpdateRoadmapAdhocIdeaInput;
    const result = await roadmapService.updateRoadmapIdea(
      req.params.projectId,
      req.params.ideaId,
      body,
      actorFromRequest(req),
    );
    res.json(result);
  }),
);

router.delete(
  '/ideas/:ideaId',
  route(async (req, res) => {
    await roadmapService.deleteRoadmapIdea(
      req.params.projectId,
      req.params.ideaId,
      getUserId(req),
    );
    res.status(204).send();
  }),
);

router.post(
  '/ideas/:ideaId/promote',
  route(async (req, res) => {
    const body = (req.body ?? {}) as PromoteRoadmapAdhocIdeaInput;
    const project = req.params.projectId;

    if (body.target === 'ado-epic') {
      const permitted = await ensurePermission(req, res, 'workitems:write');
      if (!permitted) return;
    }

    const result = await roadmapService.promoteRoadmapIdea(
      project,
      req.params.ideaId,
      body,
      actorFromRequest(req),
      async ({ title, description }) => {
        const adoService = await adoWriteForRequest(
          req,
          project,
          body.areaPath || project,
        );
        const created = await adoService.createWorkItemForPrd({
          type: 'Epic',
          title,
          description,
        });
        return created;
      },
    );

    if (res.headersSent) return;
    res.status(201).json(result);
  }),
);

export default router;
