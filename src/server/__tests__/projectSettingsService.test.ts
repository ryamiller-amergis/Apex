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
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          delete: jest.fn().mockImplementation(makeDeleteChain),
          insert: jest.fn().mockImplementation(makeInsertChain),
        };
        await fn(tx);
      }),
    },
  };
});

import {
  getSkillConfig,
  listSkillConfigs,
  upsertSkillConfig,
  deleteSkillConfig,
  listApprovers,
  listApproversForAllProjects,
  setApprovers,
  getApproversForDocument,
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

  it('persists defaultModel when provided', async () => {
    const configWithDefault = { ...configRow, defaultModel: 'composer-2' };
    const returningMock = jest.fn().mockResolvedValue([configWithDefault]);
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // designPrototypeSkillPath
      undefined, // designPrototypeModel
      'composer-2',
    );

    expect(result).toMatchObject({ defaultModel: 'composer-2' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'composer-2' }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ defaultModel: 'composer-2' }),
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
      undefined, // designPrototypeSkillPath
      undefined, // designPrototypeModel
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

  it('persists approvalMode when provided', async () => {
    const configWithMode = { ...configRow, approvalMode: 'all_required' };
    const returningMock = jest.fn().mockResolvedValue([configWithMode]);
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
      undefined, // designPrototypeSkillPath
      undefined, // designPrototypeModel
      undefined, // designDocValidationSkillPath
      undefined, // designDocValidationModel
      undefined, // quickSkillPills
      undefined, // defaultModel
      'all_required', // approvalMode
    );

    expect(result).toMatchObject({ approvalMode: 'all_required' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'all_required' }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ approvalMode: 'all_required' }),
      }),
    );
  });

  it('defaults approvalMode to any_one when not provided', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ ...configRow, approvalMode: 'any_one' }]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertSkillConfig('proj-alpha', 'org/skills-repo', 'main', 'alice');

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'any_one' }),
    );
  });

  it('persists quickMcpPills when provided', async () => {
    const mcpPills = [
      { label: 'SendGrid', mcpServerName: 'sendgrid', transport: 'stdio' as const, command: 'npx', args: ['-y', 'mcp-sendgrid-server'], env: { SENDGRID_API_KEY: '${SENDGRID_API_KEY}' } },
      { label: 'Twilio Docs', mcpServerName: 'twilio-docs', transport: 'http' as const, url: 'https://mcp.twilio.com/docs' },
    ];
    const configWithMcpPills = { ...configRow, quickMcpPills: mcpPills };
    const returningMock = jest.fn().mockResolvedValue([configWithMcpPills]);
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
      undefined, // designPrototypeSkillPath
      undefined, // designPrototypeModel
      undefined, // designDocValidationSkillPath
      undefined, // designDocValidationModel
      undefined, // quickSkillPills
      undefined, // defaultModel
      undefined, // approvalMode
      mcpPills,  // quickMcpPills
    );

    expect(result).toMatchObject({ quickMcpPills: mcpPills });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ quickMcpPills: mcpPills }),
    );
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ quickMcpPills: mcpPills }),
      }),
    );
  });

  it('stores null for quickMcpPills when not provided', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ ...configRow, quickMcpPills: null }]);
    const onConflictMock = jest.fn().mockReturnValue({ returning: returningMock });
    const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await upsertSkillConfig('proj-alpha', 'org/skills-repo', 'main', 'alice');

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ quickMcpPills: null }),
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

// ── Approver management ───────────────────────────────────────────────────────

const approverRow = {
  id: 'appr-1',
  project: 'proj-alpha',
  userId: 'user-oid-1',
  displayName: 'Alice Admin',
  email: 'alice@example.com',
  documentType: 'design_doc',
  assignedBy: 'admin-oid',
  assignedAt: '2026-01-01T00:00:00Z',
};

describe('listApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns approvers joined with user display data', async () => {
    const whereMock = jest.fn().mockResolvedValue([approverRow]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listApprovers('proj-alpha');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      project: 'proj-alpha',
      userId: 'user-oid-1',
      documentType: 'design_doc',
      displayName: 'Alice Admin',
    });
  });
});

describe('listApproversForAllProjects', () => {
  beforeEach(() => jest.clearAllMocks());

  it('groups approvers by project', async () => {
    const innerJoinMock = jest.fn().mockResolvedValue([
      approverRow,
      { ...approverRow, id: 'appr-2', documentType: 'prd', userId: 'user-oid-2' },
      { ...approverRow, id: 'appr-3', project: 'proj-beta', userId: 'user-oid-3' },
    ]);
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listApproversForAllProjects();

    expect(result['proj-alpha']).toHaveLength(2);
    expect(result['proj-beta']).toHaveLength(1);
  });

  it('returns an empty object when no approvers exist', async () => {
    const innerJoinMock = jest.fn().mockResolvedValue([]);
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listApproversForAllProjects();

    expect(result).toEqual({});
  });
});

describe('setApprovers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaces approvers in a transaction and returns the new list', async () => {
    const whereMock = jest.fn().mockResolvedValue([approverRow]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await setApprovers('proj-alpha', 'design_doc', ['user-oid-1'], 'admin-oid');

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].documentType).toBe('design_doc');
  });
});

describe('getApproversForDocument', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns approvers filtered by project and document type', async () => {
    const whereMock = jest.fn().mockResolvedValue([{ ...approverRow, documentType: 'prd' }]);
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getApproversForDocument('proj-alpha', 'prd');

    expect(result).toHaveLength(1);
    expect(result[0].documentType).toBe('prd');
  });
});
