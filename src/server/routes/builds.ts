import express, { type NextFunction, type Request, type Response } from 'express';
import { requirePermission, requireProjectAccess, resolveRequestProject } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { listBuildRepositories, listBuilds, normalizeListQuery } from '../services/buildQueryService';
import { refusalOf, startBuild } from '../services/buildOrchestrator/startBuild';

const router = express.Router();

function copyProjectIdAlias(req: Request, _res: Response, next: NextFunction): void {
  const projectId = req.query.projectId;
  if ((typeof req.query.project !== 'string' || req.query.project.length === 0) && typeof projectId === 'string') {
    req.query.project = projectId;
  }
  next();
}

function requestProjectsDisagree(req: Request): boolean {
  const resolved = resolveRequestProject(req);
  const named = [
    req.query?.project,
    (req.body as { project?: unknown } | undefined)?.project,
    req.get?.('x-apex-project') ?? req.headers?.['x-apex-project'],
  ];
  return named.some((value) => typeof value === 'string' && value.length > 0 && value !== resolved);
}

router.use(copyProjectIdAlias);

router.use((req, res, next) => {
  if (requestProjectsDisagree(req)) {
    res.status(400).json({ error: 'The project in the query and the body do not match.', code: 'BAD_REQUEST' });
    return;
  }
  next();
});

const projectAccess = requireProjectAccess((req) => resolveRequestProject(req));

router.post(
  '/',
  projectAccess,
  requirePermission('builds:run', 'playbooks:run'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      const body = req.body as {
        repository?: unknown;
        prompt?: unknown;
        model?: unknown;
        clientRequestId?: unknown;
      };
      const result = await startBuild({
        requesterUserId: userId,
        project,
        repository: typeof body.repository === 'string' ? body.repository : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        model: typeof body.model === 'string' ? body.model : undefined,
        clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : '',
      });
      res.status(202).json(result);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      next(error);
    }
  },
);

router.get(
  '/repositories',
  projectAccess,
  requirePermission('builds:run', 'playbooks:run'),
  async (req, res, next) => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      res.json({ repositories: await listBuildRepositories(project) });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/',
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      const paging = normalizeListQuery(req.query);
      const result = await listBuilds({
        project,
        requesterUserId: getUserId(req),
        ...paging,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
