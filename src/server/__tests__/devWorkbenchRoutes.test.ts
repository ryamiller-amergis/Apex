/**
 * Integration-style tests for /api/dev-workbench routes.
 */
import request from 'supertest';
import express from 'express';
import devWorkbenchRouter from '../routes/devWorkbench';
import { AzureDevOpsService } from '../services/azureDevOps';

let mockPermissionGranted = true;
let mockGroupMembershipGranted = true;
const mockGitRemote = {
  url: 'https://dev.azure.com/amergis/MaxView/_git/MaxView',
  env: { GIT_CONFIG_COUNT: '1' },
  secret: 'secret',
};
const mockResolveGitRemote = jest.fn(
  (_provider: string, _project: string, _repo: string) => mockGitRemote,
);
const mockScheduleWorkspaceCleanup = jest.fn();
const mockTouchDevSessionSetup = jest.fn().mockResolvedValue(true);
const mockActivateDevSession = jest.fn().mockResolvedValue(true);

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
jest.mock('../services/dependencyBootstrapService', () => ({
  bootstrapDevelopmentDependencies: jest.fn().mockResolvedValue({
    cacheKey: 'node-v24-lock-hash',
    cacheDir: '/tmp/dependency-cache/node-v24-lock-hash',
    cacheHit: false,
  }),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/repoCacheService', () => ({
  resolveGitRemote: (provider: string, project: string, repo: string) =>
    mockResolveGitRemote(provider, project, repo),
}));
jest.mock('../services/devWorkspaceCleanupService', () => ({
  scheduleStaleDevWorkspaceCleanup: () => mockScheduleWorkspaceCleanup(),
}));
jest.mock('../services/devSessionSetupService', () => ({
  touchDevSessionSetup: (...args: unknown[]) => mockTouchDevSessionSetup(...args),
  activateDevSession: (...args: unknown[]) => mockActivateDevSession(...args),
}));
jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn().mockResolvedValue('/tmp/workspace'),
  checkoutFeatureBranch: jest.fn().mockResolvedValue(undefined),
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
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(true),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
  };
});
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
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));

jest.mock('../db/drizzle', () => ({
  db: {
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: jest.fn(() => ({ set: mockUpdateSet })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: jest.fn().mockReturnValue({ orderBy: mockSelectWhere }) })),
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
  const { bootstrapDevelopmentDependencies } = jest.requireMock('../services/dependencyBootstrapService') as {
    bootstrapDevelopmentDependencies: jest.Mock;
  };
  const { createThread } = jest.requireMock('../services/chatAgentService') as {
    createThread: jest.Mock;
  };
  const { isFeatureEnabled } = jest.requireMock('../services/featureFlagService') as {
    isFeatureEnabled: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    isFeatureEnabled.mockResolvedValue(true);
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

  it('prepares locked dev dependencies after checkout and before creating the thread', async () => {
    const mockAdo = {
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({ items: [] }),
      setWorkItemState: jest.fn().mockResolvedValue(undefined),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdo as unknown as AzureDevOpsService);

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bootstrapDevelopmentDependencies).toHaveBeenCalledWith('/tmp/workspace', expect.any(Object));
    expect(createThread).toHaveBeenCalled();
    expect(bootstrapDevelopmentDependencies.mock.invocationCallOrder[0])
      .toBeLessThan(createThread.mock.invocationCallOrder[0]);
    expect(isFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(isFeatureEnabled).toHaveBeenCalledWith('dev-dependency-bootstrap', {
      userId: 'user-1',
      project: 'MaxView',
    });
    expect(createThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mode: 'development' }),
      expect.objectContaining({
        workspaceDirOverride: '/tmp/workspace',
        dependenciesPrepared: true,
      }),
    );
  });

  it('skips bootstrap when the rollout flag is absent or disabled and keeps installs allowed', async () => {
    isFeatureEnabled.mockResolvedValue(false);
    const mockAdo = {
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({ items: [] }),
      setWorkItemState: jest.fn().mockResolvedValue(undefined),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdo as unknown as AzureDevOpsService);

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(isFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(bootstrapDevelopmentDependencies).not.toHaveBeenCalled();
    expect(createThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mode: 'development' }),
      expect.objectContaining({
        workspaceDirOverride: '/tmp/workspace',
        dependenciesPrepared: false,
      }),
    );
    expect(mockActivateDevSession).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({
        chatThreadId: 'thread-1',
        setupPhase: 'dependencies_skipped',
        setupDetail: expect.stringMatching(/bootstrap.*disabled/i),
      }),
    );
  });

  it('persists dependency setup phase and safe detail for polling clients', async () => {
    const mockAdo = {
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({ items: [] }),
      setWorkItemState: jest.fn().mockResolvedValue(undefined),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdo as unknown as AzureDevOpsService);
    bootstrapDevelopmentDependencies.mockImplementationOnce(async (_workspace: string, options: any) => {
      await options.onPhase('dependencies_preparing', 'Preparing locked dependencies');
      await options.onPhase('dependencies_ready', 'Dependencies are ready');
      return { cacheKey: 'cache', cacheDir: '/tmp/cache', cacheHit: false };
    });

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      setupPhase: 'dependencies_preparing',
      setupDetail: 'Preparing locked dependencies',
    }));
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      setupPhase: 'dependencies_ready',
      setupDetail: 'Dependencies are ready',
    }));
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
      setupPhase: 'dependencies_ready',
      setupDetail: 'Dependencies are ready',
      setupProgressAt: '2026-06-01T00:00:05Z',
      createdAt: '2026-06-01T00:00:00Z',
    });

    const res = await request(buildApp()).get('/api/dev-workbench/sessions/session-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'session-1',
      status: 'in_progress',
      setupPhase: 'dependencies_ready',
      setupDetail: 'Dependencies are ready',
      setupProgressAt: '2026-06-01T00:00:05Z',
    });
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
    branchPushed: false,
  };

  let mockAdoPush: {
    getDefaultBranch: jest.Mock;
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
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdoPush as unknown as AzureDevOpsService);
    mockFindFirst.mockResolvedValue(SESSION);
  });

  it('syncs base, pushes branch only, and returns branchPushed on clean merge', async () => {
    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/push');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('clean');
    expect(res.body.branchPushed).toBe(true);
    expect(res.body.prUrl).toBeUndefined();
    expect(syncWithBase).toHaveBeenCalledWith('/tmp/workspace', 'main', mockGitRemote);
    expect(pushMergedBranch).toHaveBeenCalledWith('/tmp/workspace', SESSION.branchName, mockGitRemote);
  });

  it('returns conflict status when base merge has conflicts', async () => {
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
    mockFindFirst.mockResolvedValue({ ...SESSION, branchName: null });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/push');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no branch/i);
  });
});

