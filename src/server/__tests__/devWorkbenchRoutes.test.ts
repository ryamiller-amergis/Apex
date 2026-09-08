/**
 * Integration-style tests for /api/dev-workbench routes.
 */
import request from 'supertest';
import express from 'express';
import devWorkbenchRouter from '../routes/devWorkbench';
import { AzureDevOpsService } from '../services/azureDevOps';
import type { CloudAgentRunSummary } from '../../shared/types/devWorkbench';

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
  ...jest.requireActual('../utils/requestUser'),
  getUserId: jest.fn().mockReturnValue('user-1'),
}));
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'session-abc'),
}));

const mockGetApexFeatureContext = jest.fn();
jest.mock('../services/devWorkbenchFeatureContextService', () => ({
  getApexFeatureContext: (...args: unknown[]) => mockGetApexFeatureContext(...args),
}));

const mockAttachCloudAgentEligibility = jest.fn(async (items: unknown[]) => items);
const mockGetCloudAgentRunStatus = jest.fn().mockResolvedValue(null);
const mockGetCloudAgentActivityStream = jest.fn();
const mockStartCloudAgentRun = jest.fn();
const mockCancelCloudAgentRun = jest.fn();

jest.mock('../services/cloudAgentService', () => {
  class CloudAgentEligibilityError extends Error {
    readonly statusCode = 403;
    constructor(public readonly reason: string) {
      super(reason);
      this.name = 'CloudAgentEligibilityError';
    }
  }
  class CloudAgentConflictError extends Error {
    readonly statusCode = 409;
    constructor(message = 'A Cloud Agent run is already in progress on this work item.') {
      super(message);
      this.name = 'CloudAgentConflictError';
    }
  }
  return {
    attachCloudAgentEligibility: (items: unknown[]) => mockAttachCloudAgentEligibility(items),
    getCloudAgentRunStatus: (sessionId: string, userId: string) =>
      mockGetCloudAgentRunStatus(sessionId, userId),
    getCloudAgentActivityStream: (...args: unknown[]) =>
      mockGetCloudAgentActivityStream(...args),
    startCloudAgentRun: (input: unknown) => mockStartCloudAgentRun(input),
    cancelCloudAgentRun: (sessionId: unknown) => mockCancelCloudAgentRun(sessionId),
    CloudAgentEligibilityError,
    CloudAgentConflictError,
  };
});

const mockFindFirst = jest.fn();
const mockSelectWhere = jest.fn();
const mockInsertValues = jest.fn().mockResolvedValue(undefined);
const mockUpdateReturning = jest.fn().mockResolvedValue([{ id: 'technical-1' }]);
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));

jest.mock('../db/drizzle', () => ({
  db: (() => {
    const mockedDb = {
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: jest.fn(() => ({ set: mockUpdateSet })),
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: jest.fn().mockReturnValue({ orderBy: mockSelectWhere }) })),
    })),
    query: {
      devSessions: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
    },
    transaction: jest.fn(),
    };
    mockedDb.transaction.mockImplementation((callback: (tx: typeof mockedDb) => unknown) => callback(mockedDb));
    return mockedDb;
  })(),
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

const CLOUD_PR_URL = 'https://github.com/example/apex/pull/4210';

/**
 * Completed Cloud Agent run whose PR is still open — the projection the session
 * reads carry for PBI-007 AC-0 / AC-2.
 */
