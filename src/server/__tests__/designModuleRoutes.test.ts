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
  resolveGlobFiles: jest.fn(),
}));

jest.mock('../services/designModuleScopingService', () => ({
  startScoping: jest.fn(),
  getScopingResult: jest.fn(),
  cancelScoping: jest.fn(),
}));

const service = jest.requireMock('../services/designModuleService') as {
  createModule: jest.Mock;
  deleteModule: jest.Mock;
  getModule: jest.Mock;
  listModules: jest.Mock;
  regenerateModule: jest.Mock;
  updateModule: jest.Mock;
  resolveGlobFiles: jest.Mock;
};

const scopingService = jest.requireMock(
  '../services/designModuleScopingService'
) as {
  startScoping: jest.Mock;
  getScopingResult: jest.Mock;
  cancelScoping: jest.Mock;
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
    expect(service.regenerateModule).not.toHaveBeenCalled();
  });

  it('auto-starts generation when create includes a project', async () => {
    service.createModule.mockResolvedValue({
      slug: 'rbac',
      label: 'RBAC',
      hasContent: false,
    });
    service.regenerateModule.mockResolvedValue({
      started: true,
      threadId: 'thread-gen-1',
    });
    const body = {
      slug: 'rbac',
      label: 'RBAC',
      description: 'Access control',
      iconKey: 'rbac',
      sourceGlobs: ['src/server/services/rbacService.ts'],
      project: 'Apex',
    };
    const response = await request(buildApp())
      .post('/api/design-modules')
      .send(body);
    expect(response.status).toBe(201);
    expect(service.createModule).toHaveBeenCalledWith(body, 'user-1');
    expect(service.regenerateModule).toHaveBeenCalledWith('rbac', {
      project: 'Apex',
      force: true,
      actorId: 'user-1',
    });
    expect(response.body.generation).toEqual({
      started: true,
      threadId: 'thread-gen-1',
    });
  });

  it('still creates the module when auto-generation fails to start', async () => {
    service.createModule.mockResolvedValue({ slug: 'rbac', label: 'RBAC' });
    service.regenerateModule.mockRejectedValue(new Error('No skill config'));
    const response = await request(buildApp())
      .post('/api/design-modules')
      .send({
        slug: 'rbac',
        label: 'RBAC',
        iconKey: 'rbac',
        sourceGlobs: ['src/server/services/rbacService.ts'],
        project: 'Apex',
      });
    expect(response.status).toBe(201);
    expect(response.body.generation).toEqual({
      started: false,
      error: 'No skill config',
    });
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

  it('starts AI scoping and returns 202', async () => {
    scopingService.startScoping.mockResolvedValue({ threadId: 'thread-9' });
    const response = await request(buildApp())
      .post('/api/design-modules/scoping')
      .send({
        project: 'Apex',
        name: 'Load Testing',
        description: 'k6',
      });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ threadId: 'thread-9' });
    expect(scopingService.startScoping).toHaveBeenCalledWith(
      'Apex',
      expect.objectContaining({ name: 'Load Testing' }),
      'user-1'
    );
  });

  it('requires project for scoping', async () => {
    const response = await request(buildApp())
      .post('/api/design-modules/scoping')
      .send({ name: 'Load Testing' });
    expect(response.status).toBe(400);
    expect(scopingService.startScoping).not.toHaveBeenCalled();
  });

  it('returns scoping poll result', async () => {
    scopingService.getScopingResult.mockResolvedValue({
      status: 'pending',
    });
    const response = await request(buildApp()).get(
      '/api/design-modules/scoping/thread-9/result'
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'pending' });
  });

  it('previews matched files for source globs', async () => {
    service.resolveGlobFiles.mockReturnValue([
      { pattern: 'src/a.ts', files: ['src/a.ts'] },
    ]);
    const response = await request(buildApp())
      .post('/api/design-modules/preview-globs')
      .send({ sourceGlobs: ['src/a.ts'] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      matches: [{ pattern: 'src/a.ts', files: ['src/a.ts'] }],
    });
  });
});
