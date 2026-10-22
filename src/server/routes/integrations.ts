import { Router, type NextFunction, type Request, type Response } from 'express';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../shared/types/menuSettings';
import type {
  CreateIntegrationConnectionRequest,
  UpdateIntegrationConnectionRequest,
} from '../../shared/types/integrations';
import { INTEGRATIONS_FLAG } from '../../shared/types/integrations';
import { requirePermission } from '../middleware/rbac';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getMenuConfig } from '../services/menuSettingsService';
import { getUserId } from '../utils/requestUser';
import { IntegrationConnectionError } from '../services/integrationErrors';
import { askIntegration } from '../services/integrationAskService';
import {
  createIntegrationConnection,
  deleteIntegrationConnection,
  listIntegrationConnections,
  testIntegrationConnection,
  updateIntegrationConnection,
} from '../services/integrationConnectionService';

const router = Router({ mergeParams: true });

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = req.params.projectId;
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(INTEGRATIONS_FLAG, { userId, project });

    // @feature-flag:integrations start winner=enabled
    if (!enabled) {
      // @feature-flag:integrations disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:integrations disabled-end
    }

    // @feature-flag:integrations enabled-start
    const config = await getMenuConfig(project);
    const views = config?.enabledViews ?? DEFAULT_ENABLED_MENU_VIEWS;
    if (!views.includes('integrations')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    next();
    // @feature-flag:integrations enabled-end
    // @feature-flag:integrations end
  } catch (err) {
    next(err);
  }
});

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof IntegrationConnectionError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

router.get('/', requirePermission('integrations:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connections = await listIntegrationConnections(req.params.projectId);
    res.json({ connections });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post('/ask', requirePermission('integrations:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { connectionId?: string; question?: string };
    const result = await askIntegration({
      project: req.params.projectId,
      connectionId: body.connectionId ?? '',
      userId: getUserId(req),
      question: body.question ?? '',
    });
    res.json(result);
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post('/', requirePermission('integrations:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateIntegrationConnectionRequest;
    const connection = await createIntegrationConnection({
      ...body,
      project: req.params.projectId,
      createdBy: getUserId(req),
    });
    res.status(201).json({ connection });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.patch('/:connectionId', requirePermission('integrations:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as UpdateIntegrationConnectionRequest;
    const connection = await updateIntegrationConnection(req.params.projectId, req.params.connectionId, body);
    res.json({ connection });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.delete('/:connectionId', requirePermission('integrations:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteIntegrationConnection(req.params.projectId, req.params.connectionId);
    res.status(204).send();
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post('/:connectionId/test', requirePermission('integrations:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await testIntegrationConnection(req.params.projectId, req.params.connectionId);
    res.json({ connection });
  } catch (err) {
    sendError(err, res, next);
  }
});

export default router;
