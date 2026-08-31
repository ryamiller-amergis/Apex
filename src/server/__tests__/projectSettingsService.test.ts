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
jest.mock('../services/groundingMaintenanceEvents', () => ({
  emitGroundingActiveSetChanged: jest.fn(),
}));
jest.mock('../services/featureFlagService', () => ({
  isProjectRepositoryCheckoutReadinessEnabled: jest
    .fn()
    .mockResolvedValue(false),
}));

import {
  getSkillConfig,
  getSkillConfigById,
  listSkillConfigsForProject,
  resolveSkillConfig,
  upsertSkillConfig,
  deleteSkillConfig,
  setApprovers,
  replaceApproverPools,
  getApproverPool,
  getApproverUserIds,
  getApprovalMode,
  getApprovalModes,
  setApprovalMode,
  setApprovalModes,
  getApprovalModeForProject,
} from '../services/projectSettingsService';
import {
  projectSkillSettings,
  projectApprovers,
  projectApproverGroups,
  projectApprovalModes,
} from '../db/schema';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { seedDefaultGroupsForProject: mockSeedDefaultGroupsForProject } =
  jest.requireMock('../services/groupService') as {
    seedDefaultGroupsForProject: jest.Mock;
  };
const { emitGroundingActiveSetChanged: mockEmitGroundingActiveSetChanged } =
  jest.requireMock('../services/groundingMaintenanceEvents') as {
    emitGroundingActiveSetChanged: jest.Mock;
  };
