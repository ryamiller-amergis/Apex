/**
 * Integration-style tests for /api/dev-workbench routes.
 */
import request from 'supertest';
import express from 'express';
import devWorkbenchRouter from '../routes/devWorkbench';
import { AzureDevOpsService } from '../services/azureDevOps';

let mockPermissionGranted = true;
let mockGroupMembershipGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (mockPermissionGranted) {
        next();
      } else {
        res.status(403).json({ error: 'Forbidden', missing: keys });
      }
    },
  requireAnyPermission: () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireGroupMembership: (...groups: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (mockGroupMembershipGranted) {
        next();
      } else {
        res.status(403).json({ error: 'Forbidden', missingGroups: groups });
      }
    },
  attachPermissions: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../services/azureDevOps');
jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn().mockResolvedValue(null);
  return {
    getSkillConfig,
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string }) => getSkillConfig(opts.project)),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
  };
});
jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn().mockResolvedValue({ id: 'thread-1' }),
}));
jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn().mockResolvedValue('/tmp/workspace'),
  createFeatureBranch: jest.fn().mockReturnValue('feature/apex-42-shift-scheduler'),
  computeDiff: jest.fn().mockReturnValue({ diffText: 'diff', changedFiles: ['a.ts'] }),
  pushBranch: jest.fn(),
  pushMergedBranch: jest.fn(),
  syncWithBase: jest.fn().mockReturnValue({ status: 'clean', conflictedFiles: [] }),
  listConflicts: jest.fn().mockReturnValue([]),
  writeResolvedFile: jest.fn(),
  completeMerge: jest.fn(),
  abortMerge: jest.fn(),
  getWorkspaceDir: jest.fn().mockReturnValue('/tmp/workspace'),
  cleanupWorkspace: jest.fn(),
  slugify: jest.fn((t: string) => t.toLowerCase().replace(/\s+/g, '-')),
}));
jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-1'),
}));
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'session-abc'),
}));

const mockFindFirst = jest.fn();
const mockSelectWhere = jest.fn();
const mockInsertValues = jest.fn().mockResolvedValue(undefined);
const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);

jest.mock('../db/drizzle', () => ({
  db: {
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: mockUpdateWhere })),
    })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: mockSelectWhere })),
    })),
    query: {
      devSessions: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
  },
}));

const MockAzureDevOpsService = AzureDevOpsService as jest.MockedClass<typeof AzureDevOpsService>;

function buildApp(profile: Record<string, unknown> = { displayName: 'Jane Developer' }) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { profile };
    next();
  });
  app.use('/api/dev-workbench', devWorkbenchRouter);
  return app;
}

describe('dev-workbench routes — access gates', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('returns 403 when the user lacks dev-workbench:view', async () => {
    mockPermissionGranted = false;

    const res = await request(buildApp()).get('/api/dev-workbench/workitems?project=MaxView');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', missing: ['dev-workbench:view'] });
  });

  it('returns 403 when the user is not in the Developer group', async () => {
    mockGroupMembershipGranted = false;

    const res = await request(buildApp()).get('/api/dev-workbench/workitems?project=MaxView');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', missingGroups: ['Developer'] });
  });
});

describe('GET /api/dev-workbench/workitems', () => {
  let mockAdo: { getWorkItemsAssignedToUser: jest.Mock };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();

    mockAdo = {
      getWorkItemsAssignedToUser: jest.fn().mockResolvedValue([
        {
          id: 42,
          title: 'Implement login',
          workItemType: 'Product Backlog Item',
          state: 'In Progress',
          assignedTo: 'jane@example.com',
          project: 'MaxView',
        },
      ]),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdo as unknown as AzureDevOpsService);
  });

  it('returns assigned work items for the current user', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/workitems?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 42, title: 'Implement login' });
    expect(mockAdo.getWorkItemsAssignedToUser).toHaveBeenCalledWith(
      'Jane Developer',
      'MaxView',
      { activeOnly: true },
    );
  });

  it('returns 400 when project is missing', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/workitems');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project/i);
  });

  it('returns 400 when display name cannot be determined', async () => {
    const res = await request(buildApp({})).get('/api/dev-workbench/workitems?project=MaxView');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/display name/i);
  });

  it('returns 500 when ADO lookup fails', async () => {
    mockAdo.getWorkItemsAssignedToUser.mockRejectedValue(new Error('ADO down'));

    const res = await request(buildApp()).get('/api/dev-workbench/workitems?project=MaxView');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch/i);
  });
});

describe('POST /api/dev-workbench/start', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    MockAzureDevOpsService.mockImplementation(() => ({}) as unknown as AzureDevOpsService);
  });

  it('creates a session record and returns sessionId immediately', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'session-abc' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-abc',
        workItemId: 99,
        project: 'MaxView',
        authorId: 'user-1',
        status: 'setting_up',
      }),
    );
  });

  it('returns 400 when workItemId or project is missing', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ project: 'MaxView' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 500 when the session insert fails', async () => {
    mockInsertValues.mockRejectedValueOnce(new Error('DB insert failed'));

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to start/i);
  });
});