describe('POST /api/dev-workbench/sessions/:id/pr', () => {
  const SESSION = {
    id: 'session-1',
    branchName: 'feature/apex-42-shift-scheduler',
    project: 'MaxView',
    workItemId: 42,
    authorId: 'user-1',
    branchPushed: true,
    prUrl: null,
  };
  const PR_URL = 'https://dev.azure.com/org/proj/_git/repo/pullrequest/1';

  let mockAdoPr: {
    getDefaultBranch: jest.Mock;
    createPullRequest: jest.Mock;
    setWorkItemState: jest.Mock;
    addWorkItemHyperlink: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    mockAdoPr = {
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
      createPullRequest: jest.fn().mockResolvedValue(PR_URL),
      setWorkItemState: jest.fn().mockResolvedValue(undefined),
      addWorkItemHyperlink: jest.fn().mockResolvedValue(undefined),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdoPr as unknown as AzureDevOpsService);
  });

  it('creates a PR for a pushed branch and returns prUrl', async () => {
    mockFindFirst
      .mockResolvedValueOnce(SESSION)
      .mockResolvedValue({ ...SESSION, prUrl: PR_URL });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/pr');

    expect(res.status).toBe(200);
    expect(res.body.prUrl).toBe(PR_URL);
    expect(mockAdoPr.createPullRequest).toHaveBeenCalled();
  });

  it('returns the existing prUrl idempotently', async () => {
    mockFindFirst.mockResolvedValue({ ...SESSION, prUrl: PR_URL });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/pr');

    expect(res.status).toBe(200);
    expect(res.body.prUrl).toBe(PR_URL);
    expect(mockAdoPr.createPullRequest).not.toHaveBeenCalled();
  });

  it('returns 404 when session not found', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/missing/pr');

    expect(res.status).toBe(404);
  });

  it('returns 400 when branch has not been pushed', async () => {
    mockFindFirst.mockResolvedValue({ ...SESSION, branchPushed: false });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/pr');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not been pushed/i);
  });

  it('returns 400 when session has no branch', async () => {
    mockFindFirst.mockResolvedValue({ ...SESSION, branchName: null });

    const res = await request(buildApp()).post('/api/dev-workbench/sessions/session-1/pr');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no branch/i);
  });
});

