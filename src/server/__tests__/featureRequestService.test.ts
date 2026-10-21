/**
 * Unit tests for featureRequestService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

jest.mock('../utils/superAdmin', () => ({
  getSuperAdminEmails: jest.fn(() => ['admin1@example.com', 'admin2@example.com']),
}));

jest.mock('../services/projectAssigneeService', () => ({
  APEX_OWNER: {
    oid: 'apex',
    displayName: 'Apex',
    email: '',
    isApex: true,
  },
  assertEligibleHumanAssignee: jest.fn(),
  listProjectAssignees: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/featureRequestRankingService', () => ({
  generateFeatureRequestRankings: jest.fn(),
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
      query: {
        featureRequests: { findFirst: jest.fn() },
        appUsers: { findFirst: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      select: jest.fn().mockImplementation(makeSelectChain),
      transaction: jest.fn(),
    },
  };
});

import {
  createFeatureRequest,
  listFeatureRequests,
  listAssignedToUser,
  getFeatureRequest,
  updateFeatureRequest,
  rankFeatureRequests,
  linkInterview,
  resolveApexReviewers,
} from '../services/featureRequestService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const assigneeService = jest.requireMock(
  '../services/projectAssigneeService',
) as {
  assertEligibleHumanAssignee: jest.Mock;
};
const notificationService = jest.requireMock(
  '../services/notificationService',
) as {
  createNotification: jest.Mock;
};
const rankingService = jest.requireMock(
  '../services/featureRequestRankingService',
) as {
  generateFeatureRequestRankings: jest.Mock;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'fr-1',
    type: 'feature',
    title: 'Dark mode',
    request: 'Add dark mode support',
    advantage: 'Better UX at night',
    interviewId: null,
    submittedBy: 'user-1',
    sourceProject: 'Apex',
    assignedToOid: null,
    assignedToApex: false,
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
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.transaction.mockImplementation((callback: (tx: any) => unknown) => callback(mockDb));
  });

  it('inserts a row with pending/new defaults and returns mapped FeatureRequest', async () => {
    const row = makeRow();
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createFeatureRequest('user-1', 'Apex', {
      type: 'feature',
      title: 'Dark mode',
      request: 'Add dark mode support',
      advantage: 'Better UX at night',
    });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Dark mode',
        type: 'feature',
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
    const row = makeRow({ type: 'technical', advantage: null, submitterName: null });
    const returningMock = jest.fn().mockResolvedValue([row]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createFeatureRequest('user-1', 'Apex', {
      type: 'technical',
      title: 'Test',
      request: 'req',
      advantage: null,
    });

    expect(result.submitterName).toBeUndefined();
    expect(result.type).toBe('technical');
  });

  it('validates, deduplicates, and transactionally links accepted ADRs', async () => {
    const adrId = '11111111-1111-4111-8111-111111111111';
    const row = makeRow();
    const linkedAdr = {
      id: adrId,
      title: 'Use an event bus',
      project: 'Apex',
      repo: 'AI-Pilot',
      slug: 'use-event-bus',
      status: 'accepted',
    };
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([linkedAdr]) }),
    });
    const requestValues = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([row]) });
    const linkValues = jest.fn().mockResolvedValue(undefined);
    mockDb.insert
      .mockReturnValueOnce({ values: requestValues })
      .mockReturnValueOnce({ values: linkValues });

    const result = await createFeatureRequest('user-1', 'Apex', {
      type: 'feature',
      title: 'Dark mode',
      request: 'Add dark mode support',
      adrIds: [adrId, adrId],
    });

    expect(linkValues).toHaveBeenCalledWith([{ featureRequestId: 'fr-1', adrId }]);
    expect(result.linkedAdrs).toEqual([expect.objectContaining({ id: adrId, status: 'accepted' })]);
  });

  it.each(['missing', 'non-accepted', 'cross-project'])(
    'rejects %s ADR links',
    async () => {
      mockDb.select.mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });

      await expect(createFeatureRequest('user-1', 'Apex', {
        type: 'technical',
        title: 'Refactor',
        request: 'Refactor the queue',
        adrIds: ['11111111-1111-4111-8111-111111111111'],
      })).rejects.toThrow(/exist, be accepted, and belong/);
      expect(mockDb.insert).not.toHaveBeenCalled();
    },
  );
});

// ── listFeatureRequests ───────────────────────────────────────────────────────

describe('listFeatureRequests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns mapped feature requests with submitter names', async () => {
    const rows = [makeRow(), makeRow({ id: 'fr-2', title: 'Keyboard shortcuts', submitterName: 'Bob' })];
    const orderByMock = jest.fn().mockResolvedValue(rows);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const assigneeJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock = jest.fn().mockReturnValue({ leftJoin: assigneeJoinMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select
      .mockReturnValueOnce({ from: fromMock })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{
            featureRequestId: 'fr-1',
            id: 'adr-1',
            title: 'Use an event bus',
            project: 'Apex',
            repo: 'AI-Pilot',
            slug: 'use-event-bus',
            status: 'accepted',
          }]) }),
        }),
      });

    const result = await listFeatureRequests('Apex');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'fr-1',
      submitterName: 'Alice',
      linkedAdrs: [expect.objectContaining({ id: 'adr-1' })],
    });
    expect(result[1]).toMatchObject({ id: 'fr-2', submitterName: 'Bob' });
  });

  it('returns empty array when no requests', async () => {
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const assigneeJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock = jest.fn().mockReturnValue({ leftJoin: assigneeJoinMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listFeatureRequests('Apex');

    expect(result).toEqual([]);
  });
});

// ── listAssignedToUser ────────────────────────────────────────────────────────

/**
 * Walks a Drizzle SQL expression tree and collects the referenced column names
 * and bound parameter values, so tests can assert which filters were applied
 * without a real database.
 */
