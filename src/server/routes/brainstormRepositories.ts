import { Router } from 'express';
import { isCanonicalUuid } from '../../shared/types/durableInteractiveTurn';
import { requirePermission, requireProjectAccess, resolveRequestProject } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  addBrainstormRepository,
  BrainstormCatalogError,
  checkBrainstormRepositoryDrift,
  cloneBrainstormRepository,
  deleteBrainstormRepository,
  listBrainstormRepositories,
} from '../services/brainstormRepositoryCatalog';

const ADMIN = 'admin:roles';

function sendCatalogError(res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown, next: (err: unknown) => void): void {
  if (err instanceof BrainstormCatalogError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

export function createBrainstormRepositoriesRouter(): Router {
  const router = Router();

  router.get(
    '/repositories',
    requirePermission(ADMIN),
    requireProjectAccess(resolveRequestProject),
    async (req, res, next) => {
      try {
        const project = resolveRequestProject(req)!;
        res.json({ repositories: await listBrainstormRepositories(project) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/repositories',
    requirePermission(ADMIN),
    requireProjectAccess(resolveRequestProject),
    async (req, res, next) => {
      try {
        const project = resolveRequestProject(req)!;
        const body = req.body as { displayName?: unknown; cloneUrl?: unknown; branch?: unknown };
        const repository = await addBrainstormRepository({
          project,
          userId: getUserId(req),
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
          cloneUrl: typeof body.cloneUrl === 'string' ? body.cloneUrl : '',
          branch: typeof body.branch === 'string' ? body.branch : '',
        });
        res.status(201).json({ repository });
      } catch (err) {
        sendCatalogError(res, err, next);
      }
    },
  );

  router.post(
    '/repositories/:id/clone',
    requirePermission(ADMIN),
    requireProjectAccess(resolveRequestProject),
    async (req, res, next) => {
      try {
        if (!isCanonicalUuid(req.params.id)) {
          res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
          return;
        }
        const project = resolveRequestProject(req)!;
        const repository = await cloneBrainstormRepository(project, req.params.id);
        if (!repository) {
          res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
          return;
        }
        res.status(202).json({ repository });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/repositories/:id/drift',
    requirePermission(ADMIN),
    requireProjectAccess(resolveRequestProject),
    async (req, res, next) => {
      try {
        if (!isCanonicalUuid(req.params.id)) {
          res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
          return;
        }
        const project = resolveRequestProject(req)!;
        const drift = await checkBrainstormRepositoryDrift(project, req.params.id);
        if (!drift) {
          res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
          return;
        }
        res.status(200).json({ drift });
      } catch (err) {
        sendCatalogError(res, err, next);
      }
    },
  );

  router.delete(
    '/repositories/:id',
    requirePermission(ADMIN),
    requireProjectAccess(resolveRequestProject),
    async (req, res, next) => {
      try {
        if (!isCanonicalUuid(req.params.id)) {
          res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
          return;
        }
        const project = resolveRequestProject(req)!;
        const deleted = await deleteBrainstormRepository(project, req.params.id);
        if (!deleted) {
          res.status(404).json({ error: 'Repository not found', code: 'NOT_FOUND' });
          return;
        }
        res.status(200).json({ deleted: true, id: req.params.id });
      } catch (err) {
        sendCatalogError(res, err, next);
      }
    },
  );

  return router;
}