describe('POST /api/dev-workbench/start — ADO attachment injection', () => {
  const {
    checkoutDefaultBranch,
    createFeatureBranch,
    cleanupWorkspace,
  } = jest.requireMock('../services/repoCheckoutService') as {
    checkoutDefaultBranch: jest.Mock;
    createFeatureBranch: jest.Mock;
    cleanupWorkspace: jest.Mock;
  };
  const fsModule = jest.requireMock('fs') as { existsSync: jest.Mock; mkdirSync: jest.Mock; writeFileSync: jest.Mock };

  let mockAdoAttach: {
    queryWorkItemsByWiql: jest.Mock;
    getAttachmentText: jest.Mock;
    setWorkItemState: jest.Mock;
    getDefaultBranch: jest.Mock;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    checkoutDefaultBranch.mockResolvedValue('/tmp/workspace');
    createFeatureBranch.mockReturnValue('feature/apex-42-implement-login');
    mockAdoAttach = {
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
      setWorkItemState: jest.fn().mockResolvedValue(undefined),
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        totalMatched: 1,
        returned: 1,
        ids: [42],
        items: [
          {
            id: 42,
            fields: {
              'System.Id': 42,
              'System.Title': 'Implement login',
              'System.WorkItemType': 'Feature',
            },
            relations: [
              {
                rel: 'AttachedFile',
                url: 'https://dev.azure.com/org/_apis/wit/attachments/design-id',
                attributes: { name: 'design.md' },
              },
              {
                rel: 'AttachedFile',
                url: 'https://dev.azure.com/org/_apis/wit/attachments/tech-id',
                attributes: { name: 'tech-spec.md' },
              },
            ],
          },
        ],
      }),
      getAttachmentText: jest.fn().mockResolvedValue('# design content'),
    };
    MockAzureDevOpsService.mockImplementation(() => mockAdoAttach as unknown as AzureDevOpsService);
  });

  it('calls getAttachmentText for each AttachedFile attachment during ADO session setup', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('session-abc');
    expect(mockScheduleWorkspaceCleanup).toHaveBeenCalled();

    // Allow async setup to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAdoAttach.queryWorkItemsByWiql).toHaveBeenCalledWith(
      expect.objectContaining({
        wiql: expect.stringContaining('42'),
        includeRelations: true,
      }),
    );
    expect(mockAdoAttach.getAttachmentText).toHaveBeenCalledTimes(2);
    expect(createFeatureBranch).toHaveBeenCalledWith(
      '/tmp/workspace',
      42,
      'Implement login',
      'main',
      mockGitRemote,
    );
  });

  it('matches variant attachment names and writes them under canonical file names', async () => {
    mockAdoAttach.queryWorkItemsByWiql.mockResolvedValue({
      totalMatched: 1,
      returned: 1,
      ids: [42],
      items: [
        {
          id: 42,
          fields: {
            'System.Id': 42,
            'System.Title': 'Blackout Date Rule Administration',
            'System.WorkItemType': 'Feature',
          },
          relations: [
            // singular / typo variant
            {
              rel: 'AttachedFile',
              url: 'https://dev.azure.com/org/_apis/wit/attachments/assumption-id',
              attributes: { name: 'assumption.md' },
            },
            // slug-prefixed variant
            {
              rel: 'AttachedFile',
              url: 'https://dev.azure.com/org/_apis/wit/attachments/design-id',
              attributes: { name: 'blackout-design.md' },
            },
            // uppercase variant
            {
              rel: 'AttachedFile',
              url: 'https://dev.azure.com/org/_apis/wit/attachments/proto-id',
              attributes: { name: 'PROTOTYPE.HTML' },
            },
          ],
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAdoAttach.getAttachmentText).toHaveBeenCalledTimes(3);
    const writtenNames = fsModule.writeFileSync.mock.calls.map((c) => String(c[0]).split(/[\\/]/).pop());
    expect(writtenNames).toEqual(
      expect.arrayContaining(['assumptions.md', 'design.md', 'prototype.html']),
    );
  });

  it('ignores attachments that are not design docs', async () => {
    mockAdoAttach.queryWorkItemsByWiql.mockResolvedValue({
      totalMatched: 1,
      returned: 1,
      ids: [42],
      items: [
        {
          id: 42,
          fields: {
            'System.Id': 42,
            'System.Title': 'Implement login',
            'System.WorkItemType': 'Feature',
          },
          relations: [
            {
              rel: 'AttachedFile',
              url: 'https://dev.azure.com/org/_apis/wit/attachments/readme-id',
              attributes: { name: 'readme.txt' },
            },
            {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: 'https://dev.azure.com/org/_apis/wit/workItems/1',
              attributes: { name: 'Parent' },
            },
            {
              rel: 'AttachedFile',
              url: 'https://dev.azure.com/org/_apis/wit/attachments/design-id',
              attributes: { name: 'design.md' },
            },
          ],
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockAdoAttach.getAttachmentText).toHaveBeenCalledTimes(1);
    const writtenNames = fsModule.writeFileSync.mock.calls.map((c) => String(c[0]).split(/[\\/]/).pop());
    expect(writtenNames).toContain('design.md');
    expect(writtenNames).not.toContain('readme.txt');
  });

  it('cleans the partial workspace when asynchronous setup fails', async () => {
    checkoutDefaultBranch.mockRejectedValueOnce(new Error('clone timed out'));

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cleanupWorkspace).toHaveBeenCalledWith('session-abc');
    expect(mockUpdateWhere).toHaveBeenCalled();
  });
});

describe('POST /api/dev-workbench/features/complete', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('creates a synthetic completed session for the feature', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'Apex' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sessionId: 'session-abc' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-abc',
        project: 'Apex',
        authorId: 'user-1',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        status: 'completed',
      }),
    );
  });

  it('returns the existing session if the feature is already complete', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-session' });

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'Apex' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessionId: 'existing-session' });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 500 when the insert fails', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    mockInsertValues.mockRejectedValueOnce(new Error('DB insert failed'));

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'Apex' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to mark feature/i);
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