function collectFilter(
  node: unknown,
  acc: { columns: string[]; params: unknown[] } = { columns: [], params: [] },
): { columns: string[]; params: unknown[] } {
  if (node === null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) collectFilter(child, acc);
    return acc;
  }
  const candidate = node as Record<string, unknown>;
  if (Array.isArray(candidate.queryChunks)) {
    return collectFilter(candidate.queryChunks, acc);
  }
  if (candidate.table && typeof candidate.name === 'string') {
    acc.columns.push(candidate.name);
    return acc;
  }
  if ('encoder' in candidate && 'value' in candidate) {
    acc.params.push(candidate.value);
    return acc;
  }
  return acc;
}

describe('listAssignedToUser', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockAssignedQuery(rows: unknown[]) {
    const limitMock = jest.fn().mockResolvedValue(rows);
    const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const assigneeJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock = jest.fn().mockReturnValue({ leftJoin: assigneeJoinMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValueOnce({ from: fromMock });
    // loadLinkedAdrs only queries when there is at least one row to enrich.
    if (rows.length > 0) {
      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        }),
      });
    }
    return { whereMock, limitMock };
  }

  it('maps assigned rows into feature requests with the assignee attached', async () => {
    mockAssignedQuery([
      makeRow({
        assignedToOid: 'user-2',
        assigneeName: 'Bob',
        assigneeEmail: 'bob@example.com',
        status: 'planned',
      }),
    ]);

    const result = await listAssignedToUser('Apex', 'user-2');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'fr-1',
      status: 'planned',
      assignedToApex: false,
      assignedTo: { oid: 'user-2', displayName: 'Bob', email: 'bob@example.com' },
      linkedAdrs: [],
    });
  });

  it('filters by project, assignee, non-Apex, and the open backlog statuses', async () => {
    const { whereMock, limitMock } = mockAssignedQuery([]);

    const result = await listAssignedToUser('Apex', 'user-2');

    expect(result).toEqual([]);
    const filter = collectFilter(whereMock.mock.calls[0][0]);
    expect(filter.columns).toEqual(
      expect.arrayContaining(['source_project', 'assigned_to_oid', 'assigned_to_apex', 'status']),
    );
    expect(filter.params).toEqual(
      expect.arrayContaining([
        'Apex',
        'user-2',
        false,
        'new',
        'under-review',
        'in-interview',
        'planned',
      ]),
    );
    expect(filter.params).not.toEqual(expect.arrayContaining(['declined']));
    expect(filter.params).not.toEqual(expect.arrayContaining(['done']));
    expect(limitMock).toHaveBeenCalledWith(100);
  });
});

// ── getFeatureRequest ─────────────────────────────────────────────────────────

describe('getFeatureRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a single feature request with submitter name', async () => {
    const row = makeRow();
    const whereMock = jest.fn().mockResolvedValue([row]);
    const assigneeJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock = jest.fn().mockReturnValue({ leftJoin: assigneeJoinMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select
      .mockReturnValueOnce({ from: fromMock })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{
            featureRequestId: 'fr-1',
            id: 'adr-1',
            title: 'Use an event bus',
            project: 'Apex',
            repo: 'AI-Pilot',
            slug: 'use-event-bus',
            status: 'accepted',
          }]) }),
        }),
      });

    const result = await getFeatureRequest('fr-1');

    expect(result).toMatchObject({
      id: 'fr-1',
      title: 'Dark mode',
      submitterName: 'Alice',
      linkedAdrs: [expect.objectContaining({ id: 'adr-1' })],
    });
  });

  it('returns null when not found', async () => {
    const whereMock = jest.fn().mockResolvedValue([]);
    const assigneeJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const leftJoinMock = jest.fn().mockReturnValue({ leftJoin: assigneeJoinMock });
    const fromMock = jest.fn().mockReturnValue({ leftJoin: leftJoinMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await getFeatureRequest('nonexistent');

    expect(result).toBeNull();
  });
});