function cloudRunWithOpenPr(): CloudAgentRunSummary {
  return {
    runId: 'run-pr-open',
    status: 'completed',
    prUrl: CLOUD_PR_URL,
    prStatus: 'open',
    finishedWithoutPr: false,
    terminalReason: null,
    checkResults: null,
    failingChecks: [],
    lastError: null,
  };
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

  it('does not query ADO for Amego requirements', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/workitems?project=Amego');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app-native PRD requirements/i);
    expect(MockAzureDevOpsService).not.toHaveBeenCalled();
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

describe('POST /api/dev-workbench/cloud-agent/start', () => {
  const { isFeatureEnabled } = jest.requireMock('../services/featureFlagService') as {
    isFeatureEnabled: jest.Mock;
  };
  const { CloudAgentEligibilityError, CloudAgentConflictError } = jest.requireMock(
    '../services/cloudAgentService',
  ) as {
    CloudAgentEligibilityError: new (reason: string) => Error;
    CloudAgentConflictError: new (message?: string) => Error;
  };

  const callerProfile = {
    displayName: 'Jane Developer',
    upn: 'jane@example.com',
  };
  const callerAssignedTo = { displayName: 'Jane Developer', uniqueName: 'jane@example.com' };

  function mockWorkItemLookup(fields: Record<string, unknown>) {
    MockAzureDevOpsService.mockImplementation(() => ({
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        items: [{
          id: 42,
          fields: {
            'System.State': 'Committed',
            'System.WorkItemType': 'Feature',
            'System.Tags': 'apex',
            'System.AssignedTo': callerAssignedTo,
            ...fields,
          },
        }],
      }),
    }) as unknown as AzureDevOpsService);
  }

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    isFeatureEnabled.mockResolvedValue(true);
    mockStartCloudAgentRun.mockReset();
    mockStartCloudAgentRun.mockResolvedValue({ sessionId: 'session-cloud', runId: 'run-cloud' });
  });

  it('returns 404 when the Cloud Agent flag is off', async () => {
    isFeatureEnabled.mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/dev-workbench/cloud-agent/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(404);
    expect(mockStartCloudAgentRun).not.toHaveBeenCalled();
  });

  it('returns 403 with the same eligibility reason shown on the row', async () => {
    const reason = 'Skill settings are incomplete: skillRepo is not set.';
    mockWorkItemLookup({});
    mockStartCloudAgentRun.mockRejectedValueOnce(new CloudAgentEligibilityError(reason));

    const res = await request(buildApp(callerProfile))
      .post('/api/dev-workbench/cloud-agent/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(reason);
  });

  it('returns 409 when a live Cloud Agent run already exists', async () => {
    mockWorkItemLookup({});
    mockStartCloudAgentRun.mockRejectedValueOnce(new CloudAgentConflictError());

    const res = await request(buildApp(callerProfile))
      .post('/api/dev-workbench/cloud-agent/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
  });

  it('PBI-002 AC-3 / VT-04 rejects Start on another developer\'s work item and creates no run', async () => {
    mockWorkItemLookup({
      'System.AssignedTo': { displayName: 'Other Developer', uniqueName: 'other@example.com' },
    });

    const res = await request(buildApp(callerProfile))
      .post('/api/dev-workbench/cloud-agent/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/assigned to you/i);
    expect(mockStartCloudAgentRun).not.toHaveBeenCalled();
  });

  it('returns 200 with sessionId and runId', async () => {
    mockWorkItemLookup({
      'System.AssignedTo': callerAssignedTo,
    });

    const res = await request(buildApp(callerProfile))
      .post('/api/dev-workbench/cloud-agent/start')
      .send({ workItemId: 42, project: 'MaxView' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'session-cloud', runId: 'run-cloud' });
    expect(mockStartCloudAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: expect.any(String),
      project: 'MaxView',
    }));
    expect(mockStartCloudAgentRun).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/dev-workbench/sessions/:id/cloud-agent/stream', () => {
  beforeEach(() => {
    mockGetCloudAgentActivityStream.mockReset();
  });

  it('streams normalized Cloud Agent activity and the terminal frame', async () => {
    mockGetCloudAgentActivityStream.mockResolvedValue((async function* () {
      yield {
        id: '1:assistant:0',
        kind: 'assistant',
        title: 'Agent update',
        detail: 'Updating the route.',
      };
    })());

    const res = await request(buildApp()).get(
      '/api/dev-workbench/sessions/session-1/cloud-agent/stream?runId=run-1',
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"activity"');
    expect(res.text).toContain('"detail":"Updating the route."');
    expect(res.text).toContain('"type":"stream_end"');
    expect(mockGetCloudAgentActivityStream).toHaveBeenCalledWith(
      'session-1',
      'user-1',
      'run-1',
    );
  });

  it('returns the service status before opening the SSE response', async () => {
    mockGetCloudAgentActivityStream.mockRejectedValue(
      Object.assign(new Error('Cloud Agent run not found'), { status: 404 }),
    );

    const res = await request(buildApp()).get(
      '/api/dev-workbench/sessions/missing/cloud-agent/stream',
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Cloud Agent run not found' });
  });
});

describe('POST /api/dev-workbench/sessions/:id/cloud-agent/cancel', () => {
  const { isFeatureEnabled } = jest.requireMock('../services/featureFlagService') as {
    isFeatureEnabled: jest.Mock;
  };
  const { CloudAgentConflictError } = jest.requireMock('../services/cloudAgentService') as {
    CloudAgentConflictError: new (message?: string) => Error;
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
    isFeatureEnabled.mockResolvedValue(true);
  });

  it('returns 404 for a session the caller does not own', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp()).post(
      '/api/dev-workbench/sessions/foreign/cloud-agent/cancel',
    );

    expect(res.status).toBe(404);
    expect(mockCancelCloudAgentRun).not.toHaveBeenCalled();
  });

  it('returns 409 when the run is already terminal', async () => {
    mockFindFirst.mockResolvedValue({ id: 'session-1', authorId: 'user-1', project: 'MaxView' });
    mockCancelCloudAgentRun.mockRejectedValueOnce(new CloudAgentConflictError('Run is already terminal'));

    const res = await request(buildApp()).post(
      '/api/dev-workbench/sessions/session-1/cloud-agent/cancel',
    );

    expect(res.status).toBe(409);
  });

  it('returns 200 with the resulting status', async () => {
    mockFindFirst.mockResolvedValue({ id: 'session-1', authorId: 'user-1', project: 'MaxView' });
    mockCancelCloudAgentRun.mockResolvedValue({ ok: true, status: 'cancelled' });

    const res = await request(buildApp()).post(
      '/api/dev-workbench/sessions/session-1/cloud-agent/cancel',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'cancelled' });
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
    bootstrapDevelopmentDependencies.mockImplementationOnce(
      async (
        _workspace: string,
        options: import('../services/dependencyBootstrapService').DependencyBootstrapOptions,
      ) => {
        await options.onPhase?.('dependencies_preparing', 'Preparing locked dependencies');
        await options.onPhase?.('dependencies_ready', 'Dependencies are ready');
        return { cacheKey: 'cache', cacheDir: '/tmp/cache', cacheHit: false };
      },
    );

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

  it('rejects Start Development when the work item is not in an allowed state', async () => {
    MockAzureDevOpsService.mockImplementation(() => ({
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        items: [{ id: 99, fields: { 'System.State': 'In Pull Request', 'System.WorkItemType': 'Feature', 'System.Tags': 'apex' } }],
      }),
    }) as unknown as AzureDevOpsService);

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only available for/i);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a non-admin starting a Feature without the apex tag', async () => {
    MockAzureDevOpsService.mockImplementation(() => ({
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        items: [{ id: 99, fields: { 'System.State': 'Committed', 'System.WorkItemType': 'Feature', 'System.Tags': 'wave-1' } }],
      }),
    }) as unknown as AzureDevOpsService);

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/APEX-generated Features/i);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('rejects a non-admin starting a PBI even when tagged apex and startable', async () => {
    MockAzureDevOpsService.mockImplementation(() => ({
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        items: [{ id: 99, fields: { 'System.State': 'Committed', 'System.WorkItemType': 'Product Backlog Item', 'System.Tags': 'apex' } }],
      }),
    }) as unknown as AzureDevOpsService);

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only available on Features/i);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('allows a non-admin to start an APEX Feature in an allowed state (Committed)', async () => {
    MockAzureDevOpsService.mockImplementation(() => ({
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        items: [{ id: 99, fields: { 'System.State': 'Committed', 'System.WorkItemType': 'Feature', 'System.Tags': 'apex; wave-2' } }],
      }),
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
    }) as unknown as AzureDevOpsService);

    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'session-abc' });
  });

  it('allows a super admin to start any type (Bug) regardless of APEX origin', async () => {
    MockAzureDevOpsService.mockImplementation(() => ({
      queryWorkItemsByWiql: jest.fn().mockResolvedValue({
        items: [{ id: 99, fields: { 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'System.Tags': '' } }],
      }),
      getDefaultBranch: jest.fn().mockResolvedValue('main'),
    }) as unknown as AzureDevOpsService);

    const res = await request(buildApp({ displayName: 'Platform Admin', upn: 'anedunur@amergis.com' }))
      .post('/api/dev-workbench/start')
      .send({ workItemId: 99, project: 'MaxView' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'session-abc' });
  });

  it('rejects the removed technical backlog source path', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/start')
      .send({ technicalBacklogItemId: 'technical-1', project: 'Apex' });

    expect(res.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
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
        leftoverWork: {
          failingChecks: ['e2e'],
          missingPr: false,
          incompleteAcceptanceCriteria: [],
        },
      },
    ]);
  });

  it('PBI-008 AC-3: returns author-scoped active sessions with leftoverWork', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/sessions?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 'session-1',
      workItemId: 10,
      leftoverWork: {
        failingChecks: ['e2e'],
        missingPr: false,
        incompleteAcceptanceCriteria: [],
      },
    });
    expect(mockGetCloudAgentRunStatus).toHaveBeenCalledWith('session-1', 'user-1');
  });

  it('PBI-007 AC-0 / AC-2 / VT-05: carries the run PR URL and host-agnostic prStatus inside cloudAgentRun', async () => {
    mockGetCloudAgentRunStatus.mockResolvedValueOnce(cloudRunWithOpenPr());

    const res = await request(buildApp()).get('/api/dev-workbench/sessions?project=MaxView');

    expect(res.status).toBe(200);
    expect(res.body[0].cloudAgentRun).toMatchObject({
      runId: 'run-pr-open',
      status: 'completed',
      prUrl: CLOUD_PR_URL,
      prStatus: 'open',
    });
    // The status rides on the existing projection — no sibling session field and
    // no second endpoint for the row to call.
    expect(res.body[0].prStatus).toBeUndefined();
  });

  it('returns 500 when the query fails', async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error('DB error'));

    const res = await request(buildApp()).get('/api/dev-workbench/sessions');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch sessions/i);
  });
});

