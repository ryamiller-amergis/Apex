/**
 * Unit tests for loadTestTargetService — FEAT-005 Per-Project Target Allowlist
 *
 * Coverage:
 *   TBI-005 DoD-0: Admin CRUD create/update/delete
 *   TBI-005 DoD-1: Prod-tagged/patterned entries rejected
 *   TBI-005 DoD-3: Project isolation + prod refuse tests
 *   PBI-006 AC-0: Staging entry created and listed
 *   PBI-006 AC-1: Prod save rejected (no row)
 *   PBI-006 AC-2: Project B list excludes project A
 *   VT-05/VT-06: assertTargetAllowlisted active vs inactive/missing
 *   VT-07/VT-08: hostname prod segment refuse vs product-api-staging allow
 */

import { LoadTestValidationError } from '../../shared/types/loadTest';

jest.mock('../db/drizzle', () => {
  const mockReturning = jest.fn();
  const mockWhere = jest.fn();
  const mockLimit = jest.fn();
  const mockOrderBy = jest.fn();
  mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy, returning: mockReturning });
  mockLimit.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockResolvedValue([]);

  return {
    db: {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: mockWhere })) })),
      insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: mockReturning })) })),
      update: jest.fn(() => ({ set: jest.fn(() => ({ where: mockWhere })) })),
      delete: jest.fn(() => ({ where: mockWhere })),
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: mockReturning })) })),
          update: jest.fn(() => ({ set: jest.fn(() => ({ where: mockWhere })) })),
          delete: jest.fn(() => ({ where: mockWhere })),
          select: jest.fn(() => ({ from: jest.fn(() => ({ where: mockWhere })) })),
        };
        return fn(tx);
      }),
    },
  };
});

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((col: unknown, val: unknown) => ({ _eq: { col, val } })),
  and: jest.fn((...args: unknown[]) => ({ _and: args })),
  or: jest.fn((...args: unknown[]) => ({ _or: args })),
  desc: jest.fn((col: unknown) => ({ _desc: col })),
  asc: jest.fn((col: unknown) => ({ _asc: col })),
  inArray: jest.fn((col: unknown, vals: unknown[]) => ({ _inArray: { col, vals } })),
  isNull: jest.fn(),
  isNotNull: jest.fn(),
  gte: jest.fn(),
  lte: jest.fn(),
  ne: jest.fn(),
  sql: jest.fn((strings: TemplateStringsArray, ..._values: unknown[]) => ({
    strings,
    _sql: true,
  })),
  count: jest.fn(),
  relations: jest.fn().mockReturnValue({}),
}));

import {
  normalizeTargetUrl,
  isProdEnvironmentLabel,
  isProdHostname,
  assertNonProdAllowlistEntry,
  assertTargetAllowlisted,
  createTarget,
  updateTarget,
  listTargets,
  deleteTarget,
} from '../services/loadTestTargetService';

function getMockDb() {
  return jest.requireMock('../db/drizzle').db as {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  };
}

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const NOW = '2026-07-24T12:00:00.000Z';
const USER = 'admin-user';

function makeTargetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'target-1',
    projectId: PROJECT_A,
    baseUrl: 'https://api.staging.example.com',
    environmentLabel: 'staging',
    isReachable: true,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: USER,
    updatedBy: USER,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  const db = getMockDb();
  const mockReturning = jest.fn();
  const mockWhere = jest.fn();
  const mockOrderBy = jest.fn().mockResolvedValue([]);
  const mockLimit = jest.fn();
  mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy, returning: mockReturning });
  mockLimit.mockReturnValue({ orderBy: mockOrderBy });
  db.select.mockImplementation(() => ({ from: jest.fn(() => ({ where: mockWhere })) }));
  db.insert.mockImplementation(() => ({ values: jest.fn(() => ({ returning: mockReturning })) }));
  db.update.mockImplementation(() => ({ set: jest.fn(() => ({ where: mockWhere })) }));
  db.delete.mockImplementation(() => ({ where: mockWhere }));
  db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: mockReturning })) })),
      update: jest.fn(() => ({ set: jest.fn(() => ({ where: mockWhere })) })),
      delete: jest.fn(() => ({ where: mockWhere })),
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: mockWhere })) })),
    };
    return fn(tx);
  });
  (db as any)._mockReturning = mockReturning;
  (db as any)._mockWhere = mockWhere;
  (db as any)._mockOrderBy = mockOrderBy;
});

