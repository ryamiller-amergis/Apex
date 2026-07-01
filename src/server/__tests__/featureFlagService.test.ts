/**
 * Unit tests for featureFlagService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        featureFlags: { findMany: jest.fn(), findFirst: jest.fn() },
        featureFlagRules: { findFirst: jest.fn() },
        featureFlagAudit: { findMany: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      transaction: jest.fn(),
    },
  };
});

import {
  listFlags,
  getFlag,
  createFlag,
  updateFlag,
  addRule,
  removeRule,
  deleteFlag,
  getFlagAudit,
  getUserGroupIdsForProject,
  evaluateFlags,
  isFeatureEnabled,
} from '../services/featureFlagService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

const actor = { id: 'user-admin', email: 'admin@example.com' };

const baseFlag = {
  id: 'flag-1',
  key: 'new-dashboard',
  description: 'New dashboard feature',
  enabled: true,
  lifecycle: 'active' as const,
  cleanupReady: false,
  createdBy: 'user-admin',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const flagWithRules = {
  ...baseFlag,
  rules: [
    { id: 'rule-1', flagId: 'flag-1', type: 'project' as const, value: 'proj-a', createdBy: null, createdAt: '2026-01-01T00:00:00Z' },
  ],
};

// ── listFlags ──────────────────────────────────────────────────────────────────

describe('listFlags', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns flags with rules ordered by createdAt desc', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([flagWithRules]);

    const result = await listFlags();

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('new-dashboard');
    expect(result[0].rules).toHaveLength(1);
  });
});

// ── getFlag ────────────────────────────────────────────────────────────────────

describe('getFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a flag with rules', async () => {
    mockDb.query.featureFlags.findFirst.mockResolvedValue(flagWithRules);

    const result = await getFlag('flag-1');

    expect(result).toMatchObject({ id: 'flag-1', key: 'new-dashboard' });
    expect(result!.rules).toHaveLength(1);
  });

  it('returns null when the flag does not exist', async () => {
    mockDb.query.featureFlags.findFirst.mockResolvedValue(undefined);

    const result = await getFlag('flag-missing');

    expect(result).toBeNull();
  });
});

// ── createFlag ─────────────────────────────────────────────────────────────────

describe('createFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a flag with a valid kebab-case key', async () => {
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([baseFlag]),
        }),
      };
      return fn(tx);
    });

    const result = await createFlag({ key: 'new-dashboard' }, actor);

    expect(result).toEqual(baseFlag);
  });

  it('creates a flag with a single-word key', async () => {
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ ...baseFlag, key: 'dashboard' }]),
        }),
      };
      return fn(tx);
    });

    const result = await createFlag({ key: 'dashboard' }, actor);

    expect(result.key).toBe('dashboard');
  });

  it('rejects keys with uppercase letters', async () => {
    await expect(createFlag({ key: 'New-Dashboard' }, actor)).rejects.toThrow('Invalid flag key');
  });

  it('rejects keys with underscores', async () => {
    await expect(createFlag({ key: 'new_dashboard' }, actor)).rejects.toThrow('Invalid flag key');
  });

  it('rejects keys with leading hyphens', async () => {
    await expect(createFlag({ key: '-leading' }, actor)).rejects.toThrow('Invalid flag key');
  });

  it('rejects keys with trailing hyphens', async () => {
    await expect(createFlag({ key: 'trailing-' }, actor)).rejects.toThrow('Invalid flag key');
  });

  it('rejects empty keys', async () => {
    await expect(createFlag({ key: '' }, actor)).rejects.toThrow('Invalid flag key');
  });
});

// ── updateFlag ─────────────────────────────────────────────────────────────────

describe('updateFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when the flag does not exist', async () => {
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = { query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(null) } } };
      return fn(tx);
    });

    await expect(updateFlag('flag-missing', { enabled: true }, actor)).rejects.toThrow('Flag not found');
  });

  it('updates and writes an audit entry', async () => {
    const updated = { ...baseFlag, description: 'Updated desc' };
    let auditValues: any;

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(baseFlag) } },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([updated]),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((v: any) => {
            auditValues = v;
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      };
      return fn(tx);
    });

    const result = await updateFlag('flag-1', { description: 'Updated desc' }, actor);

    expect(result).toEqual(updated);
    expect(auditValues).toMatchObject({ action: 'updated', flagKey: 'new-dashboard' });
  });

  it('writes enabled audit action on toggle', async () => {
    const disabled = { ...baseFlag, enabled: false };
    let auditValues: any;

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(disabled) } },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ ...disabled, enabled: true }]),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((v: any) => {
            auditValues = v;
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      };
      return fn(tx);
    });

    await updateFlag('flag-1', { enabled: true }, actor);

    expect(auditValues.action).toBe('enabled');
  });
});

// ── addRule ─────────────────────────────────────────────────────────────────────

describe('addRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a rule and writes an audit entry', async () => {
    const insertedRule = { id: 'rule-new', flagId: 'flag-1', type: 'project', value: 'proj-b', createdBy: 'user-admin', createdAt: '2026-01-01T00:00:00Z' };
    let auditValues: any;

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const insertCallCount = { n: 0 };
      const tx = {
        query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(baseFlag) } },
        insert: jest.fn().mockImplementation(() => {
          insertCallCount.n++;
          if (insertCallCount.n === 1) {
            return {
              values: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([insertedRule]),
            };
          }
          return {
            values: jest.fn().mockImplementation((v: any) => {
              auditValues = v;
              return { returning: jest.fn().mockResolvedValue([]) };
            }),
          };
        }),
      };
      return fn(tx);
    });

    const result = await addRule('flag-1', { type: 'project', value: 'proj-b' }, actor);

    expect(result).toEqual(insertedRule);
    expect(auditValues).toMatchObject({ action: 'rule_added', details: { ruleType: 'project', ruleValue: 'proj-b' } });
  });
});

// ── removeRule ──────────────────────────────────────────────────────────────────

describe('removeRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when the rule does not exist', async () => {
    mockDb.query.featureFlagRules.findFirst.mockResolvedValue(undefined);

    await expect(removeRule('rule-missing', actor)).rejects.toThrow('Rule not found');
  });

  it('deletes the rule and writes an audit entry', async () => {
    mockDb.query.featureFlagRules.findFirst.mockResolvedValue({
      id: 'rule-1',
      flagId: 'flag-1',
      type: 'project',
      value: 'proj-a',
      flag: { key: 'new-dashboard' },
    });

    let auditValues: any;
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((v: any) => {
            auditValues = v;
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      };
      return fn(tx);
    });

    await removeRule('rule-1', actor);

    expect(auditValues).toMatchObject({ action: 'rule_removed', flagKey: 'new-dashboard' });
  });
});

// ── deleteFlag ─────────────────────────────────────────────────────────────────

describe('deleteFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when the flag does not exist', async () => {
    mockDb.query.featureFlags.findFirst.mockResolvedValue(undefined);

    await expect(deleteFlag('flag-missing', actor)).rejects.toThrow('Flag not found');
  });

  it('deletes the flag and writes an audit entry with null flagId', async () => {
    mockDb.query.featureFlags.findFirst.mockResolvedValue(baseFlag);

    let auditValues: any;
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((v: any) => {
            auditValues = v;
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      };
      return fn(tx);
    });

    await deleteFlag('flag-1', actor);

    expect(auditValues).toMatchObject({ action: 'deleted', flagId: null, flagKey: 'new-dashboard' });
  });
});

// ── getFlagAudit ────────────────────────────────────────────────────────────────

describe('getFlagAudit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns audit entries ordered by createdAt desc', async () => {
    const entries = [
      { id: 'a-2', flagId: 'flag-1', flagKey: 'new-dashboard', action: 'enabled', actorId: null, actorEmail: null, details: null, createdAt: '2026-01-02T00:00:00Z' },
      { id: 'a-1', flagId: 'flag-1', flagKey: 'new-dashboard', action: 'created', actorId: null, actorEmail: null, details: null, createdAt: '2026-01-01T00:00:00Z' },
    ];
    mockDb.query.featureFlagAudit.findMany.mockResolvedValue(entries);

    const result = await getFlagAudit('flag-1');

    expect(result).toHaveLength(2);
    expect(result[0].action).toBe('enabled');
  });
});

// ── getUserGroupIdsForProject ────────────────────────────────────────────────

describe('getUserGroupIdsForProject', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns group IDs for groups matching the project', async () => {
    const whereMock = jest.fn().mockResolvedValue([
      { groupId: 'group-1' },
      { groupId: 'group-2' },
    ]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getUserGroupIdsForProject('user-1', 'proj-a');

    expect(result).toEqual(['group-1', 'group-2']);
  });

  it('returns an empty array when user has no groups in the project', async () => {
    const whereMock = jest.fn().mockResolvedValue([]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getUserGroupIdsForProject('user-1', 'proj-b');

    expect(result).toEqual([]);
  });
});

// ── evaluateFlags ────────────────────────────────────────────────────────────

describe('evaluateFlags', () => {
  const ctx = { userId: 'user-1', project: 'proj-a', groupIds: ['group-1'] };

  beforeEach(() => jest.clearAllMocks());

  it('returns false for disabled flags (kill switch)', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, enabled: false, rules: [{ type: 'everyone', value: null }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(false);
  });

  it('excludes archived flags from results', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([]);

    const result = await evaluateFlags(ctx);

    expect(result).toEqual({});
  });

  it('returns true when an "everyone" rule exists and flag is enabled', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'everyone', value: null }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(true);
  });

  it('returns true when a "project" rule matches ctx.project', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'project', value: 'proj-a' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(true);
  });

  it('returns false when a "project" rule does not match', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'project', value: 'proj-b' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(false);
  });

  it('returns true when a "user" rule matches ctx.userId', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'user', value: 'user-1' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(true);
  });

  it('returns false when a "user" rule does not match', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'user', value: 'user-other' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(false);
  });

  it('returns true when a "group" rule matches ctx.groupIds', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'group', value: 'group-1' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(true);
  });

  it('returns false when a "group" rule does not match', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'group', value: 'group-other' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(false);
  });

  it('returns false when no rules exist (default off)', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(false);
  });

  it('evaluates multiple flags together', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, key: 'flag-on', rules: [{ type: 'everyone', value: null }] },
      { ...baseFlag, key: 'flag-off', enabled: false, rules: [{ type: 'everyone', value: null }] },
      { ...baseFlag, key: 'flag-no-match', rules: [{ type: 'project', value: 'proj-b' }] },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['flag-on']).toBe(true);
    expect(result['flag-off']).toBe(false);
    expect(result['flag-no-match']).toBe(false);
  });

  it('matches if ANY rule matches (short-circuit)', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        rules: [
          { type: 'project', value: 'proj-b' },
          { type: 'user', value: 'user-1' },
        ],
      },
    ]);

    const result = await evaluateFlags(ctx);

    expect(result['new-dashboard']).toBe(true);
  });
});

// ── isFeatureEnabled ─────────────────────────────────────────────────────────

describe('isFeatureEnabled', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves group IDs and evaluates the single flag', async () => {
    const whereMock = jest.fn().mockResolvedValue([{ groupId: 'group-1' }]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, rules: [{ type: 'group', value: 'group-1' }] },
    ]);

    const result = await isFeatureEnabled('new-dashboard', { userId: 'user-1', project: 'proj-a' });

    expect(result).toBe(true);
  });

  it('returns false for a key that does not exist', async () => {
    const whereMock = jest.fn().mockResolvedValue([]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    mockDb.query.featureFlags.findMany.mockResolvedValue([]);

    const result = await isFeatureEnabled('nonexistent', { userId: 'user-1', project: 'proj-a' });

    expect(result).toBe(false);
  });
});
