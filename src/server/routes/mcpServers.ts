import { Router, type NextFunction, type Request, type Response } from 'express';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../shared/types/menuSettings';
import type {
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
} from '../../shared/types/mcpServers';
import { MCP_SERVERS_FLAG, PREBUILT_PROVIDER_IDS, type PrebuiltProvider } from '../../shared/types/mcpServers';
import { discoverMcpServerTools } from '../services/mcpServerDiscovery';
import { devAppOrigin, safeAppOrigin } from '../services/mcpServerOAuth';
import { requirePermission } from '../middleware/rbac';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getMenuConfig } from '../services/menuSettingsService';
import { getUserId } from '../utils/requestUser';
import { McpServerError } from '../services/mcpServerErrors';
import { askMcpServer } from '../services/mcpServerAskService';
import {
  beginMcpServerOAuth,
  completeMcpServerOAuth,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  testMcpServer,
  updateMcpServer,
} from '../services/mcpServerConnectionService';

const router = Router({ mergeParams: true });

router.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = req.params.projectId;
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(MCP_SERVERS_FLAG, { userId, project });

    // @feature-flag:mcp-servers start winner=enabled
    if (!enabled) {
      // @feature-flag:mcp-servers disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:mcp-servers disabled-end
    }

    // @feature-flag:mcp-servers enabled-start
    const config = await getMenuConfig(project);
    const views = config?.enabledViews ?? DEFAULT_ENABLED_MENU_VIEWS;
    if (!views.includes('mcp-servers')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    next();
    // @feature-flag:mcp-servers enabled-end
    // @feature-flag:mcp-servers end
  } catch (err) {
    next(err);
  }
});

function sendError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof McpServerError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

router.get('/', requirePermission('mcp-servers:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connections = await listMcpServers(req.params.projectId);
    res.json({ connections });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post('/discover-tools', requirePermission('mcp-servers:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { provider?: string; clientId?: string; clientSecret?: string };
    if (!body.provider || !(PREBUILT_PROVIDER_IDS as readonly string[]).includes(body.provider)) {
      res.status(400).json({ error: 'provider is required' });
      return;
    }
    const tools = await discoverMcpServerTools({
      provider: body.provider as PrebuiltProvider,
      clientId: body.clientId,
      clientSecret: body.clientSecret ?? '',
    });
    res.json({
      tools: tools.map(({ name, description, readOnly }) => ({ name, description, readOnly })),
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post('/ask', requirePermission('mcp-servers:view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { connectionId?: string; question?: string };
    const result = await askMcpServer({
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

router.post('/', requirePermission('mcp-servers:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateMcpServerRequest;
    const connection = await createMcpServer({
      ...body,
      project: req.params.projectId,
      createdBy: getUserId(req),
    });
    res.status(201).json({ connection });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.patch('/:connectionId', requirePermission('mcp-servers:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as UpdateMcpServerRequest;
    const connection = await updateMcpServer(req.params.projectId, req.params.connectionId, body);
    res.json({ connection });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.delete('/:connectionId', requirePermission('mcp-servers:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await deleteMcpServer(req.params.projectId, req.params.connectionId);
    res.status(204).send();
  } catch (err) {
    sendError(err, res, next);
  }
});

function oauthAppOrigin(req: Request): string {
  const host = (req.get('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0].trim();
  const fromBrowser = safeAppOrigin(req.get('origin'), host);
  if (fromBrowser) return fromBrowser;
  const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
  const devOrigin = devAppOrigin(host);
  if (devOrigin) return devOrigin;
  if ((proto !== 'https' && proto !== 'http') || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) {
    throw new McpServerError(400, 'Apex could not determine its OAuth callback address.', 'OAUTH_REQUIRED');
  }
  if (proto === 'http' && !/^(localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)) {
    throw new McpServerError(400, 'OAuth sign-in needs an https address.', 'OAUTH_REQUIRED');
  }
  return `${proto}://${host}`;
}

function oauthReturnUrl(req: Request, returnOrigin: string | null, query: string): string {
  const origin = safeAppOrigin(returnOrigin) ?? devAppOrigin((req.get('host') ?? '').split(',')[0].trim());
  return origin ? `${origin}/mcp-servers?${query}` : `/mcp-servers?${query}`;
}

router.post('/:connectionId/oauth/start', requirePermission('mcp-servers:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const returnOrigin = oauthAppOrigin(req);
    const project = encodeURIComponent(req.params.projectId);
    const id = encodeURIComponent(req.params.connectionId);
    const authorizationUrl = await beginMcpServerOAuth({
      project: req.params.projectId,
      id: req.params.connectionId,
      userId: getUserId(req),
      redirectUri: `${returnOrigin}/api/projects/${project}/mcp-servers/${id}/oauth/callback`,
      returnOrigin,
    });
    res.json({ authorizationUrl });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.get('/:connectionId/oauth/callback', requirePermission('mcp-servers:manage'), async (req: Request, res: Response) => {
  try {
    if (typeof req.query.error === 'string' && req.query.error) {
      throw new McpServerError(400, 'The sign-in was declined.', 'OAUTH_REQUIRED');
    }
    const returnOrigin = await completeMcpServerOAuth({
      project: req.params.projectId,
      id: req.params.connectionId,
      userId: getUserId(req),
      code: typeof req.query.code === 'string' ? req.query.code : '',
      state: typeof req.query.state === 'string' ? req.query.state : '',
    });
    res.redirect(302, oauthReturnUrl(req, returnOrigin, 'oauth=connected'));
  } catch (err) {
    const message = err instanceof McpServerError ? err.message : 'OAuth sign-in did not finish.';
    res.redirect(302, oauthReturnUrl(req, null, `oauth=error&message=${encodeURIComponent(message)}`));
  }
});

router.post('/:connectionId/test', requirePermission('mcp-servers:manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const connection = await testMcpServer(req.params.projectId, req.params.connectionId);
    res.json({ connection });
  } catch (err) {
    sendError(err, res, next);
  }
});

export default router;
