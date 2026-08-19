/**
 * Integration-style tests for /api/apex-work-items routes.
 * All database and notification services are mocked.
 */
import request from 'supertest';
import express from 'express';
import apexWorkItemsRouter from '../routes/apexWorkItems';
import { isFeatureEnabled } from '../services/featureFlagService';

const mockIsFeatureEnabled = isFeatureEnabled as jest.Mock;

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireProjectAccess: () => (_req: any, _res: any, next: any) => next(),
  resolveRequestProject: (req: any) =>
    (typeof req.query?.project === 'string' && req.query.project)
    || (typeof req.body?.project === 'string' && req.body.project)
    || undefined,
}));

const mockListItems = jest.fn();
const mockGetItem = jest.fn();
const mockCreateItem = jest.fn();
const mockUpdateItem = jest.fn();
const mockMoveItem = jest.fn();
const mockBulkUpdate = jest.fn();
const mockListOwners = jest.fn();
const mockListFacets = jest.fn();
const mockListReleases = jest.fn();
const mockCreateRelease = jest.fn();
const mockMaterialize = jest.fn();
const mockGetMaterialized = jest.fn();
const mockGenerateDrafts = jest.fn();
const mockCreateFromDrafts = jest.fn();
const mockListComments = jest.fn();
const mockAddComment = jest.fn();
const mockImportFromAdo = jest.fn();
const mockGetBoardEventStats = jest.fn();
const mockListDeployments = jest.fn();
const mockSeedDeployments = jest.fn();
const mockNotifyDueSoon = jest.fn();
const mockListAssigned = jest.fn();

jest.mock('../services/apexWorkItemService', () => ({
  listApexWorkItems: (...a: any[]) => mockListItems(...a),
  getApexWorkItem: (...a: any[]) => mockGetItem(...a),
  createApexWorkItem: (...a: any[]) => mockCreateItem(...a),
  updateApexWorkItem: (...a: any[]) => mockUpdateItem(...a),
  moveApexWorkItem: (...a: any[]) => mockMoveItem(...a),
  bulkUpdateApexWorkItems: (...a: any[]) => mockBulkUpdate(...a),
  listEligibleOwners: (...a: any[]) => mockListOwners(...a),
  listFilterFacets: (...a: any[]) => mockListFacets(...a),
  listReleases: (...a: any[]) => mockListReleases(...a),
  createRelease: (...a: any[]) => mockCreateRelease(...a),
  updateRelease: jest.fn(),
  deleteRelease: jest.fn(),
  materializeFromPrdWithItems: (...a: any[]) => mockMaterialize(...a),
  previewMaterializeFromPrd: jest.fn().mockResolvedValue({ featureRequestId: null, leaves: [], counts: { skip: 0, link: 0, create: 0, choose: 0 } }),
  getMaterializedItemIds: (...a: any[]) => mockGetMaterialized(...a),
  generateDraftsFromFeatureRequest: (...a: any[]) => mockGenerateDrafts(...a),
  createFromDrafts: (...a: any[]) => mockCreateFromDrafts(...a),
  previewCreateFromDrafts: jest.fn().mockResolvedValue({ items: [], counts: { skip: 0, link: 0, create: 0, choose: 0 } }),
  listComments: (...a: any[]) => mockListComments(...a),
  addComment: (...a: any[]) => mockAddComment(...a),
  listAttachments: jest.fn().mockResolvedValue([]),
  addAttachmentMeta: jest.fn(),
  getBoardEventStats: (...a: any[]) => mockGetBoardEventStats(...a),
  listAssignedToUser: (...a: any[]) => mockListAssigned(...a),
  notifyDueSoonWorkItems: (...a: any[]) => mockNotifyDueSoon(...a),
}));

jest.mock('../services/apexDeploymentService', () => ({
  listDeployments: (...a: any[]) => mockListDeployments(...a),
  recordDeployment: jest.fn(),
  seedDeploymentsFromJsonIfEmpty: (...a: any[]) => mockSeedDeployments(...a),
}));

jest.mock('../services/apexWorkItemImportService', () => ({
  importFromAdo: (...a: any[]) => mockImportFromAdo(...a),
}));

jest.mock('../services/apexWorkBoardBus', () => ({
  subscribe: () => () => undefined,
  emitBoardChange: jest.fn(),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(userOid = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { profile: { oid: userOid } };
    next();
  });
  app.use('/api/apex-work-items', apexWorkItemsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err?.status ?? 500;
    res.status(status).json({ error: err?.message ?? 'error' });
  });
  return app;
}

const PROJECT = 'Apex';
const q = `project=${encodeURIComponent(PROJECT)}`;

beforeEach(() => {
  mockIsFeatureEnabled.mockResolvedValue(true);
});

