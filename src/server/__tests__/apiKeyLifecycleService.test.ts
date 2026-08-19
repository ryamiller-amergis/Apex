/**
 * Unit tests for apiKeyLifecycleService — FEAT-001 / TBI-001
 *
 * VT-01..VT-07 + DoD coverage for uniqueness, sanitization, cadence,
 * regeneration, soft delete, and cross-project isolation.
 */

import { createHash } from 'crypto';
import {
  ApiKeyValidationError,
  type ApiKeyCadence,
} from '../../shared/types/apiKey';

jest.mock('../db/drizzle', () => {
  const mockReturning = jest.fn();
  const mockLimit = jest.fn();
  const mockOrderBy = jest.fn();
  const mockWhere = jest.fn();
  mockWhere.mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy, returning: mockReturning });
  mockLimit.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockResolvedValue([]);
  mockReturning.mockResolvedValue([]);

  return {
    db: {
      select: jest.fn(() => ({ from: jest.fn(() => ({ where: mockWhere })) })),
      insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: mockReturning })) })),
      update: jest.fn(() => ({ set: jest.fn(() => ({ where: mockWhere })) })),
      delete: jest.fn(() => ({ where: mockWhere })),
      transaction: jest.fn(),
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
  isNull: jest.fn((col: unknown) => ({ _isNull: col })),
  isNotNull: jest.fn(),
  gte: jest.fn(),
  lte: jest.fn(),
  ne: jest.fn(),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      _sql: { strings, values },
    })),
    { raw: jest.fn() },
  ),
  count: jest.fn(),
  relations: jest.fn().mockReturnValue({}),
}));

import * as svc from '../services/apiKeyLifecycleService';