const {
  isProjectRepositoryCheckoutReadinessEnabled: mockIsCheckoutReadinessEnabled,
} = jest.requireMock('../services/featureFlagService') as {
  isProjectRepositoryCheckoutReadinessEnabled: jest.Mock;
};

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
function selectResolving(
  rows: unknown[],
  terminal: 'where' | 'orderBy' | 'limit'
) {
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
    mockDb.select.mockReturnValue(
      selectResolving([defaultRow, secondRow], 'orderBy')
    );
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
    const result = await resolveSkillConfig({
      project: 'proj-alpha',
      settingsId: 'cfg-second',
    });
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCheckoutReadinessEnabled.mockResolvedValue(false);
  });

  it.each([
    {
      label: 'GitHub org/repo',
      skillProvider: 'github' as const,
      skillRepo: 'amergis/AI-Pilot',
      expected: {
        provider: 'github',
        project: 'proj-alpha',
        repository: 'AI-Pilot',
        branch: 'main',
      },
    },
    {
      label: 'ADO slash-containing repo',
      skillProvider: 'ado' as const,
      skillRepo: 'Platform/AI-Pilot',
      expected: {
        provider: 'azure_devops',
        project: 'proj-alpha',
        repository: 'Platform/AI-Pilot',
        branch: 'main',
      },
    },
  ])(
    'PLAN-S1-AC-0 successful settings upsert emits normalized $label target after group seeding',
    async ({ skillProvider, skillRepo, expected }) => {
      // Arrange
      mockDb.transaction.mockResolvedValue({
        ...defaultRow,
        skillProvider,
        skillRepo,
      });

      // Act
      await upsertSkillConfig(makeUpsertInput({ skillProvider, skillRepo }));

      // Assert
      expect(mockSeedDefaultGroupsForProject).toHaveBeenCalledWith(
        'proj-alpha',
        'alice'
      );
      expect(mockEmitGroundingActiveSetChanged).toHaveBeenCalledTimes(1);
      expect(mockEmitGroundingActiveSetChanged).toHaveBeenCalledWith(expected);
      expect(
        mockSeedDefaultGroupsForProject.mock.invocationCallOrder[0]
      ).toBeLessThan(
        mockEmitGroundingActiveSetChanged.mock.invocationCallOrder[0]
      );
    }
  );

  it('S13: checkout readiness ON skips prewarm active-set emit on upsert', async () => {
    mockIsCheckoutReadinessEnabled.mockResolvedValue(true);
    mockDb.transaction.mockResolvedValue({
      ...defaultRow,
      skillProvider: 'github',
      skillRepo: 'amergis/AI-Pilot',
    });

    await upsertSkillConfig(
      makeUpsertInput({ skillProvider: 'github', skillRepo: 'amergis/AI-Pilot' }),
    );

    expect(mockIsCheckoutReadinessEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'alice',
        project: 'proj-alpha',
        caller: 'project-settings',
      }),
    );
    expect(mockSeedDefaultGroupsForProject).toHaveBeenCalled();
    expect(mockEmitGroundingActiveSetChanged).not.toHaveBeenCalled();
  });

  it('PLAN-S1-AC-1 failed settings save emits no active-set event', async () => {
    // Arrange
    mockDb.transaction.mockRejectedValue(new Error('settings save failed'));

    // Act / Assert
    await expect(upsertSkillConfig(makeUpsertInput())).rejects.toThrow(
      'settings save failed'
    );
    expect(mockSeedDefaultGroupsForProject).not.toHaveBeenCalled();
    expect(mockEmitGroundingActiveSetChanged).not.toHaveBeenCalled();
  });

  it('forces the first config of a project to be the default', async () => {
    const insertedRow = { ...defaultRow, isDefault: true };
    const valuesMock = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const insertMock = jest.fn().mockImplementation((table) =>
      table === projectSkillSettings
        ? { values: valuesMock }
        : {
            values: jest.fn().mockReturnValue({
              onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
            }),
          }
    );
    const updateMock = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    });

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

    const result = await upsertSkillConfig(
      makeUpsertInput({ isDefault: false })
    );

    expect(result).toMatchObject({ id: 'cfg-default', isDefault: true });
    // even though isDefault:false was requested, the first config is forced default
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true, project: 'proj-alpha' })
    );
    // nothing to clear when it's the first config
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('clears other defaults when creating a new default config', async () => {
    const insertedRow = { ...secondRow, isDefault: true };
    const valuesMock = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const insertMock = jest.fn().mockImplementation((table) =>
      table === projectSkillSettings
        ? { values: valuesMock }
        : {
            values: jest.fn().mockReturnValue({
              onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
            }),
          }
    );
    const clearSet = jest.fn().mockReturnThis();
    const clearWhere = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest
      .fn()
      .mockReturnValue({ set: clearSet, where: clearWhere });

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

    await upsertSkillConfig(
      makeUpsertInput({ friendlyName: 'Secondary repo', isDefault: true })
    );

    // siblings' defaults are cleared, and the new row is written as default
    expect(updateMock).toHaveBeenCalled();
    expect(clearSet).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: false })
    );
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true })
    );
  });

  it('does not clear defaults when adding a non-default config alongside an existing default', async () => {
    const insertedRow = { ...secondRow, isDefault: false };
    const valuesMock = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const insertMock = jest.fn().mockImplementation((table) =>
      table === projectSkillSettings
        ? { values: valuesMock }
        : {
            values: jest.fn().mockReturnValue({
              onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
            }),
          }
    );
    const updateMock = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    });

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

    await upsertSkillConfig(
      makeUpsertInput({ friendlyName: 'Secondary repo', isDefault: false })
    );

    expect(updateMock).not.toHaveBeenCalled();
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: false })
    );
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

    const result = await upsertSkillConfig(
      makeUpsertInput({
        id: 'cfg-second',
        friendlyName: 'Secondary repo',
        skillBranch: 'release',
      })
    );

    expect(result).toMatchObject({ id: 'cfg-second', skillBranch: 'release' });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('PBI-002 AC-1 writes config and supplied module modes in the same transaction and rejects the whole unit when a mode write fails', async () => {
    const settingsUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([
          { ...defaultRow, approvalMode: 'all_required' },
        ]),
      }),
    });
    const modeFailure = new Error('mode write failed');
    const modeInsert = jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockRejectedValue(modeFailure),
      }),
    });

    mockDb.transaction.mockImplementation(async (fn: any) =>
      fn({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([defaultRow]),
        }),
        update: settingsUpdate,
        insert: modeInsert,
      })
    );

    await expect(
      upsertSkillConfig(
        makeUpsertInput({
          id: 'cfg-default',
          approvalMode: 'all_required',
          approvalModes: { prd: 'all_required', adr: 'all_required' },
        })
      )
    ).rejects.toThrow('mode write failed');

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(settingsUpdate).toHaveBeenCalled();
    expect(modeInsert).toHaveBeenCalledWith(projectApprovalModes);
    expect(mockSeedDefaultGroupsForProject).not.toHaveBeenCalled();
  });

  it('PBI-002 seeds all five module rows for a new config using the legacy mode except ADR', async () => {
    const insertedRow = { ...defaultRow, approvalMode: 'all_required' };
    const settingsValues = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertedRow]),
    });
    const modeValues = jest.fn().mockReturnValue({
      onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
    });
    const insertMock = jest
      .fn()
      .mockReturnValueOnce({ values: settingsValues })
      .mockReturnValue({ values: modeValues });

    mockDb.transaction.mockImplementation(async (fn: any) =>
      fn({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          limit: jest.fn().mockResolvedValue([]),
        }),
        update: jest.fn(),
        insert: insertMock,
      })
    );

    await upsertSkillConfig(
      makeUpsertInput({ approvalMode: 'all_required' })
    );

    expect(modeValues.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ documentType: 'prd', mode: 'all_required' }),
      expect.objectContaining({ documentType: 'design_doc', mode: 'all_required' }),
      expect.objectContaining({ documentType: 'design_prototype', mode: 'all_required' }),
      expect.objectContaining({ documentType: 'test_case', mode: 'all_required' }),
      expect.objectContaining({ documentType: 'adr', mode: 'any_one' }),
    ]);
  });
});