describe('removed technical backlog endpoint', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('does not expose the internal technical backlog', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/technical-backlog?project=Apex');

    expect(res.status).toBe(404);
  });
});

describe('GET /api/dev-workbench/sessions/:id', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('PBI-008 AC-3: returns session detail with leftoverWork for its author', async () => {
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
      leftoverWork: {
        failingChecks: [],
        missingPr: true,
        incompleteAcceptanceCriteria: ['AC-5'],
      },
    });

    const res = await request(buildApp()).get('/api/dev-workbench/sessions/session-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'session-1',
      status: 'in_progress',
      setupPhase: 'dependencies_ready',
      setupDetail: 'Dependencies are ready',
      setupProgressAt: '2026-06-01T00:00:05Z',
      leftoverWork: {
        failingChecks: [],
        missingPr: true,
        incompleteAcceptanceCriteria: ['AC-5'],
      },
    });
    expect(mockGetCloudAgentRunStatus).toHaveBeenCalledWith('session-1', 'user-1');
  });

  it('PBI-007 AC-0 / AC-2 / VT-05: carries the run PR URL and host-agnostic prStatus inside cloudAgentRun', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'session-1',
      workItemId: 10,
      chatThreadId: 'thread-1',
      branchName: 'feature/10',
      status: 'in_progress',
      setupError: null,
      setupPhase: null,
      setupDetail: null,
      setupProgressAt: null,
      createdAt: '2026-06-01T00:00:00Z',
      leftoverWork: null,
    });
    mockGetCloudAgentRunStatus.mockResolvedValueOnce(cloudRunWithOpenPr());

    const res = await request(buildApp()).get('/api/dev-workbench/sessions/session-1');

    expect(res.status).toBe(200);
    expect(res.body.cloudAgentRun).toMatchObject({
      runId: 'run-pr-open',
      status: 'completed',
      prUrl: CLOUD_PR_URL,
      prStatus: 'open',
    });
    // Same projection the list read serializes — the row polls this one payload.
    expect(res.body.prStatus).toBeUndefined();
  });

  it('PBI-006 AC-3 / PBI-007 AC-3 / PBI-008 AC-3 / VT-06: returns 404 for another author without projecting run outcomes or PR status', async () => {
    // The lookup is scoped by `authorId`, so another developer's session id
    // resolves to nothing for this caller.
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp()).get('/api/dev-workbench/sessions/other-author-session');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(res.text).not.toMatch(/prStatus|prUrl|cloudAgentRun/);
    // The PR-status projection is never even computed for a session the caller
    // does not own.
    expect(mockGetCloudAgentRunStatus).not.toHaveBeenCalled();
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
              'System.State': 'In Progress',
              'System.Tags': 'apex; wave-1',
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
            'System.State': 'In Progress',
            'System.Tags': 'apex; wave-1',
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
            'System.State': 'In Progress',
            'System.Tags': 'apex; wave-1',
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

  it('creates a project-scoped completed session for an Amego feature', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-amego', featureId: 'FEAT-001', project: 'Amego' });

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'Amego',
        authorId: 'user-1',
        prdId: 'prd-amego',
        featureId: 'FEAT-001',
        status: 'completed',
      }),
    );
  });

  it('promotes an active session to completed instead of inserting', async () => {
    mockFindFirst
      .mockResolvedValueOnce(undefined) // no completed
      .mockResolvedValueOnce({ id: 'active-session', status: 'in_progress' });

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'Apex' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessionId: 'active-session' });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
    expect(mockInsertValues).not.toHaveBeenCalled();
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

  it('rejects feature completion for an ADO-backed project', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/features/complete')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'MaxView' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app-native requirements project/i);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
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

describe('GET /api/dev-workbench/features/:prdId/:featureId/context', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('returns 400 when project query is missing', async () => {
    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-1/FEAT-001/context',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project/i);
    expect(mockGetApexFeatureContext).not.toHaveBeenCalled();
  });

  it('returns 400 for an ADO-backed project', async () => {
    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-1/FEAT-001/context?project=MaxView',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app-native requirements project/i);
    expect(mockGetApexFeatureContext).not.toHaveBeenCalled();
  });

  it('returns 404 when the service reports not found', async () => {
    mockGetApexFeatureContext.mockResolvedValue(null);

    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-1/FEAT-001/context?project=Apex',
    );

    expect(res.status).toBe(404);
    expect(mockGetApexFeatureContext).toHaveBeenCalledWith('Apex', 'prd-1', 'FEAT-001');
  });

  it('returns the feature context payload on success', async () => {
    const payload = {
      prdId: 'prd-1',
      prdTitle: 'Notifications',
      prdContent: '# PRD',
      epicTitle: 'Epic',
      featureId: 'FEAT-001',
      featureTitle: 'Prefs',
      featurePriority: 'Must',
      backlogItems: [],
      designDocument: null,
      prototype: null,
    };
    mockGetApexFeatureContext.mockResolvedValue(payload);

    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-1/FEAT-001/context?project=Apex',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('returns Amego feature context from the app-native PRD service', async () => {
    mockGetApexFeatureContext.mockResolvedValue({
      prdId: 'prd-amego',
      featureId: 'FEAT-001',
    });

    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-amego/FEAT-001/context?project=Amego',
    );

    expect(res.status).toBe(200);
    expect(mockGetApexFeatureContext).toHaveBeenCalledWith(
      'Amego',
      'prd-amego',
      'FEAT-001',
    );
  });

  it('inherits the Developer group membership gate', async () => {
    mockGroupMembershipGranted = false;

    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-1/FEAT-001/context?project=Apex',
    );

    expect(res.status).toBe(403);
    expect(mockGetApexFeatureContext).not.toHaveBeenCalled();
  });

  it('inherits the dev-workbench:view permission gate', async () => {
    mockPermissionGranted = false;

    const res = await request(buildApp()).get(
      '/api/dev-workbench/features/prd-1/FEAT-001/context?project=Apex',
    );

    expect(res.status).toBe(403);
    expect(mockGetApexFeatureContext).not.toHaveBeenCalled();
  });
});

