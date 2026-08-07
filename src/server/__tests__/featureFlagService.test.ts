/**
 * Unit tests for featureFlagService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
  isGroundingEnabledForCaller,
  isLifecycleBindingEnabledForCaller,
  isFeatureOperational,
  isRemoteSearchConvergenceEnabled,
  isNativeReadEnabledForCaller,
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

  it('BR-009 / security NFR audits an independently reversible kill-switch disable', async () => {
    let auditValues: any;

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(baseFlag) } },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ ...baseFlag, enabled: false }]),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((value: any) => {
            auditValues = value;
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      };
      return fn(tx);
    });

    await updateFlag('flag-1', { enabled: false }, actor);

    expect(auditValues).toMatchObject({
      action: 'disabled',
      actorId: actor.id,
      actorEmail: actor.email,
    });
  });

  it('TBI-007 DoD-3 / VT-08 audits lifecycle changes with actor and before/after state', async () => {
    let auditValues: any;

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(baseFlag) } },
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue([{ ...baseFlag, lifecycle: 'stale' }]),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockImplementation((value: any) => {
            auditValues = value;
            return { returning: jest.fn().mockResolvedValue([]) };
          }),
        }),
      };
      return fn(tx);
    });

    await updateFlag('flag-1', { lifecycle: 'stale' }, actor);

    expect(auditValues).toMatchObject({
      action: 'lifecycle_changed',
      actorId: actor.id,
      actorEmail: actor.email,
      details: {
        previousValue: 'active',
        newValue: 'stale',
      },
    });
  });
});

// ── addRule ─────────────────────────────────────────────────────────────────────

describe('addRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('BR-009 / security NFR manually adds a reversible stage with actor audit context', async () => {
    const insertedRule = { id: 'rule-new', flagId: 'flag-1', type: 'project', value: 'proj-b', createdBy: 'user-admin', createdAt: '2026-01-01T00:00:00Z' };
    let auditValues: any;
    const update = jest.fn();

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const insertCallCount = { n: 0 };
      const tx = {
        query: { featureFlags: { findFirst: jest.fn().mockResolvedValue(baseFlag) } },
        update,
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
    expect(auditValues).toMatchObject({
      action: 'rule_added',
      actorId: actor.id,
      actorEmail: actor.email,
      details: { ruleType: 'project', ruleValue: 'proj-b' },
    });
    expect(update).not.toHaveBeenCalled();
  });
});

// ── removeRule ──────────────────────────────────────────────────────────────────

describe('removeRule', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws when the rule does not exist', async () => {
    mockDb.query.featureFlagRules.findFirst.mockResolvedValue(undefined);

    await expect(removeRule('rule-missing', actor)).rejects.toThrow('Rule not found');
  });

  it('BR-009 removes one stage rule independently and audits the reversal', async () => {
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

  it('DoD-0 keeps disabled flags and enabled flags without rules dark-shipped', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      { ...baseFlag, key: 'disabled-flag', enabled: false, rules: [{ type: 'everyone', value: null }] },
      { ...baseFlag, key: 'no-rules-flag', enabled: true, rules: [] },
    ]);

    const result = await evaluateFlags({
      ...ctx,
      caller: 'interview',
      environment: 'dev',
    });

    expect(result).toEqual({
      'disabled-flag': false,
      'no-rules-flag': false,
    });
  });

  it('TBI-007 DoD-0 / DoD-1 / VT-07 ANDs project audience with workflow caller targeting', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        key: 'ai-runs-background',
        rules: [
          { type: 'project', value: 'internal-project' },
          { type: 'caller', value: 'validation' },
        ],
      },
    ]);

    const matching = await evaluateFlags({
      ...ctx,
      project: 'internal-project',
      caller: 'validation',
    });
    const wrongProject = await evaluateFlags({
      ...ctx,
      project: 'other-project',
      caller: 'validation',
    });
    const wrongWorkflow = await evaluateFlags({
      ...ctx,
      project: 'internal-project',
      caller: 'prd',
    });

    expect(matching['ai-runs-background']).toBe(true);
    expect(wrongProject['ai-runs-background']).toBe(false);
    expect(wrongWorkflow['ai-runs-background']).toBe(false);
  });

  it('AC-0 selects local only when caller, project, and environment dimensions match', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        key: 'repo-grounding-workspace-profile',
        rules: [
          { type: 'caller', value: 'interview' },
          { type: 'caller', value: 'design-doc' },
          { type: 'environment', value: 'dev' },
          { type: 'project', value: 'proj-a' },
          { type: 'user', value: 'another-user' },
        ],
      },
    ]);

    const matching = await evaluateFlags({
      ...ctx,
      caller: 'interview',
      environment: 'dev',
    });
    const wrongCaller = await evaluateFlags({
      ...ctx,
      caller: 'ask-apex',
      environment: 'dev',
    });
    const wrongProject = await evaluateFlags({
      ...ctx,
      project: 'proj-b',
      caller: 'interview',
      environment: 'dev',
    });
    const wrongEnvironment = await evaluateFlags({
      ...ctx,
      caller: 'interview',
      environment: 'prod',
    });

    expect(matching['repo-grounding-workspace-profile']).toBe(true);
    expect(wrongCaller['repo-grounding-workspace-profile']).toBe(false);
    expect(wrongProject['repo-grounding-workspace-profile']).toBe(false);
    expect(wrongEnvironment['repo-grounding-workspace-profile']).toBe(false);
  });

  it('DoD-2 applies the disabled kill switch before matching rollout dimensions', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        key: 'repo-grounding-workspace-profile',
        enabled: false,
        rules: [
          { type: 'caller', value: 'interview' },
          { type: 'environment', value: 'dev' },
          { type: 'project', value: 'proj-a' },
        ],
      },
    ]);

    const result = await evaluateFlags({
      ...ctx,
      caller: 'interview',
      environment: 'dev',
    });

    expect(result['repo-grounding-workspace-profile']).toBe(false);
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

describe('grounding rollout accessors', () => {
  const originalAppEnv = process.env.APP_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_ENV = 'dev';

    const whereMock = jest.fn().mockResolvedValue([]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });
  });

  afterAll(() => {
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }
  });

  it('AC-1 fails closed and reports an evaluation error without exposing the error', async () => {
    mockDb.query.featureFlags.findMany.mockRejectedValue(new Error('postgres://secret-host'));
    const onEvaluationError = jest.fn();

    const enabled = await isGroundingEnabledForCaller(
      { userId: 'user-1', project: 'proj-a', caller: 'interview' },
      onEvaluationError,
    );

    expect(enabled).toBe(false);
    expect(onEvaluationError).toHaveBeenCalledWith();
  });

  it('TBI-004 DoD-3 / VT-07 evaluates the lifecycle binding rollout independently', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        key: 'repo-grounding-lifecycle-binding',
        rules: [
          { type: 'caller', value: 'interview' },
          { type: 'environment', value: 'dev' },
          { type: 'project', value: 'proj-a' },
        ],
      },
    ]);

    const enabled = await isLifecycleBindingEnabledForCaller({
      userId: 'user-1',
      project: 'proj-a',
      caller: 'interview',
    });

    expect(enabled).toBe(true);
  });

  it('TBI-004 DoD-3 / VT-07 fails the lifecycle binding rollout closed', async () => {
    mockDb.query.featureFlags.findMany.mockRejectedValue(new Error('database unavailable'));
    const onEvaluationError = jest.fn();

    const enabled = await isLifecycleBindingEnabledForCaller(
      { userId: 'user-1', project: 'proj-a', caller: 'interview' },
      onEvaluationError,
    );

    expect(enabled).toBe(false);
    expect(onEvaluationError).toHaveBeenCalledTimes(1);
  });

  it('TBI-004 DoD-3 seeds the lifecycle binding flag disabled and active', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'migrations/20260803150000_seed-repo-grounding-lifecycle-binding-flag.sql',
      ),
      'utf8',
    );

    expect(migration).toMatch(/'repo-grounding-lifecycle-binding'/);
    expect(migration).toMatch(/false,\s*'active',\s*false/);
    expect(migration).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
  });

  it('TBI-005 DoD-0 seeds native-read active and default-off with reversible cleanup', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'migrations/20260803160000_seed-native-read-flag.sql'),
      'utf8',
    );

    expect(migration).toMatch(/'native-read'/);
    expect(migration).toMatch(/false,\s*'active',\s*false/);
    expect(migration).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
    expect(migration).toMatch(
      /DELETE FROM feature_flag_rules[\s\S]*WHERE key = 'native-read'/,
    );
    expect(migration).toMatch(/DELETE FROM feature_flags\s+WHERE key = 'native-read'/);
  });

  it('AC-2 resolves the same caller independently across projects', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        key: 'repo-grounding-workspace-profile',
        rules: [
          { type: 'caller', value: 'interview' },
          { type: 'environment', value: 'dev' },
          { type: 'project', value: 'proj-a' },
        ],
      },
    ]);

    const projectA = await isGroundingEnabledForCaller({
      userId: 'user-1',
      project: 'proj-a',
      caller: 'interview',
    });
    const projectB = await isGroundingEnabledForCaller({
      userId: 'user-1',
      project: 'proj-b',
      caller: 'interview',
    });

    expect(projectA).toBe(true);
    expect(projectB).toBe(false);
  });

  it('performance NFR keeps representative caller-startup evaluation P95 below 100ms', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue(
      Array.from({ length: 75 }, (_, index) => ({
        ...baseFlag,
        id: `flag-${index}`,
        key: index === 0 ? 'repo-grounding-workspace-profile' : `rollout-${index}`,
        rules: [
          { type: 'caller', value: index % 2 === 0 ? 'interview' : 'design-doc' },
          { type: 'caller', value: 'agent-home' },
          { type: 'environment', value: 'dev' },
          { type: 'project', value: 'proj-a' },
          { type: 'user', value: `other-${index}` },
        ],
      })),
    );
    const durations: number[] = [];

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const startedAt = performance.now();
      await isGroundingEnabledForCaller({
        userId: 'user-1',
        project: 'proj-a',
        caller: 'interview',
      });
      durations.push(performance.now() - startedAt);
    }

    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    expect(p95).toBeLessThanOrEqual(100);
  });

  it('DoD-4 resolves remote-search convergence independently from base grounding', async () => {
    mockDb.query.featureFlags.findMany.mockResolvedValue([
      {
        ...baseFlag,
        key: 'repo-grounding-workspace-profile',
        enabled: false,
        rules: [{ type: 'everyone', value: null }],
      },
      {
        ...baseFlag,
        key: 'repo-grounding-remote-search-convergence',
        enabled: true,
        rules: [
          { type: 'caller', value: 'interview' },
          { type: 'environment', value: 'dev' },
          { type: 'project', value: 'proj-a' },
        ],
      },
    ]);

    const converged = await isRemoteSearchConvergenceEnabled({
      userId: 'user-1',
      project: 'proj-a',
      caller: 'interview',
    });

    expect(converged).toBe(true);
  });

  it.each([
    ['disabled', false, false, [{ type: 'everyone', value: null }]],
    ['absent', false, true, []],
    [
      'enabled with matching targeting',
      true,
      true,
      [
        { type: 'caller', value: 'interview' },
        { type: 'environment', value: 'dev' },
        { type: 'project', value: 'proj-a' },
      ],
    ],
    [
      'enabled with nonmatching targeting',
      false,
      true,
      [
        { type: 'caller', value: 'design-doc' },
        { type: 'environment', value: 'dev' },
        { type: 'project', value: 'proj-a' },
      ],
    ],
  ])(
    'TBI-005 / VT-06 returns %s native-read evaluation as %s',
    async (state, expected, enabled, rules) => {
      mockDb.query.featureFlags.findMany.mockResolvedValue(
        state === 'absent'
          ? []
          : [{ ...baseFlag, key: 'native-read', enabled, rules }],
      );
      const onEvaluationError = jest.fn();

      const result = await isNativeReadEnabledForCaller(
        { userId: 'user-1', project: 'proj-a', caller: 'interview' },
        onEvaluationError,
      );

      expect(result).toBe(expected);
      expect(onEvaluationError).not.toHaveBeenCalled();
    },
  );

  it('TBI-005 / VT-06 fails native-read evaluation closed and invokes callback only on throw', async () => {
    mockDb.query.featureFlags.findMany.mockRejectedValue(new Error('database unavailable'));
    const onEvaluationError = jest.fn();

    const enabled = await isNativeReadEnabledForCaller(
      { userId: 'user-1', project: 'proj-a', caller: 'interview' },
      onEvaluationError,
    );

    expect(enabled).toBe(false);
    expect(onEvaluationError).toHaveBeenCalledTimes(1);
    expect(onEvaluationError).toHaveBeenCalledWith();
  });

  it.each([
    ['disabled', { enabled: false, lifecycle: 'active' }],
    ['archived', { enabled: true, lifecycle: 'archived' }],
  ])(
    'TBI-008 reports the grounding kill switch non-operational when %s',
    async (_label, state) => {
      mockDb.query.featureFlags.findFirst.mockResolvedValue({
        ...baseFlag,
        key: 'repo-grounding-workspace-profile',
        ...state,
      });

      await expect(
        isFeatureOperational('repo-grounding-workspace-profile'),
      ).resolves.toBe(false);
    },
  );
});