const MOCK_ITEM = {
  id: 'item-1',
  project: PROJECT,
  itemNumber: 1,
  title: 'Test PBI',
  outcome: 'Deliver value',
  type: 'PBI',
  status: 'idea',
  owner: { oid: 'user-1', displayName: 'Aneesh', email: 'anedunur@amergis.com' },
  collaborators: [],
  acceptanceCriteria: [],
  branch: null,
  prUrl: null,
  position: 0,
  dueDate: null,
  releaseId: null,
  parentId: null,
  sourceType: 'standalone',
  prdId: null,
  backlogItemId: null,
  featureRequestId: null,
  adoWorkItemId: null,
  epicId: null,
  epicTitle: null,
  featureId: null,
  featureTitle: null,
  designDocId: null,
  designPrototypeId: null,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  createdAt: '2026-07-28T00:00:00Z',
  updatedAt: '2026-07-28T00:00:00Z',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('project scoping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when project is missing', async () => {
    const res = await request(buildApp()).get('/api/apex-work-items/owners');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project/i);
  });

  it('scopes owners list to project', async () => {
    mockListOwners.mockResolvedValue([]);
    await request(buildApp()).get(`/api/apex-work-items/owners?${q}`);
    expect(mockListOwners).toHaveBeenCalledWith(PROJECT);
  });
});

describe('GET /api/apex-work-items/owners', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with owners list', async () => {
    const owners = [{ oid: 'user-1', displayName: 'Aneesh', email: 'anedunur@amergis.com' }];
    mockListOwners.mockResolvedValue(owners);
    const res = await request(buildApp()).get(`/api/apex-work-items/owners?${q}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(owners);
  });
});

describe('GET /api/apex-work-items', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with items list', async () => {
    mockListItems.mockResolvedValue([MOCK_ITEM]);
    const res = await request(buildApp()).get(`/api/apex-work-items?${q}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('item-1');
  });

  it('forwards ownerId and project filters to service', async () => {
    mockListItems.mockResolvedValue([]);
    await request(buildApp()).get(`/api/apex-work-items?${q}&ownerId=user-1`);
    expect(mockListItems).toHaveBeenCalledWith(expect.objectContaining({
      project: PROJECT,
      ownerId: 'user-1',
    }));
  });

  it('forwards types filter to service', async () => {
    mockListItems.mockResolvedValue([]);
    await request(buildApp()).get(`/api/apex-work-items?${q}&types=PBI,TBI`);
    expect(mockListItems).toHaveBeenCalledWith(expect.objectContaining({ types: ['PBI', 'TBI'] }));
  });

  it('forwards releaseId filter to service', async () => {
    mockListItems.mockResolvedValue([]);
    await request(buildApp()).get(`/api/apex-work-items?${q}&releaseId=rel-1`);
    expect(mockListItems).toHaveBeenCalledWith(expect.objectContaining({ releaseId: 'rel-1' }));
  });
});

describe('GET /api/apex-work-items/releases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists releases for project', async () => {
    mockListReleases.mockResolvedValue([{ id: 'r1', name: 'R1', project: PROJECT }]);
    const res = await request(buildApp()).get(`/api/apex-work-items/releases?${q}`);
    expect(res.status).toBe(200);
    expect(mockListReleases).toHaveBeenCalledWith(PROJECT);
    expect(res.body).toHaveLength(1);
  });
});

describe('GET /api/apex-work-items/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with item detail', async () => {
    mockGetItem.mockResolvedValue({ ...MOCK_ITEM, events: [] });
    const res = await request(buildApp()).get(`/api/apex-work-items/item-1?${q}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('item-1');
  });

  it('returns 404 when item not found', async () => {
    const err = new Error('Work item not found') as Error & { status?: number };
    err.status = 404;
    mockGetItem.mockRejectedValue(err);
    const res = await request(buildApp()).get(`/api/apex-work-items/missing?${q}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/apex-work-items', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates item and returns 201', async () => {
    mockCreateItem.mockResolvedValue(MOCK_ITEM);
    const res = await request(buildApp())
      .post(`/api/apex-work-items?${q}`)
      .send({
        project: PROJECT,
        title: 'Test PBI',
        outcome: 'Deliver value',
        type: 'PBI',
        ownerId: 'user-1',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('item-1');
    expect(mockCreateItem).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ project: PROJECT, title: 'Test PBI' }),
    );
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(buildApp())
      .post(`/api/apex-work-items?${q}`)
      .send({ project: PROJECT, outcome: 'value', type: 'PBI', ownerId: 'user-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
  });

  it('returns 400 when type is invalid', async () => {
    const res = await request(buildApp())
      .post(`/api/apex-work-items?${q}`)
      .send({ project: PROJECT, title: 'Test', outcome: 'value', type: 'Story', ownerId: 'user-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/);
  });
});

describe('POST /api/apex-work-items/bulk', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bulk updates items for project', async () => {
    mockBulkUpdate.mockResolvedValue([MOCK_ITEM]);
    const res = await request(buildApp())
      .post(`/api/apex-work-items/bulk?${q}`)
      .send({ ids: ['item-1'], status: 'ready' });
    expect(res.status).toBe(200);
    expect(mockBulkUpdate).toHaveBeenCalledWith(
      'user-1',
      PROJECT,
      expect.objectContaining({ ids: ['item-1'], status: 'ready' }),
    );
  });
});

