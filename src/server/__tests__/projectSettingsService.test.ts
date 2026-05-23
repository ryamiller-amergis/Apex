/**
 * Unit tests for projectSettingsService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
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
    },
  };
});

import {
  getSkillConfig,
  listSkillConfigs,
  upsertSkillConfig,
  deleteSkillConfig,
} from '../services/projectSettingsService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Fixtures ───────────────────────────────────────────────────────────────────

const configRow = {
  id: 'cfg-1',
  project: 'proj-alpha',
  skillRepo: 'org/skills-repo',
  skillBranch: 'main',
  updatedBy: 'alice',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

// ── getSkillConfig ─────────────────────────────────────────────────────────────

describe('getSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the config when it exists', async () => {
    const limitMock = jest.fn().mockResolvedValue([configRow]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const fromMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getSkillConfig('proj-alpha');

    expect(result).toEqual(configRow);
  });

  it('returns null when no config exists for the project', async () => {
    const limitMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ limit: limitMock });
    const fromMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getSkillConfig('proj-missing');

    expect(result).toBeNull();
  });
});

// ── listSkillConfigs ───────────────────────────────────────────────────────────

describe('listSkillConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all configs ordered by project', async () => {
    const orderByMock = jest.fn().mockResolvedValue([configRow]);
    const fromMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listSkillConfigs();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ project: 'proj-alpha', skillRepo: 'org/skills-repo' });
  });

  it('returns an empty array when no configs exist', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const fromMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listSkillConfigs();

    expect(result).toEqual([]);
  });
});

// ── upsertSkillConfig ──────────────────────────────────────────────────────────

describe('upsertSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts (or updates on conflict) and returns the upserted row', async () => {
    const returningMock = jest.fn().mockResolvedValue([configRow]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await upsertSkillConfig('proj-alpha', 'org/skills-repo', 'main', 'alice');

    expect(result).toEqual(configRow);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'proj-alpha',
        skillRepo: 'org/skills-repo',
        skillBranch: 'main',
        updatedBy: 'alice',
      }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ skillRepo: 'org/skills-repo', skillBranch: 'main' }),
      }),
    );
  });

  it('works without an updatedBy value', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ ...configRow, updatedBy: undefined }]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await upsertSkillConfig('proj-beta', 'org/repo', 'develop');

    expect(result).toMatchObject({ project: 'proj-alpha' });
  });

  it('persists interviewModel, prdModel, and designDocModel when provided', async () => {
    const configWithModels = {
      ...configRow,
      interviewModel: 'claude-3.5-sonnet',
      prdModel: 'gpt-4o',
      designDocModel: 'claude-3-opus',
    };
    const returningMock = jest.fn().mockResolvedValue([configWithModels]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await upsertSkillConfig(
      'proj-alpha',
      'org/skills-repo',
      'main',
      'alice',
      undefined,
      undefined,
      undefined,
      'claude-3.5-sonnet',
      'gpt-4o',
      'claude-3-opus',
    );

    expect(result).toMatchObject({
      interviewModel: 'claude-3.5-sonnet',
      prdModel: 'gpt-4o',
      designDocModel: 'claude-3-opus',
    });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewModel: 'claude-3.5-sonnet',
        prdModel: 'gpt-4o',
        designDocModel: 'claude-3-opus',
      }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          interviewModel: 'claude-3.5-sonnet',
          prdModel: 'gpt-4o',
          designDocModel: 'claude-3-opus',
        }),
      }),
    );
  });

  it('stores null for model fields when not provided (omitted)', async () => {
    const configNoModels = {
      ...configRow,
      interviewModel: null,
      prdModel: null,
      designDocModel: null,
    };
    const returningMock = jest.fn().mockResolvedValue([configNoModels]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertSkillConfig('proj-alpha', 'org/skills-repo', 'main', 'alice');

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewModel: null,
        prdModel: null,
        designDocModel: null,
      }),
    );
  });

  it('persists designDocValidationSkillPath and designDocValidationModel when provided', async () => {
    const configWithValidation = {
      ...configRow,
      designDocValidationSkillPath: '.cursor/skills/validate/SKILL.md',
      designDocValidationModel: 'claude-3-opus',
    };
    const returningMock = jest.fn().mockResolvedValue([configWithValidation]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await upsertSkillConfig(
      'proj-alpha',
      'org/skills-repo',
      'main',
      'alice',
      undefined, // interviewSkillPath
      undefined, // prdSkillPath
      undefined, // designDocSkillPath
      undefined, // interviewModel
      undefined, // prdModel
      undefined, // designDocModel
      undefined, // designDocQaSkillPath
      undefined, // designDocQaModel
      undefined, // designDocAssistantSkillPath
      undefined, // designDocAssistantModel
      '.cursor/skills/validate/SKILL.md', // designDocValidationSkillPath
      'claude-3-opus', // designDocValidationModel
    );

    expect(result).toMatchObject({
      designDocValidationSkillPath: '.cursor/skills/validate/SKILL.md',
      designDocValidationModel: 'claude-3-opus',
    });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        designDocValidationSkillPath: '.cursor/skills/validate/SKILL.md',
        designDocValidationModel: 'claude-3-opus',
      }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          designDocValidationSkillPath: '.cursor/skills/validate/SKILL.md',
          designDocValidationModel: 'claude-3-opus',
        }),
      }),
    );
  });
});

// ── deleteSkillConfig ──────────────────────────────────────────────────────────

describe('deleteSkillConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the config for the specified project', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteSkillConfig('proj-alpha');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});