// ── Pure helpers (TBI-005 DoD-1, VT-07, VT-08) ─────────────────────────────────

describe('normalizeTargetUrl', () => {
  it('strips path/query/fragment and trailing slash (canonical origin)', () => {
    expect(normalizeTargetUrl('https://api.staging.example.com/v1/foo?x=1#h')).toBe(
      'https://api.staging.example.com',
    );
    expect(normalizeTargetUrl('https://api.staging.example.com/')).toBe(
      'https://api.staging.example.com',
    );
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeTargetUrl('ftp://api.example.com')).toThrow(LoadTestValidationError);
  });
});

describe('isProdEnvironmentLabel (DoD-1 / AC-1)', () => {
  it('refuses prod, production, prd and prefixed variants', () => {
    expect(isProdEnvironmentLabel('prod')).toBe(true);
    expect(isProdEnvironmentLabel('production')).toBe(true);
    expect(isProdEnvironmentLabel('prd')).toBe(true);
    expect(isProdEnvironmentLabel('prod-east')).toBe(true);
    expect(isProdEnvironmentLabel('production_us')).toBe(true);
  });

  it('allows non-prod labels including names that contain prod as a substring of another word', () => {
    expect(isProdEnvironmentLabel('staging')).toBe(false);
    expect(isProdEnvironmentLabel('dev')).toBe(false);
    expect(isProdEnvironmentLabel('product-preview')).toBe(false);
  });
});

describe('isProdHostname (VT-07 / VT-08)', () => {
  it('VT-07: refuses hostname with prod segment even when env looks non-prod', () => {
    expect(isProdHostname('api.prod.contoso.com')).toBe(true);
    expect(isProdHostname('api.production.contoso.com')).toBe(true);
    expect(isProdHostname('svc-prod.contoso.com')).toBe(true);
  });

  it('VT-08: allows product-api-staging (delimiter-safe)', () => {
    expect(isProdHostname('product-api-staging.contoso.com')).toBe(false);
  });
});

describe('assertNonProdAllowlistEntry (DoD-1)', () => {
  it('throws LOAD_TEST_TARGET_PROD_REFUSED for prod environment label', () => {
    expect(() =>
      assertNonProdAllowlistEntry({
        baseUrl: 'https://api.staging.example.com',
        environmentLabel: 'prod',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'LOAD_TEST_TARGET_PROD_REFUSED',
      }),
    );
  });

  it('throws LOAD_TEST_TARGET_PROD_REFUSED for prod hostname with staging label', () => {
    expect(() =>
      assertNonProdAllowlistEntry({
        baseUrl: 'https://api.prod.contoso.com',
        environmentLabel: 'staging',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'LOAD_TEST_TARGET_PROD_REFUSED',
      }),
    );
  });

  it('allows staging origin + staging label', () => {
    expect(() =>
      assertNonProdAllowlistEntry({
        baseUrl: 'https://api.staging.example.com',
        environmentLabel: 'staging',
      }),
    ).not.toThrow();
  });
});

// ── assertTargetAllowlisted (VT-05 / VT-06, BR-002) ────────────────────────────

