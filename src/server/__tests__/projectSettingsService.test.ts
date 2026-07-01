/**
 * Unit tests for projectSettingsService (multi-repo project settings).
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 * Mock shape follows src/server/__tests__/rbacService.test.ts.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      transaction: jest.fn(),
    },
  };
});

// groupService.seedDefaultGroupsForProject is a side-effect of upsert; stub it out.
jest.mock('../services/groupService', () => ({
  seedDefaultGroupsForProject: jest.fn().mockResolvedValue(undefined),
}));

import {
  getSkillConfig,
  getSkillConfigById,
  listSkillConfigsForProject,
  resolveSkillConfig,
  upsertSkillConfig,
  deleteSkillConfig,
} from '../services/projectSettingsService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

const defaultRow = {
  id: 'cfg-default',
  project: 'proj-alpha',
  friendlyName: 'Primary repo',
  isDefault: true,
  skillRepo: 'org/skills-repo',
  skillBranch: 'main',
  updatedBy: 'alice',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const secondRow = {
  ...defaultRow,
  id: 'cfg-second',
  friendlyName: 'Secondary repo',
  isDefault: false,
  skillRepo: 'org/other-repo',
};

function makeUpsertInput(overrides: Record<string, unknown> = {}) {
  return {
    project: 'proj-alpha',
    friendlyName: 'Primary repo',
    skillRepo: 'org/skills-repo',
    skillBranch: 'main',
    updatedBy: 'alice',
    ...overrides,
  } as Parameters<typeof upsertSkillConfig>[0];
}

/** A read-only select chain whose terminal resolves `rows`. */
function selectResolving(rows: unknown[], terminal: 'where' | 'orderBy' | 'limit') {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
  chain[terminal] = jest.fn().mockResolvedValue(rows);
  return chain;
}

// ── getSkillConfigById ──────────────────────────────────────────────────────────

describe('getSkillConfigById', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the config row for the id', async () => {
    mockDb.select.mockReturnValue(selectResolving([defaultRow], 'limit'));
    const result = await getSkillConfigById('cfg-default');
    expect(result).toMatchObject({ id: 'cfg-default', project: 'proj-alpha' });
  });

  it('returns null when no row exists for the id', async () => {
    mockDb.select.mockReturnValue(selectResolving([], 'limit'));
    const result = await getSkillConfigById('cfg-missing');
    expect(result).toBeNull();
  });
});

// ── getSkillConfig (back-compat: returns the project default) ─────────────────────

describe('getSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the default config for the project', async () => {
    mockDb.select.mockReturnValue(selectResolving([defaultRow], 'limit'));
    const result = await getSkillConfig('proj-alpha');
    expect(result).toMatchObject({ id: 'cfg-default', isDefault: true });
  });

  it('returns null when the project has no default config', async () => {
    mockDb.select.mockReturnValue(selectResolving([], 'limit'));
    const result = await getSkillConfig('proj-empty');
    expect(result).toBeNull();
  });
});

// ── listSkillConfigsForProject ────────────────────────────────────────────────────

describe('listSkillConfigsForProject', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns every config for the project (default first)', async () => {
    mockDb.select.mockReturnValue(selectResolving([defaultRow, secondRow], 'orderBy'));
    const result = await listSkillConfigsForProject('proj-alpha');
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['cfg-default', 'cfg-second']);
  });
});

// ── resolveSkillConfig ────────────────────────────────────────────────────────────

describe('resolveSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves the specific config when a settingsId is provided', async () => {
    mockDb.select.mockReturnValue(selectResolving([secondRow], 'limit'));
    const result = await resolveSkillConfig({ project: 'proj-alpha', settingsId: 'cfg-second' });
    expect(result).toMatchObject({ id: 'cfg-second' });
  });

  it('falls back to the project default when no settingsId is provided', async () => {
    mockDb.select.mockReturnValue(selectResolving([defaultRow], 'limit'));
    const result = await resolveSkillConfig({ project: 'proj-alpha' });
    expect(result).toMatchObject({ id: 'cfg-default', isDefault: true });
  });
});

// ── upsertSkillConfig — one-default enforcement ───────────────────────────────────