// ── deleteSkillConfig — delete-last guard + default promotion ─────────────────────

describe('deleteSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('blocks deleting the last remaining config for a project', async () => {
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest
          .fn()
          // target lookup (SELECT ... LIMIT 1)
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest
              .fn()
              .mockResolvedValue([
                { id: 'cfg-default', project: 'proj-alpha', isDefault: true },
              ]),
          })
          // siblings lookup → only the one row
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockResolvedValue([{ id: 'cfg-default' }]),
          }),
        delete: jest
          .fn()
          .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(tx);
    });

    await expect(deleteSkillConfig('cfg-default')).rejects.toThrow(
      /only repo config/i
    );
  });

  it('promotes another config to default when the deleted config was the default', async () => {
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const deleteMock = jest.fn().mockReturnValue({ where: deleteWhere });
    const promoteSet = jest.fn().mockReturnThis();
    const promoteWhere = jest.fn().mockResolvedValue(undefined);
    const updateMock = jest
      .fn()
      .mockReturnValue({ set: promoteSet, where: promoteWhere });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest
          .fn()
          // target lookup
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest
              .fn()
              .mockResolvedValue([
                { id: 'cfg-default', project: 'proj-alpha', isDefault: true },
              ]),
          })
          // siblings lookup → two rows so the guard passes
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest
              .fn()
              .mockResolvedValue([{ id: 'cfg-default' }, { id: 'cfg-second' }]),
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
    expect(promoteSet).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true })
    );
  });

  it('does not promote when a non-default config is deleted', async () => {
    const updateMock = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    });

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx = {
        select: jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest
              .fn()
              .mockResolvedValue([
                { id: 'cfg-second', project: 'proj-alpha', isDefault: false },
              ]),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnThis(),
            where: jest
              .fn()
              .mockResolvedValue([{ id: 'cfg-default' }, { id: 'cfg-second' }]),
          }),
        delete: jest
          .fn()
          .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        update: updateMock,
      };
      return fn(tx);
    });

    await deleteSkillConfig('cfg-second');

    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ── ADR reviewer pool (TBI-001 DoD-0, PBI-001 AC-2 / VT-03) ──────────────────

