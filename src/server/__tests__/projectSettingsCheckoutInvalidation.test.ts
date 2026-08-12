/**
 * VT-01 / VT-05 / VT-06 — projectSettingsService checkout invalidation
 */
const mockReturning = jest.fn<Promise<unknown[]>, []>();
const mockLimit = jest.fn<Promise<unknown[]>, []>(() => Promise.resolve([]));
const mockWhere = jest.fn(() => ({ limit: mockLimit, returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockWhere }));
const mockValues = jest.fn(() => ({ returning: mockReturning }));
const mockInsert = jest.fn(() => ({ values: mockValues }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));
const mockSelect = jest.fn(() => ({ from: () => ({ where: mockWhere }) }));
const mockTransaction = jest.fn(
  async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: mockSelect,
      update: mockUpdate,
      insert: mockInsert,
    };
    return fn(tx);
  },
);

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) =>
      (mockSelect as (...a: unknown[]) => unknown)(...args),
    update: (...args: unknown[]) =>
      (mockUpdate as (...a: unknown[]) => unknown)(...args),
    insert: (...args: unknown[]) =>
      (mockInsert as (...a: unknown[]) => unknown)(...args),
    transaction: (...args: unknown[]) =>
      (mockTransaction as (...a: unknown[]) => unknown)(...args),
    query: {
      projectSkillSettings: {
        findFirst: jest.fn(),
      },
    },
  },
}));

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

import { upsertSkillConfig } from '../services/projectSettingsService';

describe('projectSettingsService repository checkout invalidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // VT-01 — new config starts not_cloned
  it('VT-01: insert includes repository_checkout_status not_cloned', async () => {
    mockLimit.mockResolvedValueOnce([]); // no existing configs
    mockReturning.mockResolvedValueOnce([
      {
        id: 'new-1',
        project: 'Apex',
        friendlyName: 'Default',
        skillProvider: 'ado',
        skillRepo: 'AI-Pilot',
        skillBranch: 'main',
        isDefault: true,
        repositoryCheckoutStatus: 'not_cloned',
        repositoryCheckoutSha: null,
      },
    ]);

    const result = await upsertSkillConfig({
      project: 'Apex',
      friendlyName: 'Default',
      skillRepo: 'AI-Pilot',
      skillBranch: 'main',
    });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryCheckoutStatus: 'not_cloned',
        repositoryCheckoutSha: null,
      }),
    );
    expect(result.repositoryCheckoutStatus).toBe('not_cloned');
  });

  // VT-05 — provider/repo/branch change resets readiness
  it('VT-05: changing skillRepo resets checkout to not_cloned', async () => {
    mockLimit.mockResolvedValueOnce([
      {
        id: 'cfg-1',
        skillProvider: 'ado',
        skillRepo: 'OldRepo',
        skillBranch: 'main',
        isDefault: true,
        project: 'Apex',
      },
    ]);
    mockReturning.mockResolvedValueOnce([
      {
        id: 'cfg-1',
        project: 'Apex',
        friendlyName: 'Default',
        skillProvider: 'ado',
        skillRepo: 'NewRepo',
        skillBranch: 'main',
        isDefault: true,
        repositoryCheckoutStatus: 'not_cloned',
        repositoryCheckoutSha: null,
      },
    ]);

    await upsertSkillConfig({
      id: 'cfg-1',
      project: 'Apex',
      friendlyName: 'Default',
      skillRepo: 'NewRepo',
      skillBranch: 'main',
      skillProvider: 'ado',
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        skillRepo: 'NewRepo',
        repositoryCheckoutStatus: 'not_cloned',
        repositoryCheckoutSha: null,
      }),
    );
  });

  // VT-06 — model-only edit does not reset
  it('VT-06: changing model only does not reset checkout status', async () => {
    mockLimit.mockResolvedValueOnce([
      {
        id: 'cfg-1',
        skillProvider: 'ado',
        skillRepo: 'AI-Pilot',
        skillBranch: 'main',
        isDefault: true,
        project: 'Apex',
        repositoryCheckoutStatus: 'ready',
        repositoryCheckoutSha: 'abc',
      },
    ]);
    mockReturning.mockResolvedValueOnce([
      {
        id: 'cfg-1',
        project: 'Apex',
        friendlyName: 'Default',
        skillProvider: 'ado',
        skillRepo: 'AI-Pilot',
        skillBranch: 'main',
        isDefault: true,
        defaultModel: 'gpt-5',
        repositoryCheckoutStatus: 'ready',
        repositoryCheckoutSha: 'abc',
      },
    ]);

    await upsertSkillConfig({
      id: 'cfg-1',
      project: 'Apex',
      friendlyName: 'Default',
      skillRepo: 'AI-Pilot',
      skillBranch: 'main',
      skillProvider: 'ado',
      defaultModel: 'gpt-5',
    });

    const setArg = (
      mockSet.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(setArg.defaultModel).toBe('gpt-5');
    expect(setArg.repositoryCheckoutStatus).toBeUndefined();
  });
});
