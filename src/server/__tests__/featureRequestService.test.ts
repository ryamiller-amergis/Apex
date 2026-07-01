/**
 * Unit tests for featureRequestService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

jest.mock('../utils/superAdmin', () => ({
  SUPER_ADMIN_EMAILS: ['admin1@example.com', 'admin2@example.com'],
}));

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

import {
  createFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  updateFeatureRequest,
  resolveApexReviewers,
} from '../services/featureRequestService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'fr-1',
    title: 'Dark mode',
    request: 'Add dark mode support',
    advantage: 'Better UX at night',
    submittedBy: 'user-1',
    sourceProject: 'Apex',
    status: 'new',
    aiStatus: 'pending',
    aiPriority: null,
    aiRisk: null,
    aiRationale: null,
    aiThreadId: null,
    teamPriority: null,
    teamRisk: null,
    rank: null,
    reviewedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    submitterName: 'Alice',
    ...overrides,
  };
}

// ── createFeatureRequest ──────────────────────────────────────────────────────

describe('createFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a row with pending/new defaults and returns mapped FeatureRequest', async () => {
    const row = makeRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createFeatureRequest('user-1', 'Apex', {
      title: 'Dark mode',
      request: 'Add dark mode support',
      advantage: 'Better UX at night',
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Dark mode',
        request: 'Add dark mode support',
        advantage: 'Better UX at night',
        submittedBy: 'user-1',
        sourceProject: 'Apex',
        status: 'new',
        aiStatus: 'pending',
      }),
    );
    expect(result).toMatchObject({
      id: 'fr-1',
      title: 'Dark mode',
      status: 'new',
      aiStatus: 'pending',
      submittedBy: 'user-1',
      sourceProject: 'Apex',
    });
  });

  it('maps null submitterName to undefined', async () => {
    const row = makeRow({ submitterName: null });
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createFeatureRequest('user-1', 'Apex', {
      title: 'Test',
      request: 'req',
      advantage: 'adv',
    });

    expect(result.submitterName).toBeUndefined();
  });
});

// ── listFeatureRequests ───────────────────────────────────────────────────────

describe('listFeatureRequests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns mapped feature requests with submitter names', async () => {
    const rows = [makeRow(), makeRow({ id: 'fr-2', title: 'Keyboard shortcuts', submitterName: 'Bob' })];
    const orderByMock = jest.fn().mockResolvedValue(rows);
    const leftJoinMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listFeatureRequests();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'fr-1', submitterName: 'Alice' });
    expect(result[1]).toMatchObject({ id: 'fr-2', submitterName: 'Bob' });
  });

  it('returns empty array when no requests', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const leftJoinMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listFeatureRequests();

    expect(result).toEqual([]);
  });
});

// ── getFeatureRequest ─────────────────────────────────────────────────────────

describe('getFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a single feature request with submitter name', async () => {
    const row = makeRow();
    const whereMock = jest.fn().mockResolvedValue([row]);
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getFeatureRequest('fr-1');

    expect(result).toMatchObject({ id: 'fr-1', title: 'Dark mode', submitterName: 'Alice' });
  });

  it('returns null when not found', async () => {
    const whereMock = jest.fn().mockResolvedValue([]);
    const leftJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getFeatureRequest('nonexistent');

    expect(result).toBeNull();
  });
});

// ── updateFeatureRequest ──────────────────────────────────────────────────────

describe('updateFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates status and returns the updated row', async () => {
    const updatedRow = makeRow({ status: 'planned', reviewedBy: 'reviewer-1' });
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await updateFeatureRequest('fr-1', 'reviewer-1', { status: 'planned' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'planned',
        reviewedBy: 'reviewer-1',
      }),
    );
    expect(result).toMatchObject({ id: 'fr-1', status: 'planned', reviewedBy: 'reviewer-1' });
  });

  it('applies teamPriority, teamRisk, and rank when provided', async () => {
    const updatedRow = makeRow({ teamPriority: 'high', teamRisk: 'low', rank: 1 });
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateFeatureRequest('fr-1', 'reviewer-1', {
      teamPriority: 'high',
      teamRisk: 'low',
      rank: 1,
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamPriority: 'high',
        teamRisk: 'low',
        rank: 1,
      }),
    );
  });

  it('always sets reviewedBy and updatedAt even with empty patch', async () => {
    const updatedRow = makeRow({ reviewedBy: 'reviewer-1' });
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateFeatureRequest('fr-1', 'reviewer-1', {});

    const setArg = setMock.mock.calls[0][0];
    expect(setArg.reviewedBy).toBe('reviewer-1');
    expect(setArg.updatedAt).toBeDefined();
    expect(setArg.status).toBeUndefined();
  });
});

// ── resolveApexReviewers ──────────────────────────────────────────────────────

describe('resolveApexReviewers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns deduplicated user IDs from permission query and super admins', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Permission-based query chain: select → from → innerJoin x3 → where
        const whereMock = jest.fn().mockResolvedValue([{ userId: 'user-A' }, { userId: 'user-B' }]);
        const innerJoin3 = jest.fn().mockReturnValue({ where: whereMock });
        const innerJoin2 = jest.fn().mockReturnValue({ innerJoin: innerJoin3 });
        const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
        const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
        return { from: fromMock };
      }
      // Super admin lookup: select → from → where
      const whereMock = jest.fn().mockResolvedValue([{ oid: 'user-B' }, { oid: 'user-C' }]);
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      return { from: fromMock };
    });

    const result = await resolveApexReviewers();

    expect(result).toHaveLength(3);
    expect(result.sort()).toEqual(['user-A', 'user-B', 'user-C']);
  });

  it('returns only permission-based users when no super admins match', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const whereMock = jest.fn().mockResolvedValue([{ userId: 'user-A' }]);
        const innerJoin3 = jest.fn().mockReturnValue({ where: whereMock });
        const innerJoin2 = jest.fn().mockReturnValue({ innerJoin: innerJoin3 });
        const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
        const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
        return { from: fromMock };
      }
      const whereMock = jest.fn().mockResolvedValue([]);
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      return { from: fromMock };
    });

    const result = await resolveApexReviewers();

    expect(result).toEqual(['user-A']);
  });

  it('returns only super admins when no permission-based users exist', async () => {
    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const whereMock = jest.fn().mockResolvedValue([]);
        const innerJoin3 = jest.fn().mockReturnValue({ where: whereMock });
        const innerJoin2 = jest.fn().mockReturnValue({ innerJoin: innerJoin3 });
        const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
        const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
        return { from: fromMock };
      }
      const whereMock = jest.fn().mockResolvedValue([{ oid: 'admin-1' }]);
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      return { from: fromMock };
    });

    const result = await resolveApexReviewers();

    expect(result).toEqual(['admin-1']);
  });
});
