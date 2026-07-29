/**
 * Integration-style tests for /api/apex-work-items routes.
 * All database and notification services are mocked.
 */
import request from 'supertest';
import express from 'express';
import apexWorkItemsRouter from '../routes/apexWorkItems';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../middleware/rbac', () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const mockListItems = jest.fn();
const mockGetItem = jest.fn();
const mockCreateItem = jest.fn();
const mockUpdateItem = jest.fn();
const mockMoveItem = jest.fn();
const mockListOwners = jest.fn();
const mockListFacets = jest.fn();
const mockMaterialize = jest.fn();
const mockGetMaterialized = jest.fn();
const mockGenerateDrafts = jest.fn();
const mockCreateFromDrafts = jest.fn();

jest.mock('../services/apexWorkItemService', () => ({
  listApexWorkItems: (...a: any[]) => mockListItems(...a),
  getApexWorkItem: (...a: any[]) => mockGetItem(...a),
  createApexWorkItem: (...a: any[]) => mockCreateItem(...a),
  updateApexWorkItem: (...a: any[]) => mockUpdateItem(...a),
  moveApexWorkItem: (...a: any[]) => mockMoveItem(...a),
  listEligibleOwners: (...a: any[]) => mockListOwners(...a),
  listFilterFacets: (...a: any[]) => mockListFacets(...a),
  materializeFromPrdWithItems: (...a: any[]) => mockMaterialize(...a),
  getMaterializedItemIds: (...a: any[]) => mockGetMaterialized(...a),
  generateDraftsFromFeatureRequest: (...a: any[]) => mockGenerateDrafts(...a),
  createFromDrafts: (...a: any[]) => mockCreateFromDrafts(...a),
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
  return app;
}

const MOCK_ITEM = {
  id: 'item-1',
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
  sourceType: 'standalone',
  prdId: null,
  backlogItemId: null,
  featureRequestId: null,
  epicId: null,
  epicTitle: null,
  featureId: null,
  featureTitle: null,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  createdAt: '2026-07-28T00:00:00Z',
  updatedAt: '2026-07-28T00:00:00Z',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/apex-work-items/owners', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with owners list', async () => {
    const owners = [{ oid: 'user-1', displayName: 'Aneesh', email: 'anedunur@amergis.com' }];
    mockListOwners.mockResolvedValue(owners);
    const res = await request(buildApp()).get('/api/apex-work-items/owners');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(owners);
  });

  it('returns empty array when no eligible owners', async () => {
    mockListOwners.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/apex-work-items/owners');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/apex-work-items', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with items list', async () => {
    mockListItems.mockResolvedValue([MOCK_ITEM]);
    const res = await request(buildApp()).get('/api/apex-work-items');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('item-1');
  });

  it('forwards ownerId filter to service', async () => {
    mockListItems.mockResolvedValue([]);
    await request(buildApp()).get('/api/apex-work-items?ownerId=user-1');
    expect(mockListItems).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'user-1' }));
  });

  it('forwards types filter to service', async () => {
    mockListItems.mockResolvedValue([]);
    await request(buildApp()).get('/api/apex-work-items?types=PBI,TBI');
    expect(mockListItems).toHaveBeenCalledWith(expect.objectContaining({ types: ['PBI', 'TBI'] }));
  });
});

describe('GET /api/apex-work-items/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with item detail', async () => {
    mockGetItem.mockResolvedValue({ ...MOCK_ITEM, events: [] });
    const res = await request(buildApp()).get('/api/apex-work-items/item-1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('item-1');
  });

  it('returns 404 when item not found', async () => {
    const err = new Error('Work item not found') as Error & { status?: number };
    err.status = 404;
    mockGetItem.mockRejectedValue(err);
    const res = await request(buildApp()).get('/api/apex-work-items/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/apex-work-items', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates item and returns 201', async () => {
    mockCreateItem.mockResolvedValue(MOCK_ITEM);
    const res = await request(buildApp())
      .post('/api/apex-work-items')
      .send({ title: 'Test PBI', outcome: 'Deliver value', type: 'PBI', ownerId: 'user-1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('item-1');
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(buildApp())
      .post('/api/apex-work-items')
      .send({ outcome: 'value', type: 'PBI', ownerId: 'user-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/);
  });

  it('returns 400 when type is invalid', async () => {
    const res = await request(buildApp())
      .post('/api/apex-work-items')
      .send({ title: 'Test', outcome: 'value', type: 'Epic', ownerId: 'user-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/);
  });
});

describe('POST /api/apex-work-items/:id/move', () => {
  beforeEach(() => jest.clearAllMocks());

  it('moves item and returns updated item', async () => {
    const moved = { ...MOCK_ITEM, status: 'ready' };
    mockMoveItem.mockResolvedValue(moved);
    const res = await request(buildApp())
      .post('/api/apex-work-items/item-1/move')
      .send({ targetStatus: 'ready' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('returns 400 when targetStatus is missing', async () => {
    const res = await request(buildApp())
      .post('/api/apex-work-items/item-1/move')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apex-work-items/materialize-from-prd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 201 with created items', async () => {
    mockMaterialize.mockResolvedValue([MOCK_ITEM]);
    const res = await request(buildApp())
      .post('/api/apex-work-items/materialize-from-prd')
      .send({
        prdId: 'prd-1',
        ownerId: 'user-1',
        items: [{ id: 'item-1', title: 'T', description: 'D', type: 'PBI', acceptanceCriteria: [] }],
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
  });

  it('returns 400 when items is empty', async () => {
    const res = await request(buildApp())
      .post('/api/apex-work-items/materialize-from-prd')
      .send({ prdId: 'prd-1', ownerId: 'user-1', items: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apex-work-items/generate-drafts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns drafts from AI generation', async () => {
    const drafts = [{ id: 'd1', title: 'Draft', outcome: 'Do X', type: 'PBI', acceptanceCriteria: [] }];
    mockGenerateDrafts.mockResolvedValue(drafts);
    const res = await request(buildApp())
      .post('/api/apex-work-items/generate-drafts')
      .send({ featureRequestId: 'fr-1', ownerId: 'user-1', grain: 'small-set' });
    expect(res.status).toBe(200);
    expect(res.body.drafts).toHaveLength(1);
  });

  it('returns 400 when featureRequestId is missing', async () => {
    const res = await request(buildApp())
      .post('/api/apex-work-items/generate-drafts')
      .send({ ownerId: 'user-1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apex-work-items/create-from-drafts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates items from drafts and returns 201', async () => {
    mockCreateFromDrafts.mockResolvedValue([MOCK_ITEM]);
    const res = await request(buildApp())
      .post('/api/apex-work-items/create-from-drafts')
      .send({
        featureRequestId: 'fr-1',
        ownerId: 'user-1',
        drafts: [{ title: 'T', outcome: 'O', type: 'PBI', status: 'ready', ownerId: 'user-1', acceptanceCriteria: [] }],
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
  });
});
