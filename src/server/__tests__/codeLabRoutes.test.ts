import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import codeLabRouter from '../routes/codeLab';

jest.mock('../middleware/rbac', () => ({
  requirePermission: (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.get('x-deny-permission') === permission) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return next();
  },
  resolveRequestProject: (req: Request) =>
    (req.query?.project as string | undefined) || (req.body?.project as string | undefined) || undefined,
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: () => 'user-1',
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

jest.mock('../services/codeLabService', () => {
  class CodeLabError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    CodeLabError,
    getActiveCodeLabSession: jest.fn(),
    getCodeLabDiff: jest.fn(),
    getCodeLabLogs: jest.fn(),
    getCodeLabSession: jest.fn(),
    handleCodeLabPreviewRequest: jest.fn((_req, res) => res.status(204).end()),
    pushCodeLabBranch: jest.fn(),
    restartCodeLabPreview: jest.fn(),
    startCodeLabSession: jest.fn(),
    stopCodeLabSession: jest.fn(),
  };
});

const flags = jest.requireMock('../services/featureFlagService') as { isFeatureEnabled: jest.Mock };
const service = jest.requireMock('../services/codeLabService') as {
  CodeLabError: new (message: string, status: number) => Error;
  getActiveCodeLabSession: jest.Mock;
  getCodeLabDiff: jest.Mock;
  handleCodeLabPreviewRequest: jest.Mock;
  startCodeLabSession: jest.Mock;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/code-lab', codeLabRouter);
  return app;
}

describe('code lab routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    flags.isFeatureEnabled.mockResolvedValue(true);
  });

  it('returns 404 for session routes when the code-lab flag is off', async () => {
    flags.isFeatureEnabled.mockResolvedValue(false);
    const res = await request(buildApp()).get('/api/code-lab/sessions/active?project=Apex');
    expect(res.status).toBe(404);
    expect(flags.isFeatureEnabled).toHaveBeenCalledWith('code-lab', { userId: 'user-1', project: 'Apex' });
    expect(service.getActiveCodeLabSession).not.toHaveBeenCalled();
  });

  it('requires a project', async () => {
    const res = await request(buildApp()).get('/api/code-lab/sessions/active');
    expect(res.status).toBe(400);
  });

  it('requires the code-lab:use permission', async () => {
    const res = await request(buildApp())
      .post('/api/code-lab/sessions')
      .set('x-deny-permission', 'code-lab:use')
      .send({ project: 'Apex' });
    expect(res.status).toBe(403);
    expect(service.startCodeLabSession).not.toHaveBeenCalled();
  });

  it('starts a session for the caller', async () => {
    service.startCodeLabSession.mockReturnValue({ id: 's1', status: 'preparing' });
    const res = await request(buildApp()).post('/api/code-lab/sessions').send({ project: 'Apex', model: 'm1' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 's1', status: 'preparing' });
    expect(service.startCodeLabSession).toHaveBeenCalledWith('user-1', { project: 'Apex', model: 'm1' });
  });

  it('maps CodeLabError to its status code', async () => {
    service.getCodeLabDiff.mockRejectedValue(new service.CodeLabError('Code Lab session not found.', 404));
    const res = await request(buildApp()).get('/api/code-lab/sessions/s1/diff?project=Apex');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Code Lab session not found.' });
  });

  it('serves preview paths without the flag check and passes session, token, and file path', async () => {
    const res = await request(buildApp()).get('/api/code-lab/preview/s1/tok123/src/main.tsx?v=1');
    expect(res.status).toBe(204);
    expect(flags.isFeatureEnabled).not.toHaveBeenCalled();
    const [, , sessionId, token, relativePath] = service.handleCodeLabPreviewRequest.mock.calls[0];
    expect([sessionId, token, relativePath]).toEqual(['s1', 'tok123', 'src/main.tsx']);
  });

  it('serves the preview root with an empty file path', async () => {
    await request(buildApp()).get('/api/code-lab/preview/s1/tok123/');
    expect(service.handleCodeLabPreviewRequest.mock.calls[0][4]).toBe('');
  });
});