// ── updateFeatureRequest ──────────────────────────────────────────────────────

describe('updateFeatureRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.featureRequests.findFirst.mockResolvedValue(makeRow());
  });

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

  it('validates a human assignee against the request project and stores only the human column', async () => {
    const updatedRow = makeRow({
      assignedToOid: 'user-2',
      assignedToApex: false,
    });
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([updatedRow]),
      }),
    });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.appUsers.findFirst.mockResolvedValue({
      oid: 'user-2',
      displayName: 'Bob',
      email: 'bob@example.com',
    });

    await updateFeatureRequest('fr-1', 'reviewer-1', {
      assigneeId: 'user-2',
    });

    expect(
      assigneeService.assertEligibleHumanAssignee,
    ).toHaveBeenCalledWith('Apex', 'user-2');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedToOid: 'user-2',
        assignedToApex: false,
      }),
    );
  });

  it('rejects a human assignee outside the request project', async () => {
    assigneeService.assertEligibleHumanAssignee.mockRejectedValueOnce(
      new Error('Assignee must be a member of the selected project'),
    );

    await expect(
      updateFeatureRequest('fr-1', 'reviewer-1', {
        assigneeId: 'outside-user',
      }),
    ).rejects.toThrow(/member of the selected project/);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('stores Apex exclusively and skips person notification', async () => {
    const updatedRow = makeRow({
      assignedToOid: null,
      assignedToApex: true,
    });
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([updatedRow]),
      }),
    });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateFeatureRequest('fr-1', 'reviewer-1', {
      assigneeId: 'apex',
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedToOid: null,
        assignedToApex: true,
      }),
    );
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it('notifies a newly assigned human who is not the actor', async () => {
    const updatedRow = makeRow({
      assignedToOid: 'user-2',
      assignedToApex: false,
    });
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedRow]),
        }),
      }),
    });
    mockDb.query.appUsers.findFirst
      .mockResolvedValueOnce({
        oid: 'reviewer-1',
        displayName: 'Reviewer',
        email: 'reviewer@example.com',
      })
      .mockResolvedValueOnce({
        oid: 'user-2',
        displayName: 'Bob',
        email: 'bob@example.com',
      });

    await updateFeatureRequest('fr-1', 'reviewer-1', {
      assigneeId: 'user-2',
    });

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({
        type: 'user-action',
        title: 'Work item assigned to you',
        body: 'Reviewer assigned "Dark mode" to you',
        link: '/my-work?section=backlog&itemId=fr-1',
      }),
    );
  });
});

describe('rankFeatureRequests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persists AI rank, tier, and rationale in one transaction', async () => {
    const row = makeRow();
    rankingService.generateFeatureRequestRankings.mockResolvedValue([
      { id: 'fr-1', priority: 'high', rationale: 'High customer impact.' },
    ]);
    const txWhere = jest.fn().mockResolvedValue(undefined);
    const txSet = jest
      .fn()
      .mockReturnValue({ where: txWhere });
    const txUpdate = jest.fn().mockReturnValue({ set: txSet });
    mockDb.transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) =>
        callback({ update: txUpdate }),
    );

    mockDb.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([row]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([row]),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

    const result = await rankFeatureRequests(
      'reviewer-1',
      'Apex',
      ['fr-1'],
    );

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(txSet).toHaveBeenCalledWith(
      expect.objectContaining({
        rank: 1,
        aiPriority: 'high',
        aiRationale: 'High customer impact.',
        aiStatus: 'complete',
      }),
    );
    expect(result.items).toHaveLength(1);
  });
});

// ── linkInterview ─────────────────────────────────────────────────────────────

describe('linkInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets the interview ID, in-interview status, and updated timestamp', async () => {
    const updatedRow = makeRow({ interviewId: 'interview-1', status: 'in-interview' });
    const returningMock = jest.fn().mockResolvedValue([updatedRow]);
    const whereMock = jest.fn().mockReturnValue({ returning: returningMock });
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await linkInterview('fr-1', 'interview-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: 'interview-1',
        status: 'in-interview',
        updatedAt: expect.any(String),
      }),
    );
    expect(result.interviewId).toBe('interview-1');
    expect(result.status).toBe('in-interview');
  });
});

// ── resolveFeatureRequestReviewers / resolveApexReviewers ─────────────────────

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
