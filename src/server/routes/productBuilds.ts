import { Router, type NextFunction, type Request, type Response } from 'express';
import { APEX_PROJECT } from '../services/rfpIntakeService';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getProductSetup, ProductFoundationError } from '../services/productSetupService';
import {
  draftProductFoundation,
  reviseProductFoundation,
  saveProductFoundation,
} from '../services/productFoundationDraftService';
import {
  approveProductBuild,
  ProductBuildError,
  regenerateProductPrototype,
  startNextProductBuild,
  syncProductBuild,
} from '../services/productBuildService';
import { getDisplayName, getUserId } from '../utils/requestUser';

const router = Router();

async function requireRfpIntakeFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled('rfp-intake', {
      userId,
      project: APEX_PROJECT,
    });
    // @feature-flag:rfp-intake start winner=enabled
    if (!enabled) {
      // @feature-flag:rfp-intake disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:rfp-intake disabled-end
    }
    // @feature-flag:rfp-intake enabled-start
    if (userId === 'anonymous') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
    // @feature-flag:rfp-intake enabled-end
    // @feature-flag:rfp-intake end
  } catch (err) {
    next(err);
  }
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof ProductBuildError || err instanceof ProductFoundationError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[product-builds]', err instanceof Error ? err.stack ?? err.message : err);
  res.status(500).json({ error: 'Internal server error' });
}

function setupActor(req: Request): { userId: string; answeredBy: string } {
  const displayName = getDisplayName(req).trim();
  return {
    userId: getUserId(req),
    answeredBy: displayName && displayName !== 'Unknown User' ? displayName : 'Project admin',
  };
}

function requireProject(body: { project?: unknown } | undefined, res: Response): string | null {
  const project = typeof body?.project === 'string' ? body.project.trim() : '';
  if (!project) {
    res.status(400).json({ error: 'project is required' });
    return null;
  }
  return project;
}

router.use(requireRfpIntakeFlag);

router.get('/setup', async (req: Request, res: Response): Promise<void> => {
  try {
    const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    res.json(await getProductSetup(project, getUserId(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/foundation/draft', async (req: Request, res: Response): Promise<void> => {
  try {
    const project = requireProject(req.body, res);
    if (!project) return;
    const actor = setupActor(req);
    const markdown = await draftProductFoundation({
      project,
      userId: actor.userId,
      answeredBy: actor.answeredBy,
      answers: req.body?.answers,
    });
    res.json({ markdown });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/foundation/revise', async (req: Request, res: Response): Promise<void> => {
  try {
    const project = requireProject(req.body, res);
    if (!project) return;
    const actor = setupActor(req);
    const markdown = await reviseProductFoundation({
      project,
      userId: actor.userId,
      answeredBy: actor.answeredBy,
      draft: req.body?.draft,
      changes: req.body?.changes,
    });
    res.json({ markdown });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/foundation/save', async (req: Request, res: Response): Promise<void> => {
  try {
    const project = requireProject(req.body, res);
    if (!project) return;
    const actor = setupActor(req);
    await saveProductFoundation({
      project,
      userId: actor.userId,
      answeredBy: actor.answeredBy,
      markdown: req.body?.markdown,
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/next', async (req: Request, res: Response): Promise<void> => {
  try {
    const project = requireProject(req.body, res);
    if (!project) return;
    res.json(await startNextProductBuild(project, getUserId(req), req.body?.prompt));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await syncProductBuild(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/prototype/regenerate', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await regenerateProductPrototype(req.params.id, getUserId(req), req.body?.feedback));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:id/approve', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await approveProductBuild(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
