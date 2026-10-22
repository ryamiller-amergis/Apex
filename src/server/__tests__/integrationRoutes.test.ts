import request from 'supertest';
import express from 'express';
import integrationsRouter from '../routes/integrations';
import * as askService from '../services/integrationAskService';
import * as connectionService from '../services/integrationConnectionService';
import * as featureFlagService from '../services/featureFlagService';
import * as menuSettingsService from '../services/menuSettingsService';

let permissions = new Set<string>();

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) => (req: any, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const missing = keys.filter((key) => !permissions.has(key));
    if (missing.length > 0) {
      res.status(403).json({ error: 'Forbidden', missing });
      return;
    }
    next();
  },
}));

jest.mock('../services/integrationAskService', () => ({
  askIntegration: jest.fn(),
}));

jest.mock('../services/integrationConnectionService', () => ({
  createIntegrationConnection: jest.fn(),
  listIntegrationConnections: jest.fn(),
  updateIntegrationConnection: jest.fn(),
  deleteIntegrationConnection: jest.fn(),
  testIntegrationConnection: jest.fn(),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

jest.mock('../services/menuSettingsService', () => ({
  getMenuConfig: jest.fn(),
}));

const asks = askService as jest.Mocked<typeof askService>;
const connections = connectionService as jest.Mocked<typeof connectionService>;
const flags = featureFlagService as jest.Mocked<typeof featureFlagService>;
const menus = menuSettingsService as jest.Mocked<typeof menuSettingsService>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { profile: { oid: 'user-1' } };
    next();
  });
  app.use('/api/projects/:projectId/integrations', integrationsRouter);
  return app;
}

describe('integration routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    permissions = new Set(['integrations:view', 'integrations:manage']);
    flags.isFeatureEnabled.mockResolvedValue(true);
    menus.getMenuConfig.mockResolvedValue({
      project: 'MaxView',
      enabledViews: ['integrations'],
      updatedBy: null,
    });
    connections.listIntegrationConnections.mockResolvedValue([]);
  });

  it('SC-1 returns 404 when the integrations flag is off', async () => {
    flags.isFeatureEnabled.mockResolvedValue(false);

    const res = await request(buildApp()).get('/api/projects/MaxView/integrations');

    expect(res.status).toBe(404);
    expect(connections.listIntegrationConnections).not.toHaveBeenCalled();
  });

  it('SC-1 returns 404 when the project menu omits integrations', async () => {
    menus.getMenuConfig.mockResolvedValue({
      project: 'MaxView',
      enabledViews: ['calendar'],
      updatedBy: null,
    });

    const res = await request(buildApp()).post('/api/projects/MaxView/integrations').send({
      name: 'Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
    });

    expect(res.status).toBe(404);
    expect(connections.createIntegrationConnection).not.toHaveBeenCalled();
  });

  it('SC-2 forbids create and edit without integrations:manage', async () => {
    permissions = new Set(['integrations:view']);

    const create = await request(buildApp()).post('/api/projects/MaxView/integrations').send({
      name: 'Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
    });
    const edit = await request(buildApp())
      .patch('/api/projects/MaxView/integrations/conn-1')
      .send({ allowedUserIds: ['user-2'] });

    expect(create.status).toBe(403);
    expect(edit.status).toBe(403);
    expect(connections.createIntegrationConnection).not.toHaveBeenCalled();
    expect(connections.updateIntegrationConnection).not.toHaveBeenCalled();
  });

  it('SC-3 lets a manager create a connection and receives no secret', async () => {
    connections.createIntegrationConnection.mockResolvedValue({
      id: 'conn-1',
      project: 'MaxView',
      name: 'MaxView Clerk',
      provider: 'clerk',
      status: 'untested',
      credentialHint: '••••cret',
      baseUrl: 'https://api.clerk.com',
      operations: [],
      allowedUserIds: ['user-1'],
      createdBy: 'user-1',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
      lastTestedAt: null,
    });

    const res = await request(buildApp()).post('/api/projects/MaxView/integrations').send({
      name: 'MaxView Clerk',
      provider: 'clerk',
      credential: 'sk_live_supersecret',
      allowedUserIds: ['user-1'],
    });

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('sk_live_supersecret');
    expect(res.body.connection.credentialHint).toBe('••••cret');
  });

  it('SC-5 asks through the selected connection for a viewer', async () => {
    permissions = new Set(['integrations:view']);
    asks.askIntegration.mockResolvedValue({
      threadId: 'thread-1',
      connectionId: 'conn-clerk',
      operationId: 'listUsers',
      answer: 'MaxView Clerk (clerk listUsers): Jane Ticket',
    });

    const res = await request(buildApp())
      .post('/api/projects/MaxView/integrations/ask')
      .send({
        connectionId: 'conn-clerk',
        question: 'What do we know about user jane@example.com from ticket 4421?',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      connectionId: 'conn-clerk',
      operationId: 'listUsers',
      answer: expect.stringContaining('Jane Ticket'),
    }));
  });
});
