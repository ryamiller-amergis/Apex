import express from 'express';
import request from 'supertest';
import designModuleRouter from '../routes/designModule';

jest.mock('../middleware/rbac', () => ({
  requirePermission: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  ),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-1',
}));

jest.mock('../services/designModuleService', () => ({
  createModule: jest.fn(),
  deleteModule: jest.fn(),
  getModule: jest.fn(),
  listModules: jest.fn(),
  regenerateModule: jest.fn(),
  updateModule: jest.fn(),
}));

const service = jest.requireMock('../services/designModuleService') as {
  createModule: jest.Mock;
  deleteModule: jest.Mock;
  getModule: jest.Mock;
  listModules: jest.Mock;
  regenerateModule: jest.Mock;
  updateModule: jest.Mock;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/design-modules', designModuleRouter);
  return app;
}

describe('design module routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists module summaries', async () => {
    service.listModules.mockResolvedValue([
      { slug: 'chat-home', label: 'Chat Home' },
    ]);
    const response = await request(buildApp()).get('/api/design-modules');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ slug: 'chat-home', label: 'Chat Home' }]);
  });

  it('creates a module with the authenticated actor', async () => {
    service.createModule.mockResolvedValue({ slug: 'rbac', label: 'RBAC' });
    const body = {
      slug: 'rbac',
      label: 'RBAC',
      description: 'Access control',
      iconKey: 'rbac',
      sourceGlobs: ['src/server/services/rbacService.ts'],
    };
    const response = await request(buildApp())
      .post('/api/design-modules')
      .send(body);
    expect(response.status).toBe(201);
    expect(service.createModule).toHaveBeenCalledWith(body, 'user-1');
  });

  it('requires a project before regeneration', async () => {
    const response = await request(buildApp())
      .post('/api/design-modules/rbac/regenerate')
      .send({ force: false });
    expect(response.status).toBe(400);
    expect(service.regenerateModule).not.toHaveBeenCalled();
  });

  it('starts forced regeneration with project and actor context', async () => {
    service.regenerateModule.mockResolvedValue({
      started: true,
      threadId: 'thread-1',
    });
    const response = await request(buildApp())
      .post('/api/design-modules/rbac/regenerate')
      .send({ project: 'Apex', force: true });
    expect(response.status).toBe(202);
    expect(service.regenerateModule).toHaveBeenCalledWith('rbac', {
      project: 'Apex',
      force: true,
      actorId: 'user-1',
    });
  });

  it('returns 404 when deleting an unknown module', async () => {
    service.deleteModule.mockResolvedValue(false);
    const response = await request(buildApp()).delete(
      '/api/design-modules/missing'
    );
    expect(response.status).toBe(404);
  });
});
