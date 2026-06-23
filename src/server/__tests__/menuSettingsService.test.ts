jest.mock('../db/drizzle', () => {
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  });

  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoUpdate: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      select: jest.fn().mockImplementation(makeSelectChain),
      insert: jest.fn().mockImplementation(makeInsertChain),
    },
  };
});

import { getMenuConfig, listMenuConfigs, upsertMenuConfig } from '../services/menuSettingsService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const sampleRow = {
  id: 'uuid-1',
  project: 'ProjectAlpha',
  enabledViews: ['calendar', 'planning'] as any,
  updatedBy: 'admin@amergis.com',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ── getMenuConfig ──────────────────────────────────────────────────────────────

describe('getMenuConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a ProjectMenuConfig when a row exists', async () => {
    const whereMock = jest.fn().mockResolvedValue([sampleRow]);
    const fromMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getMenuConfig('ProjectAlpha');

    expect(result).toEqual({
      project: 'ProjectAlpha',
      enabledViews: ['calendar', 'planning'],
      updatedBy: 'admin@amergis.com',
    });
  });

  it('returns null when no row matches', async () => {
    const whereMock = jest.fn().mockResolvedValue([]);
    const fromMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getMenuConfig('NoSuchProject');

    expect(result).toBeNull();
  });
});

// ── listMenuConfigs ────────────────────────────────────────────────────────────

describe('listMenuConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all configs ordered by project', async () => {
    const row2 = { ...sampleRow, project: 'ProjectBeta', enabledViews: ['backlog'] };
    const orderByMock = jest.fn().mockResolvedValue([sampleRow, row2]);
    const fromMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listMenuConfigs();

    expect(result).toHaveLength(2);
    expect(result[0].project).toBe('ProjectAlpha');
    expect(result[1].project).toBe('ProjectBeta');
  });

  it('returns an empty array when no configs exist', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const fromMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listMenuConfigs();

    expect(result).toEqual([]);
  });
});

// ── upsertMenuConfig ───────────────────────────────────────────────────────────

describe('upsertMenuConfig', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts or updates and returns the resulting config', async () => {
    const returningMock = jest.fn().mockResolvedValue([sampleRow]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await upsertMenuConfig('ProjectAlpha', ['calendar', 'planning'], 'admin@amergis.com');

    expect(result).toEqual({
      project: 'ProjectAlpha',
      enabledViews: ['calendar', 'planning'],
      updatedBy: 'admin@amergis.com',
    });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'ProjectAlpha', enabledViews: ['calendar', 'planning'] }),
    );
  });
});
