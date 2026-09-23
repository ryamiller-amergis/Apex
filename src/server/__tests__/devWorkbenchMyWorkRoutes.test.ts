/**
 * Focused tests for the My Work self-scoped dev-workbench endpoints:
 *   GET /api/dev-workbench/assigned-backlog  — Apex Backlog items assigned to the caller
 *   GET /api/dev-workbench/backlog-features  — approved PRD features the caller owns
 *
 * The shared devWorkbenchRoutes suite mocks Drizzle with a single fixed chain
 * that cannot express the joined selects these routes issue, so they get their
 * own mock here.
 */
import request from 'supertest';
import express from 'express';

let mockPermissionGranted = true;
let mockGroupMembershipGranted = true;
let mockUserId = 'user-1';

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (mockPermissionGranted) next();
      else res.status(403).json({ error: 'Forbidden', missing: keys });
    },
  requireAnyPermission: () =>
    (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireGroupMembership: (...groups: string[]) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (mockGroupMembershipGranted) next();
      else res.status(403).json({ error: 'Forbidden', missingGroups: groups });
    },
  attachPermissions: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  ...jest.requireActual('../utils/requestUser'),
  getUserId: jest.fn(() => mockUserId),
}));

jest.mock('../services/azureDevOps');
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
  resolveSkillConfig: jest.fn(),
  getSkillSettingsName: jest.fn(),
}));
jest.mock('../services/chatAgentService', () => ({ createThread: jest.fn() }));
jest.mock('../services/dependencyBootstrapService', () => ({
  bootstrapDevelopmentDependencies: jest.fn(),
}));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/repoCacheService', () => ({ resolveGitRemote: jest.fn() }));
jest.mock('../services/devWorkspaceCleanupService', () => ({
  scheduleStaleDevWorkspaceCleanup: jest.fn(),
}));
jest.mock('../services/devSessionSetupService', () => ({
  touchDevSessionSetup: jest.fn(),
  activateDevSession: jest.fn(),
}));
jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn(),
  checkoutFeatureBranch: jest.fn(),
  createFeatureBranch: jest.fn(),
  computeDiff: jest.fn(),
  pushBranch: jest.fn(),
  pushMergedBranch: jest.fn(),
  syncWithBase: jest.fn(),
  listConflicts: jest.fn(),
  writeResolvedFile: jest.fn(),
  completeMerge: jest.fn(),
  abortMerge: jest.fn(),
  getWorkspaceDir: jest.fn(),
  cleanupWorkspace: jest.fn(),
}));
jest.mock('../services/devWorkbenchFeatureContextService', () => ({
  getApexFeatureContext: jest.fn(),
}));

const mockListAssignedToUser = jest.fn();
jest.mock('../services/featureRequestService', () => ({
  listAssignedToUser: (...args: unknown[]) => mockListAssignedToUser(...args),
}));

/**
 * Drizzle mock driven by a queue: each `db.select()` pops the next canned
 * result set and records the chain methods and their arguments, so tests can
 * assert both the returned rows and the filters the route applied.
 */
interface MockSelectCall {
  chain: string[];
  whereArgs: unknown[];
}
const mockSelectResults: unknown[][] = [];
const mockSelectCalls: MockSelectCall[] = [];

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => {
      const rows = mockSelectResults.shift() ?? [];
      const call: MockSelectCall = { chain: [], whereArgs: [] };
      mockSelectCalls.push(call);
      const chain: Record<string, unknown> = {
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
        chain[method] = jest.fn((...args: unknown[]) => {
          call.chain.push(method);
          if (method === 'where') call.whereArgs.push(args[0]);
          return chain;
        });
      }
      return chain;
    }),
    insert: jest.fn(),
    update: jest.fn(),
    query: { devSessions: { findFirst: jest.fn() }, prds: { findFirst: jest.fn() } },
    transaction: jest.fn(),
  },
}));

import devWorkbenchRouter from '../routes/devWorkbench';

/**
 * Walks a Drizzle SQL expression tree and collects referenced column names and
 * bound parameter values, so tests can assert applied filters without a DB.
 */
function collectFilter(
  node: unknown,
  acc: { columns: string[]; params: unknown[] } = { columns: [], params: [] },
): { columns: string[]; params: unknown[] } {
  if (node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) collectFilter(child, acc);
    return acc;
  }
  const candidate = node as Record<string, unknown>;
  if (Array.isArray(candidate.queryChunks)) return collectFilter(candidate.queryChunks, acc);
  if (candidate.table && typeof candidate.name === 'string') {
    acc.columns.push(candidate.name);
    return acc;
  }
  if ('encoder' in candidate && 'value' in candidate) {
    acc.params.push(candidate.value);
    return acc;
  }
  return acc;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { profile: { oid: mockUserId } };
    next();
  });
  app.use('/api/dev-workbench', devWorkbenchRouter);
  return app;
}