/**
 * Drops queued `mockReturnValueOnce` chains as well as call history so each
 * approval-pool / approval-mode test drives db.select from a clean slate.
 */
function resetDbMocks() {
  jest.clearAllMocks();
  mockDb.select.mockReset();
  mockDb.insert.mockReset();
  mockDb.update.mockReset();
  mockDb.delete.mockReset();
  mockDb.transaction.mockReset();
}

/** Mocks db.transaction with a tx exposing delete/insert, returning the spies. */
function mockPoolTransaction() {
  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const deleteMock = jest.fn().mockReturnValue({ where: deleteWhere });
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const insertMock = jest.fn().mockReturnValue({ values: insertValues });

  mockDb.transaction.mockImplementation(async (fn: any) =>
    fn({ delete: deleteMock, insert: insertMock })
  );

  return { deleteMock, deleteWhere, insertMock, insertValues };
}

function adrGroupRefRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref-adr-1',
    settingsId: 'cfg-default',
    groupId: 'grp-adr',
    documentType: 'adr',
    assignedBy: 'alice',
    assignedAt: '2026-01-01T00:00:00Z',
    groupName: 'ADR Reviewers',
    groupDescription: null,
    groupProject: 'proj-alpha',
    groupIsDefault: false,
    groupCreatedBy: 'alice',
    groupCreatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('adr reviewer pool', () => {
  beforeEach(resetDbMocks);

  it('TBI-001 DoD-0 setApprovers accepts the adr module and writes adr pool rows', async () => {
    const { deleteMock, insertMock, insertValues } = mockPoolTransaction();
    mockDb.select.mockReturnValue(
      selectResolving(
        [
          {
            id: 'appr-adr-1',
            settingsId: 'cfg-default',
            userId: 'dev-1',
            displayName: 'Dev One',
            email: 'dev1@example.com',
            documentType: 'adr',
            assignedBy: 'alice',
            assignedAt: '2026-01-01T00:00:00Z',
          },
        ],
        'where'
      )
    );

    const result = await setApprovers('cfg-default', 'adr', ['dev-1'], 'alice');

    expect(deleteMock).toHaveBeenCalledWith(projectApprovers);
    expect(insertMock).toHaveBeenCalledWith(projectApprovers);
    expect(insertValues).toHaveBeenCalledWith([
      {
        settingsId: 'cfg-default',
        userId: 'dev-1',
        documentType: 'adr',
        assignedBy: 'alice',
      },
    ]);
    expect(result).toEqual([
      expect.objectContaining({ userId: 'dev-1', documentType: 'adr' }),
    ]);
  });

  it('TBI-001 DoD-0 getApproverUserIds unions adr individuals and adr group members', async () => {
    mockDb.select
      // individuals for the adr pool
      .mockReturnValueOnce(
        selectResolving([{ userId: 'dev-1', documentType: 'adr' }], 'where')
      )
      // adr group references
      .mockReturnValueOnce(selectResolving([adrGroupRefRow()], 'where'))
      // members of the referenced group
      .mockReturnValueOnce(
        selectResolving(
          [
            { groupId: 'grp-adr', userId: 'dev-2' },
            { groupId: 'grp-adr', userId: 'dev-1' },
          ],
          'where'
        )
      );

    const userIds = await getApproverUserIds('cfg-default', 'adr');

    expect(userIds.sort()).toEqual(['dev-1', 'dev-2']);
  });

  it('PBI-001 AC-2 / VT-03 returns a configured zero-member adr group with members: [] without throwing', async () => {
    mockDb.select
      // no individual adr approvers
      .mockReturnValueOnce(selectResolving([], 'where'))
      // one configured adr group reference
      .mockReturnValueOnce(selectResolving([adrGroupRefRow()], 'where'))
      // the group has no members
      .mockReturnValueOnce(selectResolving([], 'where'));

    const pool = await getApproverPool('cfg-default', 'adr');

    expect(pool.individuals).toEqual([]);
    expect(pool.groups).toHaveLength(1);
    expect(pool.groups[0]).toMatchObject({
      id: 'grp-adr',
      name: 'ADR Reviewers',
      documentType: 'adr',
      members: [],
    });
  });
});

