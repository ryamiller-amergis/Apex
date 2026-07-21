/**
 * Unit tests for releaseOrderService.
 * Uses jest.doMock to isolate each test from stale mock state.
 */

jest.mock('../db/schema', () => ({
  releaseEpicOrders: {
    project: 'project',
    areaPath: 'area_path',
    adoEpicId: 'ado_epic_id',
    sortRank: 'sort_rank',
    updatedBy: 'updated_by',
    updatedAt: 'updated_at',
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: any, val: any) => ({ op: 'eq', val })),
  and: jest.fn((...args: any[]) => ({ op: 'and', args })),
  inArray: jest.fn((_col: any, vals: any) => ({ op: 'inArray', vals })),
}));

import { applyOrderToEpics } from '../services/releaseOrderService';

// ── applyOrderToEpics (pure function — no DB needed) ──────────────────────────

describe('applyOrderToEpics', () => {
  const epics = [
    { id: 1, version: 'v1' },
    { id: 2, version: 'v2' },
    { id: 3, version: 'v3' },
  ];

  it('returns epics in saved rank order', () => {
    const orders = [
      { adoEpicId: 3, sortRank: 0 },
      { adoEpicId: 1, sortRank: 1 },
      { adoEpicId: 2, sortRank: 2 },
    ];
    const result = applyOrderToEpics(epics, orders);
    expect(result.map((e) => e.id)).toEqual([3, 1, 2]);
  });

  it('appends unranked epics after ranked ones, preserving ADO order', () => {
    const orders = [{ adoEpicId: 2, sortRank: 0 }];
    const result = applyOrderToEpics(epics, orders);
    expect(result.map((e) => e.id)).toEqual([2, 1, 3]);
  });

  it('returns the same array reference when no orders exist', () => {
    expect(applyOrderToEpics(epics, [])).toBe(epics);
  });

  it('handles an empty epics list', () => {
    const orders = [{ adoEpicId: 1, sortRank: 0 }];
    expect(applyOrderToEpics([], orders)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = [...epics];
    applyOrderToEpics(epics, [{ adoEpicId: 3, sortRank: 0 }, { adoEpicId: 1, sortRank: 1 }]);
    expect(epics).toEqual(copy);
  });
});

// ── DB-dependent functions (mocked with jest.mock) ────────────────────────────

const mockDbSelect = jest.fn();
const mockDbDelete = jest.fn();
const mockDbTransaction = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: any[]) => mockDbSelect(...args),
    delete: (...args: any[]) => mockDbDelete(...args),
    transaction: (...args: any[]) => mockDbTransaction(...args),
  },
}));

import {
  getReleaseOrder,
  bulkUpdateReleaseOrder,
  pruneStaleOrders,
} from '../services/releaseOrderService';

function makeQueryChain(resolvedRows: any[]) {
  const chain: any = {};
  chain.from = jest.fn().mockReturnValue(chain);
  // .where() can be both the end of a chain (awaitable) and intermediate (chainable)
  chain.where = jest.fn().mockImplementation(() => {
    const thenableChain: any = { ...chain };
    // Make it awaitable (for queries that end with .where())
    thenableChain.then = (resolve: any) => Promise.resolve(resolvedRows).then(resolve);
    thenableChain.orderBy = jest.fn().mockResolvedValue(resolvedRows);
    return thenableChain;
  });
  chain.orderBy = jest.fn().mockResolvedValue(resolvedRows);
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

describe('getReleaseOrder', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns saved orders', async () => {
    const rows = [{ adoEpicId: 10, sortRank: 0 }, { adoEpicId: 20, sortRank: 1 }];
    makeQueryChain(rows);

    const result = await getReleaseOrder('Proj', 'Area');
    expect(result).toEqual({ project: 'Proj', areaPath: 'Area', orders: rows });
  });

  it('returns empty orders when none exist', async () => {
    makeQueryChain([]);
    const result = await getReleaseOrder('Proj', 'Area');
    expect(result.orders).toEqual([]);
  });
});

describe('bulkUpdateReleaseOrder', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls db.transaction', async () => {
    mockDbTransaction.mockResolvedValue(undefined);
    await bulkUpdateReleaseOrder('Proj', 'Area', [1, 2, 3], 'user-1');
    expect(mockDbTransaction).toHaveBeenCalled();
  });
});

describe('pruneStaleOrders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes all rows when liveEpicIds is empty', async () => {
    const deleteChain = { where: jest.fn().mockResolvedValue(undefined) };
    mockDbDelete.mockReturnValue(deleteChain);

    await pruneStaleOrders('Proj', 'Area', []);
    expect(mockDbDelete).toHaveBeenCalled();
  });

  it('does not call delete when all rows are live', async () => {
    makeQueryChain([{ adoEpicId: 10 }]);

    await pruneStaleOrders('Proj', 'Area', [10]);
    expect(mockDbDelete).not.toHaveBeenCalled();
  });

  it('calls delete for stale rows', async () => {
    makeQueryChain([{ adoEpicId: 10 }, { adoEpicId: 99 }]);
    const deleteChain = { where: jest.fn().mockResolvedValue(undefined) };
    mockDbDelete.mockReturnValue(deleteChain);

    await pruneStaleOrders('Proj', 'Area', [10]);
    expect(mockDbDelete).toHaveBeenCalled();
  });
});