describe('assertTargetAllowlisted', () => {
  it('VT-05: resolves when active allowlisted staging origin exists', async () => {
    const db = getMockDb();
    (db as any)._mockOrderBy.mockResolvedValue([makeTargetRow()]);

    await expect(
      assertTargetAllowlisted(PROJECT_A, 'https://api.staging.example.com/'),
    ).resolves.toBeUndefined();
  });

  it('VT-06: throws when allowlist row is inactive', async () => {
    const db = getMockDb();
    (db as any)._mockOrderBy.mockResolvedValue([makeTargetRow({ isActive: false })]);

    await expect(
      assertTargetAllowlisted(PROJECT_A, 'https://api.staging.example.com'),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_TARGET_NOT_ALLOWLISTED' });
  });

  it('VT-06: throws when no matching allowlist row', async () => {
    const db = getMockDb();
    (db as any)._mockOrderBy.mockResolvedValue([]);

    await expect(
      assertTargetAllowlisted(PROJECT_A, 'https://api.staging.example.com'),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_TARGET_NOT_ALLOWLISTED' });
  });
});

// ── CRUD (DoD-0, AC-0, AC-1, AC-2) ─────────────────────────────────────────────

describe('createTarget', () => {
  it('AC-0 / DoD-0: creates staging entry with normalized base URL', async () => {
    const row = makeTargetRow();
    const db = getMockDb();
    (db as any)._mockReturning.mockResolvedValue([row]);

    const result = await createTarget(
      PROJECT_A,
      {
        baseUrl: 'https://api.staging.example.com/',
        environmentLabel: 'staging',
      },
      USER,
    );

    expect(result.baseUrl).toBe('https://api.staging.example.com');
    expect(result.environmentLabel).toBe('staging');
    expect(result.projectId).toBe(PROJECT_A);
  });

  it('AC-1 / DoD-1: rejects prod-tagged entry and does not insert', async () => {
    const db = getMockDb();

    await expect(
      createTarget(
        PROJECT_A,
        { baseUrl: 'https://api.staging.example.com', environmentLabel: 'prod' },
        USER,
      ),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_TARGET_PROD_REFUSED' });

    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('updateTarget (DoD-0)', () => {
  it('updates environment label when non-prod', async () => {
    const existing = makeTargetRow();
    const updated = makeTargetRow({ environmentLabel: 'qa', updatedBy: USER });
    const db = getMockDb();
    const mockWhere = (db as any)._mockWhere as jest.Mock;
    mockWhere
      .mockReturnValueOnce({
        limit: jest.fn().mockResolvedValue([existing]),
        orderBy: jest.fn(),
        returning: jest.fn(),
      })
      .mockReturnValueOnce({
        returning: jest.fn().mockResolvedValue([updated]),
        limit: jest.fn(),
        orderBy: jest.fn(),
      });

    // Simpler path: transaction returning updated row after select finds existing
    db.transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: jest.fn(() => ({
          from: jest.fn(() => ({
            where: jest.fn(() => ({
              limit: jest.fn().mockResolvedValue([existing]),
            })),
          })),
        })),
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({
              returning: jest.fn().mockResolvedValue([updated]),
            })),
          })),
        })),
      };
      return fn(tx);
    });

    const result = await updateTarget(
      PROJECT_A,
      'target-1',
      { environmentLabel: 'qa' },
      USER,
    );
    expect(result).not.toBeNull();
    expect(result!.environmentLabel).toBe('qa');
  });

  it('refuses update that would set prod hostname', async () => {
    await expect(
      updateTarget(
        PROJECT_A,
        'target-1',
        { baseUrl: 'https://api.prod.contoso.com' },
        USER,
      ),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_TARGET_PROD_REFUSED' });
  });
});

describe('listTargets (AC-2 / DoD-3 project isolation)', () => {
  it('AC-2: returns only rows for the requested projectId', async () => {
    const db = getMockDb();
    const rows = [makeTargetRow({ projectId: PROJECT_A })];
    (db as any)._mockOrderBy.mockResolvedValue(rows);

    const result = await listTargets(PROJECT_A);
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe(PROJECT_A);

    // Project B gets empty when mock returns empty
    (db as any)._mockOrderBy.mockResolvedValue([]);
    const bResult = await listTargets(PROJECT_B);
    expect(bResult).toEqual([]);
  });

  it('excludes inactive rows by default; includes when includeInactive=true', async () => {
    const db = getMockDb();
    const active = makeTargetRow({ id: 'a1', isActive: true });
    const inactive = makeTargetRow({ id: 'a2', isActive: false });
    (db as any)._mockOrderBy.mockResolvedValue([active, inactive]);

    const authors = await listTargets(PROJECT_A);
    expect(authors.map((t) => t.id)).toEqual(['a1']);

    (db as any)._mockOrderBy.mockResolvedValue([active, inactive]);
    const admin = await listTargets(PROJECT_A, { includeInactive: true });
    expect(admin.map((t) => t.id)).toEqual(['a1', 'a2']);
  });
});

describe('deleteTarget (DoD-0)', () => {
  it('deletes by id scoped to project and returns true', async () => {
    const db = getMockDb();
    (db as any)._mockWhere.mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 'target-1' }]),
      limit: jest.fn(),
      orderBy: jest.fn(),
    });

    await expect(deleteTarget(PROJECT_A, 'target-1')).resolves.toBe(true);
    expect(db.delete).toHaveBeenCalled();
  });

  it('returns false when no row in project', async () => {
    const db = getMockDb();
    (db as any)._mockWhere.mockReturnValue({
      returning: jest.fn().mockResolvedValue([]),
      limit: jest.fn(),
      orderBy: jest.fn(),
    });

    await expect(deleteTarget(PROJECT_A, 'missing')).resolves.toBe(false);
  });
});