describe('upsertSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('forces the first config of a project to be the default', async () => {
    const insertedRow = { ...defaultRow, isDefault: true };
    const valuesMock = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([insertedRow]) });
    const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
    const updateMock = jest.fn().mockReturnValue({ set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        // existing-config lookup → none for this project
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        insert: insertMock,
        update: updateMock,
      };
      return fn(tx);
    });

    const result = await upsertSkillConfig(makeUpsertInput({ isDefault: false }));

    expect(result).toMatchObject({ id: 'cfg-default', isDefault: true });
    // even though isDefault:false was requested, the first config is forced default
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true, project: 'proj-alpha' }));
    // nothing to clear when it's the first config
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('clears other defaults when creating a new default config', async () => {
    const insertedRow = { ...secondRow, isDefault: true };
    const valuesMock = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([insertedRow]) });
    const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
    const clearSet = jest.fn().mockReturnThis();
    const clearWhere = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest.fn().mockReturnValue({ set: clearSet, where: clearWhere });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([{ id: 'cfg-default' }]),
        }),
        insert: insertMock,
        update: updateMock,
      };
      return fn(tx);
    });

    await upsertSkillConfig(makeUpsertInput({ friendlyName: 'Secondary repo', isDefault: true }));

    // siblings' defaults are cleared, and the new row is written as default
    expect(updateMock).toHaveBeenCalled();
    expect(clearSet).toHaveBeenCalledWith(expect.objectContaining({ isDefault: false }));
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true }));
  });

  it('does not clear defaults when adding a non-default config alongside an existing default', async () => {
    const insertedRow = { ...secondRow, isDefault: false };
    const valuesMock = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([insertedRow]) });
    const insertMock = jest.fn().mockReturnValue({ values: valuesMock });
    const updateMock = jest.fn().mockReturnValue({ set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([{ id: 'cfg-default' }]),
        }),
        insert: insertMock,
        update: updateMock,
      };
      return fn(tx);
    });

    await upsertSkillConfig(makeUpsertInput({ friendlyName: 'Secondary repo', isDefault: false }));

    expect(updateMock).not.toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ isDefault: false }));
  });

  it('updates an existing config by id without inserting', async () => {
    const updatedRow = { ...secondRow, skillBranch: 'release' };
    const updateReturning = jest.fn().mockResolvedValue([updatedRow]);
    const updateMock = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnValue({ returning: updateReturning }),
    });
    const insertMock = jest.fn();

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        insert: insertMock,
        update: updateMock,
      };
      return fn(tx);
    });

    const result = await upsertSkillConfig(makeUpsertInput({ id: 'cfg-second', friendlyName: 'Secondary repo', skillBranch: 'release' }));

    expect(result).toMatchObject({ id: 'cfg-second', skillBranch: 'release' });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ── deleteSkillConfig — delete-last guard + default promotion ─────────────────────

describe('deleteSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('blocks deleting the last remaining config for a project', async () => {
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest.fn()
          // target lookup (SELECT ... LIMIT 1)
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ id: 'cfg-default', project: 'proj-alpha', isDefault: true }]),
          })
          // siblings lookup → only the one row
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockResolvedValue([{ id: 'cfg-default' }]),
          }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) }),
      };
      return fn(tx);
    });

    await expect(deleteSkillConfig('cfg-default')).rejects.toThrow(/only repo config/i);
  });

  it('promotes another config to default when the deleted config was the default', async () => {
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const deleteMock = jest.fn().mockReturnValue({ where: deleteWhere });
    const promoteSet = jest.fn().mockReturnThis();
    const promoteWhere = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest.fn().mockReturnValue({ set: promoteSet, where: promoteWhere });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest.fn()
          // target lookup
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ id: 'cfg-default', project: 'proj-alpha', isDefault: true }]),
          })
          // siblings lookup → two rows so the guard passes
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockResolvedValue([{ id: 'cfg-default' }, { id: 'cfg-second' }]),
          })
          // promotion lookup (oldest surviving config)
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ id: 'cfg-second' }]),
          }),
        delete: deleteMock,
        update: updateMock,
      };
      return fn(tx);
    });

    await deleteSkillConfig('cfg-default');

    expect(deleteMock).toHaveBeenCalledTimes(1);
    // a surviving sibling is promoted to default
    expect(promoteSet).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true }));
  });

  it('does not promote when a non-default config is deleted', async () => {
    const updateMock = jest.fn().mockReturnValue({ set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest.fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([{ id: 'cfg-second', project: 'proj-alpha', isDefault: false }]),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockResolvedValue([{ id: 'cfg-default' }, { id: 'cfg-second' }]),
          }),
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        update: updateMock,
      };
      return fn(tx);
    });

    await deleteSkillConfig('cfg-second');

    expect(updateMock).not.toHaveBeenCalled();
  });
});