describe('replaceApproverPools', () => {
  beforeEach(resetDbMocks);

  it('PBI-001 AC-1 replaces individuals and groups across supplied modules in one transaction', async () => {
    const { deleteMock, insertMock, insertValues } = mockPoolTransaction();
    mockDb.select.mockReturnValue(selectResolving([], 'where'));

    await replaceApproverPools(
      'cfg-default',
      {
        design_doc: {
          individuals: ['designer-1'],
          groups: ['design-group'],
        },
        adr: {
          individuals: ['architect-1'],
          groups: ['architecture-group'],
        },
      },
      'alice'
    );

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(projectApprovers);
    expect(deleteMock).toHaveBeenCalledWith(projectApproverGroups);
    expect(insertMock).toHaveBeenCalledWith(projectApprovers);
    expect(insertMock).toHaveBeenCalledWith(projectApproverGroups);
    expect(insertValues).toHaveBeenCalledWith([
      {
        settingsId: 'cfg-default',
        userId: 'designer-1',
        documentType: 'design_doc',
        assignedBy: 'alice',
      },
    ]);
    expect(insertValues).toHaveBeenCalledWith([
      {
        settingsId: 'cfg-default',
        groupId: 'architecture-group',
        documentType: 'adr',
        assignedBy: 'alice',
      },
    ]);
  });

  it('PBI-001 AC-1 leaves the prior ADR pool unchanged when a later batch write fails', async () => {
    const state = {
      adrIndividuals: ['existing-architect'],
      adrGroups: ['existing-architecture-group'],
    };

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const snapshot = structuredClone(state);
      const tx = {
        delete: jest.fn().mockImplementation((table) => ({
          where: jest.fn().mockImplementation(async () => {
            if (table === projectApprovers) state.adrIndividuals = [];
            if (table === projectApproverGroups) state.adrGroups = [];
          }),
        })),
        insert: jest.fn().mockImplementation((table) => ({
          values: jest.fn().mockImplementation(async (rows) => {
            if (table === projectApprovers) {
              state.adrIndividuals = rows.map((row: any) => row.userId);
              return;
            }
            if (rows.some((row: any) => row.documentType === 'design_doc')) {
              throw new Error('group write failed');
            }
            state.adrGroups = rows.map((row: any) => row.groupId);
          }),
        })),
      };
      try {
        return await fn(tx);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    });

    await expect(
      replaceApproverPools('cfg-default', {
        adr: {
          individuals: ['new-architect'],
          groups: ['new-architecture-group'],
        },
        design_doc: {
          individuals: ['designer'],
          groups: ['broken-group'],
        },
      })
    ).rejects.toThrow('group write failed');

    expect(state).toEqual({
      adrIndividuals: ['existing-architect'],
      adrGroups: ['existing-architecture-group'],
    });
  });
});

// ── Per-module approval modes (TBI-001 DoD-1 / DoD-4, PBI-002, PBI-003) ──────

/** Mocks db.transaction with a tx exposing insert/update, returning the spies. */
function mockModeTransaction() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insertMock = jest.fn().mockReturnValue({ values: insertValues });
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const updateMock = jest.fn().mockReturnValue({ set: updateSet });

  mockDb.transaction.mockImplementation(async (fn: any) =>
    fn({ insert: insertMock, update: updateMock })
  );

  return { insertMock, insertValues, onConflictDoUpdate, updateMock, updateSet };
}