beforeEach(() => {
  mockPermissionGranted = true;
  mockGroupMembershipGranted = true;
  mockUserId = 'user-1';
  mockSelectResults.length = 0;
  mockSelectCalls.length = 0;
  jest.clearAllMocks();
});

// ── GET /assigned-backlog ─────────────────────────────────────────────────────

describe('GET /api/dev-workbench/assigned-backlog', () => {
  const ITEM = {
    id: 'fr-1',
    type: 'feature',
    title: 'Dark mode',
    status: 'planned',
    assignedToApex: false,
  };

  it('returns the assigned Apex Backlog items for the current user and project', async () => {
    mockListAssignedToUser.mockResolvedValue([ITEM]);

    const res = await request(buildApp()).get('/api/dev-workbench/assigned-backlog?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([ITEM]);
    expect(mockListAssignedToUser).toHaveBeenCalledWith('Apex', 'user-1');
  });

  it('forwards the requesting user to the service', async () => {
    mockUserId = 'user-9';
    mockListAssignedToUser.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/dev-workbench/assigned-backlog?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockListAssignedToUser).toHaveBeenCalledWith('Apex', 'user-9');
  });

  it('returns 400 when project is missing', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/assigned-backlog');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project/i);
    expect(mockListAssignedToUser).not.toHaveBeenCalled();
  });

  it('returns 500 when the service fails', async () => {
    mockListAssignedToUser.mockRejectedValue(new Error('DB down'));

    const res = await request(buildApp()).get('/api/dev-workbench/assigned-backlog?project=Apex');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch assigned backlog/i);
  });

  it('inherits the dev-workbench:view permission gate', async () => {
    mockPermissionGranted = false;

    const res = await request(buildApp()).get('/api/dev-workbench/assigned-backlog?project=Apex');

    expect(res.status).toBe(403);
    expect(mockListAssignedToUser).not.toHaveBeenCalled();
  });
});

// ── GET /backlog-features ─────────────────────────────────────────────────────

describe('GET /api/dev-workbench/backlog-features — design doc owner filter', () => {
  function prdRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'prd-1',
      title: 'Notifications',
      project: 'Apex',
      status: 'approved',
      interviewId: 'interview-1',
      reviewedAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      backlogJson: {
        epics: [
          {
            title: 'Epic A',
            features: [
              { id: 'FEAT-001', title: 'Prefs', priority: 'Must', items: [{ type: 'PBI' }] },
            ],
          },
        ],
      },
      ...overrides,
    };
  }

  it('returns features from a PRD whose interview design doc owner is the caller', async () => {
    mockSelectResults.push([prdRow()]);
    mockSelectResults.push([]); // design docs

    const res = await request(buildApp()).get('/api/dev-workbench/backlog-features?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ prdId: 'prd-1', prdTitle: 'Notifications' });
    expect(res.body[0].epics[0].features[0]).toMatchObject({ featureId: 'FEAT-001' });
  });

  it('joins interviews and filters approved PRDs on the requesting user', async () => {
    mockUserId = 'owner-7';
    mockSelectResults.push([]);

    const res = await request(buildApp()).get('/api/dev-workbench/backlog-features?project=Apex');

    expect(res.status).toBe(200);
    const prdSelect = mockSelectCalls[0];
    expect(prdSelect.chain).toEqual(expect.arrayContaining(['from', 'innerJoin', 'where']));
    const filter = collectFilter(prdSelect.whereArgs[0]);
    expect(filter.params).toEqual(expect.arrayContaining(['Apex', 'approved', 'owner-7']));
    expect(filter.columns).toEqual(expect.arrayContaining(['design_doc_owner_id']));
  });

  // A PRD owned by someone else, or by nobody, is dropped by the inner join +
  // owner predicate, so the route sees no rows and returns nothing.
  it.each([
    ['another user owns the interview'],
    ['the interview has no design doc owner'],
  ])('returns no groups when %s', async () => {
    mockSelectResults.push([]);

    const res = await request(buildApp()).get('/api/dev-workbench/backlog-features?project=Apex');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 400 when project is missing', async () => {
    const res = await request(buildApp()).get('/api/dev-workbench/backlog-features');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project/i);
  });
});
