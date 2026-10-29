import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

let mockGranted = new Set<string>(['builds:view', 'builds:run']);
let mockAssigned = true;

jest.mock('../middleware/rbac', () => {
  const actual = jest.requireActual('../middleware/rbac');
  return {
    resolveRequestProject: actual.resolveRequestProject,
    requirePermission: (...keys: string[]) => (_req: Request, res: Response, next: NextFunction) => {
      const missing = keys.filter((k) => !mockGranted.has(k));
      if (missing.length > 0) {
        res.status(403).json({ error: 'Forbidden', missing });
        return;
      }
      next();
    },
    requireProjectAccess: () => (_req: Request, res: Response, next: NextFunction) => {
      if (!mockAssigned) {
        res.status(403).json({ error: 'You do not have access to this project' });
        return;
      }
      next();
    },
  };
});

jest.mock('../services/buildAccessService', () => ({
  isBuildFromPromptEnabled: jest.fn(),
  isBuildPairAllowed: jest.fn(),
}));

import { isBuildFromPromptEnabled, isBuildPairAllowed } from '../services/buildAccessService';
import {
  buildActionGuard,
  buildReadGuard,
  buildRunGuard,
  requireAllowlistedPair,
} from '../middleware/buildAccess';
import {
  BUILD_FLAG_DISABLED_MESSAGE,
  BUILD_PAIR_NOT_ALLOWED_MESSAGE,
} from '../../shared/types/buildAccess';

const mockFlag = isBuildFromPromptEnabled as jest.MockedFunction<typeof isBuildFromPromptEnabled>;
const mockPair = isBuildPairAllowed as jest.MockedFunction<typeof isBuildPairAllowed>;

const handler = jest.fn((_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { profile: { oid: 'user-1' } };
    next();
  });
  app.get('/x', ...buildReadGuard, handler);
  app.post('/x', ...buildRunGuard, handler);
  app.post('/action', ...buildActionGuard, handler);
  app.post('/start', ...buildRunGuard, requireAllowlistedPair((req) => req.body?.repository), handler);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs the 4-arg signature
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGranted = new Set(['builds:view', 'builds:run']);
  mockAssigned = true;
  mockFlag.mockResolvedValue(true);
  mockPair.mockResolvedValue(true);
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

describe('flag guard (PBI-003 AC-3)', () => {
  it('VT-09 start route refuses with a plain message when the flag is off; read route still answers', async () => {
    mockFlag.mockResolvedValue(false);
    const app = buildApp();

    const post = await request(app).post('/x?project=Apex').send({});
    expect(post.status).toBe(403);
    expect(post.body).toEqual({ error: BUILD_FLAG_DISABLED_MESSAGE, code: 'BUILD_FLAG_DISABLED' });

    const get = await request(app).get('/x?project=Apex');
    expect(get.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockFlag).toHaveBeenCalledWith({ userId: 'user-1', project: 'Apex' });
  });

  it('action guard refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    const res = await request(buildApp()).post('/action?project=Apex').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BUILD_FLAG_DISABLED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 when no project is named', async () => {
    const res = await request(buildApp()).post('/x').send({});
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('VT-19 returns 500 when the flag service throws and the handler does not run', async () => {
    mockFlag.mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).post('/x?project=Apex').send({});
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('permission and project guards (PBI-003 AC-2, AC-3; TBI-004)', () => {
  it('VT-10 builds:view only cannot start', async () => {
    mockGranted = new Set(['builds:view']);
    const res = await request(buildApp()).post('/x?project=Apex').send({});
    expect(res.status).toBe(403);
    expect(res.body.missing).toEqual(['builds:run']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('VT-10 builds:view only can read', async () => {
    mockGranted = new Set(['builds:view']);
    const res = await request(buildApp()).get('/x?project=Apex');
    expect(res.status).toBe(200);
  });

  it('VT-10 neither key cannot read', async () => {
    mockGranted = new Set();
    const res = await request(buildApp()).get('/x?project=Apex');
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('VT-10 a user not assigned to the project is refused', async () => {
    mockAssigned = false;
    const read = await request(buildApp()).get('/x?project=Other');
    const run = await request(buildApp()).post('/x?project=Other').send({});
    expect(read.status).toBe(403);
    expect(run.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('VT-10 both keys on an assigned project pass', async () => {
    const res = await request(buildApp()).post('/x?project=Apex').send({});
    expect(res.status).toBe(200);
  });

  it('checks the flag only after permission passes', async () => {
    mockGranted = new Set();
    await request(buildApp()).post('/x?project=Apex').send({});
    expect(mockFlag).not.toHaveBeenCalled();
  });
});

describe('requireAllowlistedPair (BR-001; PBI-002 AC-2)', () => {
  it('VT-18 lets an allowed pair through', async () => {
    const res = await request(buildApp()).post('/start?project=Apex').send({ repository: 'Apex' });
    expect(res.status).toBe(200);
    expect(mockPair).toHaveBeenCalledWith('Apex', 'Apex');
  });

  it('VT-04/VT-18 refuses a pair that is not (or no longer) allowed', async () => {
    mockPair.mockResolvedValue(false);
    const res = await request(buildApp()).post('/start?project=Apex').send({ repository: 'Gone' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: BUILD_PAIR_NOT_ALLOWED_MESSAGE, code: 'BUILD_PAIR_NOT_ALLOWED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('VT-18 returns 400 when no repository is sent', async () => {
    const res = await request(buildApp()).post('/start?project=Apex').send({});
    expect(res.status).toBe(400);
    expect(mockPair).not.toHaveBeenCalled();
  });

  it('VT-18 returns 500 when the allow-list check throws', async () => {
    mockPair.mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).post('/start?project=Apex').send({ repository: 'Apex' });
    expect(res.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not check the pair when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    await request(buildApp()).post('/start?project=Apex').send({ repository: 'Apex' });
    expect(mockPair).not.toHaveBeenCalled();
  });
});