describe('GET /api/dev-workbench/sessions', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    mockSelectWhere.mockResolvedValue([
      {
        id: 'session-1',
        workItemId: 10,
        chatThreadId: 'thread-1',
        branchName: 'feature/10',
        status: 'in_progress',
        createdAt: '2026-06-01T00:00:00Z',
      },
    ]);
  });

  it('returns active sessions for the current user', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/sessions?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'session-1', workItemId: 10 });
  });

  it('returns 500 when the query fails', async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error('DB error'));

    const res = await request(buildApp()).get('/api/dev-workbench/sessions');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch sessions/i);
  });
});

describe('GET /api/dev-workbench/sessions/:id', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('returns session detail when found', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'session-1',
      workItemId: 10,
      chatThreadId: 'thread-1',
      branchName: 'feature/10',
      status: 'in_progress',
      setupError: null,
      createdAt: '2026-06-01T00:00:00Z',
    });

    const res = await request(buildApp()).get('/api/dev-workbench/sessions/session-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'session-1', status: 'in_progress' });
  });

  it('returns 404 when session is not found', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp()).get('/api/dev-workbench/sessions/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('POST /api/dev-workbench/sessions/:id/close', () => {
  const { cleanupWorkspace } = jest.requireMock('../services/repoCheckoutService') as {
    cleanupWorkspace: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    cleanupWorkspace.mockImplementation(() => {});
  });

  it('marks the session closed and cleans up the workspace', async () => {
    mockFindFirst.mockResolvedValue({ id: 'session-1', authorId: 'user-1' });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/close');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateWhere).toHaveBeenCalled();
    expect(cleanupWorkspace).toHaveBeenCalledWith('session-1');
  });

  it('returns 404 when session is not found', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/missing/close');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/dev-workbench/sessions/:id/push', () => {
  const { syncWithBase, pushMergedBranch, getWorkspaceDir } = jest.requireMock('../services/repoCheckoutService') as {
    syncWithBase: jest.Mock;
    pushMergedBranch: jest.Mock;
    getWorkspaceDir: jest.Mock;
  };

  const SESSION = {
    id: 'session-1',
    branchName: 'feature/apex-42-shift-scheduler',
    project: 'MaxView',
    workItemId: 42,
    authorId: 'user-1',
  };
  const PR_URL = 'https://dev.azure.com/org/proj/_git/repo/pullrequest/1';

  let mockAdoPush: {
    getDefaultBranch: jest.Mock;
    createPullRequest: jest.Mock;
    setWorkItemState: jest.Mock;
    addWorkItemHyperlink: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    getWorkspaceDir.mockReturnValue('/tmp/workspace');
    syncWithBase.mockReturnValue({ status: 'clean', conflictedFiles: [] });
    pushMergedBranch.mockImplementation(() => {});
    mockAdoPush = {
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
      createPullRequest: jest.fn().mockResolvedValue(PR_URL),
      setWorkItemState: jest.fn().mockResolvedValue(undefined),
      addWorkItemHyperlink: jest.fn().mockResolvedValue(undefined),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdoPush as unknown as AzureDevOpsService);
    // First call fetches the session; second call (after finalisePush) returns updated row
    mockFindFirst
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValue({ ...SESSION, prUrl: PR_URL });
  });

  it('syncs base, pushes, and returns prUrl on clean merge', async () => {
    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/push');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('clean');
    expect(res.body.prUrl).toBe(PR_URL);
    expect(syncWithBase).toHaveBeenCalledWith('/tmp/workspace', 'main');
    expect(pushMergedBranch).toHaveBeenCalledWith('/tmp/workspace', SESSION.branchName);
  });

  it('returns conflict status when base merge has conflicts', async () => {
    mockFindFirst.mockReset();
    mockFindFirst.mockResolvedValue(SESSION);
    MockAzureDevOpsService.mockImplementation(() => mockAdoPush as unknown as AzureDevOpsService);
    syncWithBase.mockReturnValue({
      status: 'conflict',
      conflictedFiles: [{ path: 'src/foo.ts', content: '<<<<<<< HEAD\n...' }],
    });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/push');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('conflict');
    expect(res.body.conflictedFiles).toHaveLength(1);
    expect(pushMergedBranch).not.toHaveBeenCalled();
  });

  it('returns 400 when the session has no branch', async () => {
    mockFindFirst.mockReset();
    mockFindFirst.mockResolvedValue({ ...SESSION, branchName: null });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/push');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no branch/i);
  });
});

describe('GET /api/dev-workbench/threads/:id/diff', () => {
  const { computeDiff, getWorkspaceDir } = jest.requireMock('../services/repoCheckoutService') as {
    computeDiff: jest.Mock;
    getWorkspaceDir: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    getWorkspaceDir.mockReturnValue('/tmp/workspace');
    computeDiff.mockReturnValue({ diffText: '+added', changedFiles: ['src/a.ts'] });
  });

  it('returns diff data for the dev session linked to the thread', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'session-1',
      branchName: 'feature/42',
    });

    const res = await request(buildApp()).get('/api/dev-workbench/threads/thread-1/diff');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      diffText: '+added',
      changedFiles: ['src/a.ts'],
      branch: 'feature/42',
    });
    expect(computeDiff).toHaveBeenCalledWith('/tmp/workspace');
  });

  it('returns 404 when no dev session exists for the thread', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp()).get('/api/dev-workbench/threads/thread-missing/diff');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