function getMockDb() {
  return jest.requireMock('../db/drizzle').db as {
    select: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
}

const PROJECT_A = 'project-a';
const USER_ID = 'user-1';
const KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW_ISO = '2026-08-11T14:00:00.000Z';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    projectId: PROJECT_A,
    name: 'CI',
    keyHash: createHash('sha256').update('apex_oldsecretvalue0123456789abcdef', 'utf8').digest('hex'),
    keyPrefix: 'apex_old',
    cadence: '90d' as ApiKeyCadence,
    scopes: [],
    expiresAt: '2026-11-09T14:00:00.000Z',
    createdBy: USER_ID,
    createdAt: NOW_ISO,
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function chainSelect(results: unknown[][]) {
  const db = getMockDb();
  let call = 0;
  db.select.mockImplementation(() => {
    const rows = results[call] ?? [];
    call += 1;
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn().mockResolvedValue(rows);
    const returning = jest.fn().mockResolvedValue(rows);
    const whereResult = Object.assign(Promise.resolve(rows), { limit, orderBy, returning });
    const where = jest.fn().mockReturnValue(whereResult);
    return { from: jest.fn(() => ({ where })) };
  });
}

function chainInsert(row: Record<string, unknown>) {
  const db = getMockDb();
  const returning = jest.fn().mockResolvedValue([row]);
  const values = jest.fn().mockReturnValue({ returning });
  db.insert.mockReturnValue({ values });
  return { values, returning };
}

function chainUpdate(row: Record<string, unknown> | null) {
  const db = getMockDb();
  const returning = jest.fn().mockResolvedValue(row ? [row] : []);
  const where = jest.fn().mockReturnValue({ returning, limit: jest.fn(), orderBy: jest.fn() });
  const set = jest.fn().mockReturnValue({ where });
  db.update.mockReturnValue({ set });
  return { set, where, returning };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('deriveExpiry (VT-03 / TBI-001 DoD)', () => {
  const from = new Date('2026-08-11T14:00:00.000Z');

  it.each([
    ['30d', '2026-09-10T14:00:00.000Z'],
    ['60d', '2026-10-10T14:00:00.000Z'],
    ['90d', '2026-11-09T14:00:00.000Z'],
    ['180d', '2027-02-07T14:00:00.000Z'],
    ['1y', '2027-08-11T14:00:00.000Z'],
  ] as const)('cadence %s derives expires_at from base time', (cadence, expected) => {
    const result = svc.deriveExpiry(cadence, from);
    expect(result?.toISOString()).toBe(expected);
  });

  it('cadence none → null expiration', () => {
    expect(svc.deriveExpiry('none', from)).toBeNull();
  });
});

describe('createKey (VT-01 / PBI-001 AC-0 / TBI-001 DoD-1)', () => {
  it('returns apex_-prefixed rawKey once and persists hash + prefix only', async () => {
    const inserted = makeRow({
      keyHash: 'will-be-overwritten-by-assert',
      keyPrefix: 'apex_abc',
      expiresAt: '2026-11-09T14:00:00.000Z',
    });

    // count query, then display-name lookup after insert
    chainSelect([[{ count: 0 }], [{ displayName: 'Ada Admin' }]]);
    const { values } = chainInsert(inserted);

    const result = await svc.createKey(PROJECT_A, { name: 'CI', cadence: '90d' }, USER_ID);

    expect(result.rawKey.startsWith('apex_')).toBe(true);
    expect(result.rawKey.length).toBeGreaterThan(20);
    expect(result.key.maskedPrefix).toBe('apex_abc…');
    expect(result.key.status).toBe('active');
    expect(result.key).not.toHaveProperty('rawKey');
    expect(result.key).not.toHaveProperty('keyHash');

    const persistArgs = values.mock.calls[0][0] as Record<string, unknown>;
    expect(persistArgs.keyHash).toBe(
      createHash('sha256').update(result.rawKey, 'utf8').digest('hex'),
    );
    expect(persistArgs.keyPrefix).toBe(result.rawKey.slice(0, 8));
    expect(persistArgs).not.toHaveProperty('rawKey');
    expect(String(persistArgs.expiresAt)).toBe('2026-11-09T14:00:00.000Z');
    expect(result.key.createdBy).toBe('Ada Admin');
  });
});

describe('createKey uniqueness (VT-02 / PBI-001 AC-1 / TBI-001 DoD-3)', () => {
  it('rejects NAME_TAKEN on unique violation and returns no rawKey', async () => {
    chainSelect([[{ count: 1 }]]);
    const db = getMockDb();
    const returning = jest.fn().mockRejectedValue({ code: '23505', message: 'duplicate key' });
    db.insert.mockReturnValue({ values: jest.fn().mockReturnValue({ returning }) });

    await expect(
      svc.createKey(PROJECT_A, { name: 'CI', cadence: '90d' }, USER_ID),
    ).rejects.toMatchObject({ code: 'NAME_TAKEN', name: 'ApiKeyValidationError' });
  });

  it('rejects invalid name / cadence without mutating', async () => {
    await expect(
      svc.createKey(PROJECT_A, { name: '', cadence: '90d' }, USER_ID),
    ).rejects.toBeInstanceOf(ApiKeyValidationError);

    await expect(
      svc.createKey(PROJECT_A, { name: 'x', cadence: '7d' as ApiKeyCadence }, USER_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(getMockDb().insert).not.toHaveBeenCalled();
  });
});

describe('listKeys / getKey isolation (VT-04 / PBI-001 AC-3)', () => {
  it('listKeys returns only project A rows', async () => {
    const rowA = makeRow({ id: 'id-a', name: 'A' });
    chainSelect([[rowA], [{ oid: USER_ID, displayName: 'Ada' }]]);

    const items = await svc.listKeys(PROJECT_A);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('A');
    expect(items[0].maskedPrefix).toContain('…');
    expect(items[0]).not.toHaveProperty('keyHash');
  });

  it('getKey returns null for cross-project id', async () => {
    chainSelect([[]]);
    const result = await svc.getKey(PROJECT_A, 'other-project-key');
    expect(result).toBeNull();
  });
});

describe('updateKey cadence (VT-06 / PBI-002 AC-0 / BR-005)', () => {
  it('recalculates expires_at from edit time without rotating key_hash', async () => {
    const existing = makeRow();
    chainSelect([[existing], [{ displayName: 'Ada' }]]);
    const { set } = chainUpdate({
      ...existing,
      cadence: '30d',
      expiresAt: '2026-09-10T14:00:00.000Z',
    });

    const result = await svc.updateKey(PROJECT_A, KEY_ID, { cadence: '30d' });
    expect(result.cadence).toBe('30d');
    expect(result.expiresAt).toBe('2026-09-10T14:00:00.000Z');

    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.keyHash).toBeUndefined();
    expect(patch.cadence).toBe('30d');
  });
});

describe('regenerateKey (VT-05 / PBI-002 AC-2 / BR-006)', () => {
  it('rotates secret, resets expiry, preserves provenance, restores active', async () => {
    const existing = makeRow({
      expiresAt: '2026-01-01T00:00:00.000Z', // expired
      cadence: '90d',
    });
    const oldHash = existing.keyHash;
    chainSelect([[existing], [{ displayName: 'Ada' }]]);
    const { set } = chainUpdate({
      ...existing,
      keyHash: 'new-hash',
      keyPrefix: 'apex_new',
      expiresAt: '2026-11-09T14:00:00.000Z',
    });

    const result = await svc.regenerateKey(PROJECT_A, KEY_ID);

    expect(result.rawKey.startsWith('apex_')).toBe(true);
    expect(result.key.status).toBe('active');
    expect(result.key.id).toBe(KEY_ID);
    expect(result.key.createdAt).toBe(NOW_ISO);
    expect(result.key.createdBy).toBe('Ada');

    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.keyHash).toBe(
      createHash('sha256').update(result.rawKey, 'utf8').digest('hex'),
    );
    expect(patch.keyHash).not.toBe(oldHash);
    expect(patch.keyPrefix).toBe(result.rawKey.slice(0, 8));
    expect(String(patch.expiresAt)).toBe('2026-11-09T14:00:00.000Z');
  });

  it('none cadence stays without expiration after regenerate', async () => {
    const existing = makeRow({ cadence: 'none', expiresAt: null });
    chainSelect([[existing], [{ displayName: 'Ada' }]]);
    const { set } = chainUpdate({
      ...existing,
      keyHash: 'new',
      keyPrefix: 'apex_zzz',
      expiresAt: null,
    });

    await svc.regenerateKey(PROJECT_A, KEY_ID);
    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.expiresAt).toBeNull();
  });
});

describe('deleteKey + verifyRawKey (VT-07 / BR-007)', () => {
  it('soft-deletes and verifyRawKey returns null for deleted key', async () => {
    const existing = makeRow();
    const rawKey = 'apex_testkeyvalue0123456789abcdefghijk';
    const hash = createHash('sha256').update(rawKey, 'utf8').digest('hex');

    // deleteKey: loadActiveKey
    // verifyRawKey: lookup by hash → empty (deleted filtered)
    chainSelect([[existing], []]);
    chainUpdate({ ...existing, deletedAt: NOW_ISO, deletedBy: USER_ID });

    await svc.deleteKey(PROJECT_A, KEY_ID, USER_ID);
    const verified = await svc.verifyRawKey(rawKey);
    expect(verified).toBeNull();
    void hash;
  });

  it('verifyRawKey returns apiKeyId + projectId for active key', async () => {
    const rawKey = 'apex_livekeyvalue0123456789abcdefghij';
    const hash = createHash('sha256').update(rawKey, 'utf8').digest('hex');
    chainSelect([[makeRow({ keyHash: hash, expiresAt: '2027-01-01T00:00:00.000Z' })]]);

    const verified = await svc.verifyRawKey(rawKey);
    expect(verified).toEqual({ apiKeyId: KEY_ID, projectId: PROJECT_A, scopes: [] });
  });

  it('verifyRawKey returns null for expired key', async () => {
    const rawKey = 'apex_expiredkeyvalue0123456789abcdefg';
    const hash = createHash('sha256').update(rawKey, 'utf8').digest('hex');
    chainSelect([[makeRow({ keyHash: hash, expiresAt: '2020-01-01T00:00:00.000Z' })]]);

    expect(await svc.verifyRawKey(rawKey)).toBeNull();
  });
});

describe('cross-project isolation on mutate (TBI-001 DoD-2)', () => {
  it('updateKey throws NOT_FOUND when key belongs to another project', async () => {
    chainSelect([[]]);
    await expect(
      svc.updateKey(PROJECT_A, KEY_ID, { name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getMockDb().update).not.toHaveBeenCalled();
  });
});