describe('POST /api/apex-work-items/:id/move', () => {
  beforeEach(() => jest.clearAllMocks());

  it('moves item and returns updated item', async () => {
    const moved = { ...MOCK_ITEM, status: 'ready' };
    mockMoveItem.mockResolvedValue(moved);
    const res = await request(buildApp())
      .post(`/api/apex-work-items/item-1/move?${q}`)
      .send({ targetStatus: 'ready' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('returns 400 when targetStatus is missing', async () => {
    const res = await request(buildApp())
      .post(`/api/apex-work-items/item-1/move?${q}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apex-work-items/:id/comments', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adds a comment', async () => {
    mockAddComment.mockResolvedValue({ id: 'c1', body: 'hello' });
    const res = await request(buildApp())
      .post(`/api/apex-work-items/item-1/comments?${q}`)
      .send({ body: 'hello' });
    expect(res.status).toBe(201);
    expect(mockAddComment).toHaveBeenCalled();
  });
});

describe('POST /api/apex-work-items/import/ado', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults to dry-run import', async () => {
    mockImportFromAdo.mockResolvedValue({ created: 0, updated: 0, skipped: 1, releasesCreated: 0, errors: [] });
    const res = await request(buildApp())
      .post(`/api/apex-work-items/import/ado?${q}`)
      .send({});
    expect(res.status).toBe(200);
    expect(mockImportFromAdo).toHaveBeenCalledWith(
      'user-1',
      PROJECT,
      expect.objectContaining({ dryRun: true }),
    );
  });
});

describe('POST /api/apex-work-items/materialize-from-prd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with reconcile result', async () => {
    mockMaterialize.mockResolvedValue({ created: [MOCK_ITEM], linked: [], skipped: 0 });
    const res = await request(buildApp())
      .post(`/api/apex-work-items/materialize-from-prd?${q}`)
      .send({
        project: PROJECT,
        prdId: 'prd-1',
        ownerId: 'user-1',
        items: [{ id: 'item-1', title: 'T', description: 'D', type: 'PBI', acceptanceCriteria: [] }],
      });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.linked).toEqual([]);
  });

  it('returns 400 when items is empty', async () => {
    const res = await request(buildApp())
      .post(`/api/apex-work-items/materialize-from-prd?${q}`)
      .send({ project: PROJECT, prdId: 'prd-1', ownerId: 'user-1', items: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apex-work-items/generate-drafts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns drafts from AI generation', async () => {
    const drafts = [{ id: 'd1', title: 'Draft', outcome: 'Do X', type: 'PBI', acceptanceCriteria: [] }];
    mockGenerateDrafts.mockResolvedValue(drafts);
    const res = await request(buildApp())
      .post(`/api/apex-work-items/generate-drafts?${q}`)
      .send({ project: PROJECT, featureRequestId: 'fr-1', ownerId: 'user-1', grain: 'small-set' });
    expect(res.status).toBe(200);
    expect(res.body.drafts).toHaveLength(1);
  });

  it('returns 400 when featureRequestId is missing', async () => {
    const res = await request(buildApp())
      .post(`/api/apex-work-items/generate-drafts?${q}`)
      .send({ project: PROJECT, ownerId: 'user-1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apex-work-items/create-from-drafts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates items from drafts and returns 201 reconcile result', async () => {
    mockCreateFromDrafts.mockResolvedValue({ created: [MOCK_ITEM], linked: [], skipped: 0 });
    const res = await request(buildApp())
      .post(`/api/apex-work-items/create-from-drafts?${q}`)
      .send({
        project: PROJECT,
        featureRequestId: 'fr-1',
        ownerId: 'user-1',
        drafts: [{
          project: PROJECT,
          title: 'T',
          outcome: 'O',
          type: 'PBI',
          status: 'ready',
          ownerId: 'user-1',
          acceptanceCriteria: [],
        }],
      });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
  });
});

describe('work-board feature flag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when the flag is off', async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const res = await request(buildApp()).get(`/api/apex-work-items/owners?${q}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(mockListOwners).not.toHaveBeenCalled();
  });
});