describe('getApprovalMode', () => {
  beforeEach(resetDbMocks);

  it('TBI-001 DoD-1 / DoD-4 returns the stored per-module mode for the settings row', async () => {
    mockDb.select.mockReturnValue(
      selectResolving([{ mode: 'all_required' }], 'limit')
    );

    await expect(getApprovalMode('cfg-default', 'design_doc')).resolves.toBe(
      'all_required'
    );
  });

  it('TBI-001 DoD-1 falls back to the legacy project-wide mode when a four-module row is missing', async () => {
    mockDb.select
      // no per-module row yet
      .mockReturnValueOnce(selectResolving([], 'limit'))
      // legacy column on the settings row
      .mockReturnValueOnce(
        selectResolving([{ approvalMode: 'all_required' }], 'limit')
      );

    await expect(getApprovalMode('cfg-default', 'test_case')).resolves.toBe(
      'all_required'
    );
  });

  it('TBI-001 DoD-1 defaults a missing adr row to any_one without consulting the legacy column', async () => {
    mockDb.select.mockReturnValue(selectResolving([], 'limit'));

    await expect(getApprovalMode('cfg-default', 'adr')).resolves.toBe('any_one');
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('TBI-001 DoD-1 rejects a document type outside the reviewer module set', async () => {
    await expect(
      getApprovalMode('cfg-default', 'standup' as never)
    ).rejects.toThrow(/document type/i);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('getApprovalModes', () => {
  beforeEach(resetDbMocks);

  it('TBI-001 DoD-1 returns a complete module map, filling missing rows from legacy and any_one for adr', async () => {
    mockDb.select
      // only the prd row has been written
      .mockReturnValueOnce(
        selectResolving([{ documentType: 'prd', mode: 'any_one' }], 'where')
      )
      // legacy project-wide mode used for the remaining four-module rows
      .mockReturnValueOnce(
        selectResolving([{ approvalMode: 'all_required' }], 'limit')
      );

    const modes = await getApprovalModes('cfg-default');

    expect(modes).toEqual({
      prd: 'any_one',
      design_doc: 'all_required',
      design_prototype: 'all_required',
      test_case: 'all_required',
      adr: 'any_one',
    });
    // reads must not backfill storage
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe('setApprovalMode', () => {
  beforeEach(resetDbMocks);

  it('TBI-001 DoD-1 / DoD-4 upserts the mode row keyed by settings id and module', async () => {
    const { insertMock, insertValues, onConflictDoUpdate } =
      mockModeTransaction();

    await setApprovalMode('cfg-default', 'design_doc', 'all_required');

    expect(insertMock).toHaveBeenCalledWith(projectApprovalModes);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        settingsId: 'cfg-default',
        documentType: 'design_doc',
        mode: 'all_required',
      })
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [
          projectApprovalModes.settingsId,
          projectApprovalModes.documentType,
        ],
        set: expect.objectContaining({ mode: 'all_required' }),
      })
    );
  });

  it('PBI-002 AC-0 / VT-05 writing design_doc any_one leaves the prd mode and the legacy column untouched', async () => {
    const { updateMock } = mockModeTransaction();

    await setApprovalMode('cfg-default', 'design_doc', 'any_one');

    // legacy mirror is PRD-only, so a design_doc write must not update it
    expect(updateMock).not.toHaveBeenCalled();

    // the independently stored prd mode still reads back as all_required
    jest.clearAllMocks();
    mockDb.select.mockReturnValue(
      selectResolving([{ mode: 'all_required' }], 'limit')
    );
    await expect(getApprovalMode('cfg-default', 'prd')).resolves.toBe(
      'all_required'
    );
  });

  it('TBI-001 DoD-1 mirrors a prd write onto the legacy column inside the same transaction', async () => {
    const { insertMock, updateMock, updateSet } = mockModeTransaction();

    await setApprovalMode('cfg-default', 'prd', 'all_required');

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith(projectApprovalModes);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'all_required' })
    );
  });

  it('TBI-001 DoD-1 rejects an unknown module or mode before writing', async () => {
    mockModeTransaction();

    await expect(
      setApprovalMode('cfg-default', 'standup' as never, 'any_one')
    ).rejects.toThrow(/document type/i);
    await expect(
      setApprovalMode('cfg-default', 'prd', 'majority' as never)
    ).rejects.toThrow(/approval mode/i);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe('setApprovalModes', () => {
  beforeEach(resetDbMocks);

  it('PBI-002 AC-0 / VT-06 writes a partial map atomically and mirrors only PRD', async () => {
    const { insertValues, updateMock, updateSet } = mockModeTransaction();

    await setApprovalModes('cfg-default', {
      prd: 'all_required',
      design_doc: 'any_one',
    });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        settingsId: 'cfg-default',
        documentType: 'prd',
        mode: 'all_required',
      })
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        settingsId: 'cfg-default',
        documentType: 'design_doc',
        mode: 'any_one',
      })
    );
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'all_required' })
    );
  });

  it('PBI-002 AC-1 / VT-08 rejects every invalid entry before opening a transaction', async () => {
    await expect(
      setApprovalModes('cfg-default', {
        adr: 'all_required',
        standup: 'any_one',
      } as never)
    ).rejects.toThrow(/document type/i);
    await expect(
      setApprovalModes('cfg-default', { adr: 'majority' } as never)
    ).rejects.toThrow(/approval mode/i);

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe('getApprovalModeForProject', () => {
  beforeEach(resetDbMocks);

  it('TBI-001 DoD-1 resolves the default settings row then reads that module mode', async () => {
    mockDb.select
      // getSkillConfig → project default
      .mockReturnValueOnce(selectResolving([defaultRow], 'limit'))
      // per-module row for design_prototype
      .mockReturnValueOnce(selectResolving([{ mode: 'all_required' }], 'limit'));

    await expect(
      getApprovalModeForProject('proj-alpha', 'design_prototype')
    ).resolves.toBe('all_required');
  });

  it('TBI-001 DoD-1 defaults to any_one when the project has no default settings row', async () => {
    mockDb.select.mockReturnValue(selectResolving([], 'limit'));

    await expect(getApprovalModeForProject('proj-empty', 'prd')).resolves.toBe(
      'any_one'
    );
  });

  it('PBI-002 AC-0 / VT-05 reads prd and design_doc modes independently for the same project', async () => {
    mockDb.select
      .mockReturnValueOnce(selectResolving([defaultRow], 'limit'))
      .mockReturnValueOnce(selectResolving([{ mode: 'all_required' }], 'limit'));
    await expect(getApprovalModeForProject('proj-alpha', 'prd')).resolves.toBe(
      'all_required'
    );

    jest.clearAllMocks();
    mockDb.select
      .mockReturnValueOnce(selectResolving([defaultRow], 'limit'))
      .mockReturnValueOnce(selectResolving([{ mode: 'any_one' }], 'limit'));
    await expect(
      getApprovalModeForProject('proj-alpha', 'design_doc')
    ).resolves.toBe('any_one');
  });
});

describe('approval mode survives pool changes', () => {
  beforeEach(resetDbMocks);

  it('PBI-003 AC-3 / VT-12 clearing a module pool never deletes the stored mode and the read still returns it', async () => {
    const { deleteMock, insertMock } = mockPoolTransaction();
    mockDb.select.mockReturnValue(selectResolving([], 'where'));

    const emptied = await setApprovers('cfg-default', 'adr', [], 'alice');

    expect(emptied).toEqual([]);
    expect(insertMock).not.toHaveBeenCalled();
    // only the pool table is cleared — the mode row is a separate table
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(projectApprovers);
    expect(deleteMock).not.toHaveBeenCalledWith(projectApprovalModes);

    jest.clearAllMocks();
    mockDb.select.mockReturnValue(
      selectResolving([{ mode: 'all_required' }], 'limit')
    );

    await expect(getApprovalMode('cfg-default', 'adr')).resolves.toBe(
      'all_required'
    );
  });
});
