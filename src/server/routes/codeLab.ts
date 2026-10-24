import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CODE_LAB_FLAG_KEY,
  CODE_LAB_PERMISSION,
  type StartCodeLabSessionRequest,
} from '../../shared/types/codeLab';
import { requirePermission, resolveRequestProject } from '../middleware/rbac';
import {
  CodeLabError,
  getActiveCodeLabSession,
  getCodeLabDiff,
  getCodeLabLogs,
  getCodeLabSession,
  handleCodeLabPreviewRequest,
  pushCodeLabBranch,
  restartCodeLabPreview,
  startCodeLabSession,
  stopCodeLabSession,
} from '../services/codeLabService';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getUserId } from '../utils/requestUser';

const router = express.Router();
const sessionsRouter = express.Router();

// Session-free: src/server/index.ts skips ensureAuthenticated for this path.
router.get(/^\/preview\/([^/]+)\/([^/]+)(?:\/(.*))?$/, (req: Request, res: Response) => {
  const params = req.params as unknown as Record<string, string | undefined>;
  handleCodeLabPreviewRequest(req, res, params[0] ?? '', params[1] ?? '', params[2] ?? '');
});

async function requireCodeLabEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const project = resolveRequestProject(req);
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const enabled = await isFeatureEnabled(CODE_LAB_FLAG_KEY, { userId: getUserId(req), project });

    // @feature-flag:code-lab start winner=enabled
    if (!enabled) {
      // @feature-flag:code-lab disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:code-lab disabled-end
    }

    // @feature-flag:code-lab enabled-start
    next();
    // @feature-flag:code-lab enabled-end
    // @feature-flag:code-lab end
  } catch (err) {
    next(err);
  }
}

function sendError(res: Response, err: unknown, action: string): void {
  if (err instanceof CodeLabError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(`[code-lab] ${action} failed:`, (err as Error).message);
  res.status(500).json({ error: `Failed to ${action}` });
}

sessionsRouter.get('/active', (req: Request, res: Response) => {
  res.json({ session: getActiveCodeLabSession(getUserId(req), resolveRequestProject(req)!) });
});

sessionsRouter.post('/', (req: Request, res: Response) => {
  const { project, model } = req.body as Partial<StartCodeLabSessionRequest>;
  try {
    const session = startCodeLabSession(getUserId(req), {
      project: project!,
      model: typeof model === 'string' && model ? model : undefined,
    });
    res.status(201).json(session);
  } catch (err) {
    sendError(res, err, 'start the Code Lab session');
  }
});

sessionsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    res.json(getCodeLabSession(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err, 'load the Code Lab session');
  }
});

sessionsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await stopCodeLabSession(req.params.id, getUserId(req));
    res.status(204).end();
  } catch (err) {
    sendError(res, err, 'stop the Code Lab session');
  }
});

sessionsRouter.post('/:id/preview/restart', async (req: Request, res: Response) => {
  try {
    res.json(await restartCodeLabPreview(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err, 'restart the preview');
  }
});

sessionsRouter.get('/:id/logs', (req: Request, res: Response) => {
  try {
    res.json(getCodeLabLogs(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err, 'load preview logs');
  }
});

sessionsRouter.get('/:id/diff', async (req: Request, res: Response) => {
  try {
    res.json(await getCodeLabDiff(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err, 'load the diff');
  }
});

sessionsRouter.post('/:id/push', async (req: Request, res: Response) => {
  try {
    res.json(await pushCodeLabBranch(req.params.id, getUserId(req)));
  } catch (err) {
    sendError(res, err, 'push the branch');
  }
});

router.use('/sessions', requireCodeLabEnabled, requirePermission(CODE_LAB_PERMISSION), sessionsRouter);

export default router;