describe('POST /api/dev-workbench/features/start-local', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    mockGroupMembershipGranted = true;
    jest.clearAllMocks();
  });

  it('creates a synthetic in_progress session for local development', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/start-local')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'Apex' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sessionId: 'session-abc', status: 'in_progress' });
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-abc',
        project: 'Apex',
        authorId: 'user-1',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        status: 'in_progress',
      }),
    );
  });

  it('creates a synthetic in_progress session for Amego local development', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/start-local')
      .send({ prdId: 'prd-amego', featureId: 'FEAT-001', project: 'Amego' });

    expect(res.status).toBe(200);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'Amego',
        prdId: 'prd-amego',
        featureId: 'FEAT-001',
        status: 'in_progress',
      }),
    );
  });

  it('returns the existing active session without inserting', async () => {
    mockFindFirst
      .mockResolvedValueOnce(undefined) // not completed
      .mockResolvedValueOnce({ id: 'existing-active', status: 'in_progress' });

    const res = await request(buildApp())
      .post('/api/dev-workbench/features/start-local')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'Apex' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessionId: 'existing-active', status: 'in_progress' });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/features/start-local')
      .send({ featureId: 'FEAT-001' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects PRD feature development for an ADO-backed project', async () => {
    const res = await request(buildApp())
      .post('/api/dev-workbench/features/start-local')
      .send({ prdId: 'prd-1', featureId: 'FEAT-001', project: 'MaxView' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app-native requirements project/i);
    expect(mockInsertValues).not.toHaveBeenCalled();
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
