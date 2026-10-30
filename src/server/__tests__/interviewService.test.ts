/**
 * Unit tests for interviewService.
 * The Drizzle `db` instance is fully mocked so no real database is needed.
 */

// ── Service mocks ─────────────────────────────────────────────────────────────

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

jest.mock('../services/chatAgentService', () => ({
  markAsInterviewThread: jest.fn(),
  cancelRun: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/artifactDoneEventService', () => ({
  recordArtifactDoneEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isPlatformAdmin: jest.fn().mockResolvedValue(false),
  isProjectAdmin: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/rbacService', () => ({
  getActiveUsers: jest.fn().mockResolvedValue([]),
}));

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
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
    orderBy: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        interviews: { findFirst: jest.fn() },
        prds: { findFirst: jest.fn() },
        buildRuns: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

import {
  createInterview,
  listInterviews,
  getInterview,
  updateInterviewStatus,
  updateInterviewPhaseAssignments,
  updateInterviewTitle,
  deleteInterview,
  canCompleteInterviewAndGeneratePrd,
} from '../services/interviewService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const { createNotification: mockCreateNotification } = jest.requireMock('../services/notificationService') as {
  createNotification: jest.Mock;
};
const { getActiveUsers: mockGetActiveUsers } = jest.requireMock('../services/rbacService') as {
  getActiveUsers: jest.Mock;
};
const { isPlatformAdmin: mockIsPlatformAdmin, isProjectAdmin: mockIsProjectAdmin } = jest.requireMock(
  '../utils/rbacHelpers',
) as {
  isPlatformAdmin: jest.Mock;
  isProjectAdmin: jest.Mock;
};

const COMPLETE_FORBIDDEN =
  'Only the author, an interview section owner, a project admin, or a platform admin can complete an interview';

const COMPLETE_INVALID_STATUS = 'Only in-progress interviews can be marked complete';

const AUTHOR_STATUS_FORBIDDEN = 'Only the author can change interview status';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const interviewRow = {
  id: 'interview-1',
  chatThreadId: 'thread-1',
  authorId: 'user-1',
  title: 'My Interview',
  project: 'proj-alpha',
  repo: 'org/repo-alpha',
  status: 'in_progress',
  prototypeStageEnabled: true,
  prdOwnerId: 'owner-prd',
  designDocOwnerId: 'owner-dd',
  designPrototypeOwnerId: 'owner-proto',
  testCaseOwnerId: 'owner-qa',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const prdRow = {
  id: 'prd-1',
  interviewId: 'interview-1',
  chatThreadId: 'thread-2',
  authorId: 'user-1',
  title: 'Feature PRD',
  content: 'Content goes here',
  backlogJson: null,
  status: 'draft',
  reviewerId: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: '2026-01-03T00:00:00Z',
  updatedAt: '2026-01-04T00:00:00Z',
};

// ── createInterview ────────────────────────────────────────────────────────────

describe('createInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new interview and returns interviewId + threadId', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      title: 'Sprint Planning',
      chatThreadId: 'thread-abc',
      effort: 'medium',
    });

    expect(result).toEqual({ interviewId: 'interview-new', threadId: 'thread-abc' });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'user-1',
        project: 'proj',
        repo: 'org/repo',
        title: 'Sprint Planning',
        chatThreadId: 'thread-abc',
        effort: 'medium',
        status: 'in_progress',
      }),
    );
  });

  it('defaults title to "Untitled Interview" when not supplied', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-untitled' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({ userId: 'user-1', project: 'p', repo: 'r', chatThreadId: 't' });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Untitled Interview' }),
    );
  });

  it('persists prdOwnerId and designDocOwnerId when provided', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-owners' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      chatThreadId: 'thread-abc',
      prdOwnerId: 'user-prd',
      designDocOwnerId: 'user-dd',
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ prdOwnerId: 'user-prd', designDocOwnerId: 'user-dd' }),
    );
  });

  it('sends a PRD-owner notification when prdOwnerId is set', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-notif' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      title: 'Sprint Planning',
      chatThreadId: 'thread-abc',
      prdOwnerId: 'user-prd',
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-prd',
      expect.objectContaining({
        type: 'user-action',
        title: 'Assigned as PRD Owner',
        link: '/backlog/interview/interview-notif',
      }),
    );
  });

  it('sends a Design Doc owner notification when designDocOwnerId is set', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-notif2' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      title: 'Sprint Planning',
      chatThreadId: 'thread-abc',
      designDocOwnerId: 'user-dd',
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-dd',
      expect.objectContaining({
        type: 'user-action',
        title: 'Assigned as Design Doc Owner',
      }),
    );
  });

  it('does not fail interview creation when notification dispatch rejects', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-fail-notif' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockCreateNotification.mockRejectedValue(new Error('SMTP unavailable'));

    await expect(
      createInterview({
        userId: 'user-1',
        project: 'proj',
        repo: 'org/repo',
        chatThreadId: 'thread-abc',
        prdOwnerId: 'user-prd',
      }),
    ).resolves.toMatchObject({ interviewId: 'interview-fail-notif', threadId: 'thread-abc' });
  });

  it('sends no notifications when no owner IDs are provided', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-no-owners' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({ userId: 'user-1', project: 'proj', repo: 'org/repo', chatThreadId: 't' });

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('TBI-006 DoD-0/DoD-1 creates owner-only modules with zero reviewer notifications', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-owner-only' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      chatThreadId: 'thread-owner-only',
      prdApproverIds: [],
      designDocApproverIds: [],
      designPrototypeApproverIds: [],
      testCaseApproverIds: [],
    });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      prdApproverIds: [],
      designDocApproverIds: [],
      designPrototypeApproverIds: [],
      testCaseApproverIds: [],
    }));
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('TBI-004 DoD-0/DoD-2 persists each explicitly supplied reviewer snapshot', async () => {
    const returningMock = jest.fn()
      .mockResolvedValueOnce([{ id: 'interview-before' }])
      .mockResolvedValueOnce([{ id: 'interview-after' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      chatThreadId: 'thread-before',
      prdApproverIds: ['reviewer-before'],
    });
    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      chatThreadId: 'thread-after',
      prdApproverIds: ['reviewer-after'],
    });

    expect(valuesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prdApproverIds: ['reviewer-before'],
    }));
    expect(valuesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prdApproverIds: ['reviewer-after'],
    }));
  });

  it('sends reviewer notifications for each approver role', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-reviewers' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      title: 'Sprint Planning',
      chatThreadId: 'thread-abc',
      prdApproverIds: ['user-prd-rev'],
      designDocApproverIds: ['user-dd-rev'],
      designPrototypeApproverIds: ['user-proto-rev'],
      testCaseApproverIds: ['user-qa-rev'],
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-prd-rev',
      expect.objectContaining({
        type: 'user-action',
        title: 'Assigned as PRD Reviewer',
        link: '/backlog/interview/interview-reviewers',
      }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-dd-rev',
      expect.objectContaining({ title: 'Assigned as Design Doc Reviewer' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-proto-rev',
      expect.objectContaining({ title: 'Assigned as Design Prototype Reviewer' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-qa-rev',
      expect.objectContaining({ title: 'Assigned as QA Reviewer' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(4);
  });
});

describe('VT-BRIEF-2 — createInterview persists optional Playbook linkage', () => {
  const snapshot = {
    mode: 'human_led' as const,
    key: 'ba-discovery',
    skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
    model: 'claude-sonnet',
    effort: 'high' as const,
    wantsDesignPrototype: false,
    wantsTestCases: true,
  };

  beforeEach(() => jest.clearAllMocks());

  function mockInsert() {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'interview-playbook' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    return valuesMock;
  }

  it('VT-BRIEF-2 stores the run, step run, mode, profile key, and profile snapshot', async () => {
    const valuesMock = mockInsert();

    const result = await createInterview({
      userId: 'user-1',
      project: 'Apex',
      repo: 'org/apex',
      title: 'BA discovery',
      chatThreadId: 'thread-abc',
      playbookRunId: 'run-1',
      playbookStepRunId: 'step-run-1',
      playbookInterviewMode: 'human_led',
      playbookProfileKey: 'ba-discovery',
      playbookProfileSnapshot: snapshot,
    });

    expect(result).toEqual({ interviewId: 'interview-playbook', threadId: 'thread-abc' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'user-1',
        project: 'Apex',
        chatThreadId: 'thread-abc',
        status: 'in_progress',
        playbookRunId: 'run-1',
        playbookStepRunId: 'step-run-1',
        playbookInterviewMode: 'human_led',
        playbookProfileKey: 'ba-discovery',
        playbookProfileSnapshot: snapshot,
      }),
    );
  });

  it('VT-BRIEF-2 leaves Playbook columns null for an ordinary interview', async () => {
    const valuesMock = mockInsert();

    await createInterview({
      userId: 'user-1',
      project: 'proj',
      repo: 'org/repo',
      chatThreadId: 'thread-abc',
      title: 'Sprint Planning',
    });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sprint Planning',
        status: 'in_progress',
        playbookRunId: null,
        playbookStepRunId: null,
        playbookInterviewMode: null,
        playbookProfileKey: null,
        playbookProfileSnapshot: null,
      }),
    );
  });

  it('VT-BRIEF-2 rejects a partial Playbook snapshot before inserting', async () => {
    const valuesMock = mockInsert();

    await expect(
      createInterview({
        userId: 'user-1',
        project: 'Apex',
        repo: 'org/apex',
        chatThreadId: 'thread-abc',
        playbookRunId: 'run-1',
      }),
    ).rejects.toThrow(/Playbook interview linkage/);

    expect(valuesMock).not.toHaveBeenCalled();
  });
});

// ── listInterviews ─────────────────────────────────────────────────────────────

describe('listInterviews', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns interview summaries with prdCount', async () => {
    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([interviewRow]),
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([{ interviewId: 'interview-1', cnt: '2' }]),
      }));

    const result = await listInterviews({ authorId: 'user-1' });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'interview-1',
      title: 'My Interview',
      project: 'proj-alpha',
      status: 'in_progress',
      prdCount: 2,
      prototypeStageEnabled: true,
    });
  });

  it('returns 0 prdCount for interviews with no PRDs', async () => {
    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([interviewRow]),
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([]),
      }));

    const result = await listInterviews({ authorId: 'user-1' });

    expect(result[0].prdCount).toBe(0);
  });

  it('returns an empty array when the user has no interviews', async () => {
    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([]),
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([]),
      }));

    const result = await listInterviews({ authorId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only interviews belonging to the specified project', async () => {
    const betaRow = { ...interviewRow, id: 'interview-2', project: 'proj-beta' };

    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([interviewRow]), // only proj-alpha returned
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([]),
      }));

    const result = await listInterviews({ authorId: 'user-1', project: 'proj-alpha' });

    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('proj-alpha');
    expect(result.some((iv) => iv.id === betaRow.id)).toBe(false);
  });

  it('returns empty array when no interviews exist for the requested project', async () => {
    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([]),
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([]),
      }));

    const result = await listInterviews({ authorId: 'user-1', project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('includes prdOwnerId and designDocOwnerId in returned summaries', async () => {
    const ownerRow = {
      ...interviewRow,
      prdOwnerId: 'user-prd',
      designDocOwnerId: 'user-dd',
    };

    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([ownerRow]),
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([]),
      }));

    const result = await listInterviews({ authorId: 'user-1' });

    expect(result).toHaveLength(1);
    expect(result[0].prdOwnerId).toBe('user-prd');
    expect(result[0].designDocOwnerId).toBe('user-dd');
  });

  it('can combine project and status filters', async () => {
    const completedRow = { ...interviewRow, status: 'complete' };

    mockDb.select
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockResolvedValue([completedRow]),
      }))
      .mockImplementationOnce(() => ({
        from: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockResolvedValue([]),
      }));

    const result = await listInterviews({ authorId: 'user-1', project: 'proj-alpha', status: 'complete' });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('complete');
    expect(result[0].project).toBe('proj-alpha');
  });
});

// ── getInterview ───────────────────────────────────────────────────────────────

describe('getInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an interview with its PRD summaries', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      prds: [prdRow],
    });

    const result = await getInterview('interview-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('interview-1');
    expect(result!.prds).toHaveLength(1);
    expect(result!.prds[0]).toMatchObject({ id: 'prd-1', status: 'draft' });
    expect(result!.prdCount).toBe(1);
  });

  it('returns null when the interview does not exist', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(null);

    const result = await getInterview('interview-missing');

    expect(result).toBeNull();
  });

  it('maps owner names from joined owner relations', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      prds: [],
      prdOwnerId: 'user-prd',
      prdOwner: { displayName: 'Alice PRD Owner' },
      designDocOwnerId: 'user-dd',
      designDocOwner: { displayName: 'Bob DD Owner' },
      designPrototypeOwnerId: 'user-proto',
      designPrototypeOwner: { displayName: 'Carol UX Owner' },
    });

    const result = await getInterview('interview-1');

    expect(result).not.toBeNull();
    expect(result!.prdOwnerId).toBe('user-prd');
    expect(result!.prdOwnerName).toBe('Alice PRD Owner');
    expect(result!.designDocOwnerId).toBe('user-dd');
    expect(result!.designDocOwnerName).toBe('Bob DD Owner');
    expect(result!.designPrototypeOwnerId).toBe('user-proto');
    expect(result!.designPrototypeOwnerName).toBe('Carol UX Owner');
  });

  it('returns undefined for owner name fields when owners are not set', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      prds: [],
      prdOwnerId: null,
      prdOwner: null,
      designDocOwnerId: null,
      designDocOwner: null,
      designPrototypeOwnerId: null,
      designPrototypeOwner: null,
    });

    const result = await getInterview('interview-1');

    expect(result!.prdOwnerId).toBeUndefined();
    expect(result!.prdOwnerName).toBeUndefined();
    expect(result!.designDocOwnerId).toBeUndefined();
    expect(result!.designDocOwnerName).toBeUndefined();
    expect(result!.designPrototypeOwnerId).toBeUndefined();
    expect(result!.designPrototypeOwnerName).toBeUndefined();
  });
});

// ── updateInterviewStatus ──────────────────────────────────────────────────────

describe('canCompleteInterviewAndGeneratePrd', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPlatformAdmin.mockResolvedValue(false);
    mockIsProjectAdmin.mockResolvedValue(false);
  });

  it('allows the interview author', async () => {
    await expect(canCompleteInterviewAndGeneratePrd('user-1', interviewRow)).resolves.toBe(true);
    expect(mockIsPlatformAdmin).not.toHaveBeenCalled();
    expect(mockIsProjectAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ['PRD section owner', 'owner-prd'],
    ['design doc section owner', 'owner-dd'],
    ['design prototype section owner', 'owner-proto'],
    ['QA section owner', 'owner-qa'],
  ])('allows the %s when they are not the author', async (_label, userId) => {
    await expect(canCompleteInterviewAndGeneratePrd(userId, interviewRow)).resolves.toBe(true);
  });

  it('allows a project admin who is not the author or a section owner', async () => {
    mockIsProjectAdmin.mockResolvedValue(true);

    await expect(canCompleteInterviewAndGeneratePrd('project-admin', interviewRow)).resolves.toBe(true);
    expect(mockIsProjectAdmin).toHaveBeenCalledWith('project-admin', 'proj-alpha');
  });

  it('allows a platform admin who is not the author or a section owner', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true);

    await expect(canCompleteInterviewAndGeneratePrd('platform-admin', interviewRow)).resolves.toBe(true);
    expect(mockIsPlatformAdmin).toHaveBeenCalledWith('platform-admin');
  });

  it('denies a user who is not the author, a section owner, or an admin', async () => {
    await expect(canCompleteInterviewAndGeneratePrd('user-other', interviewRow)).resolves.toBe(false);
  });

  it('does not allow an unrelated user just because they could hold interviews:manage', async () => {
    await expect(canCompleteInterviewAndGeneratePrd('manage-only', interviewRow)).resolves.toBe(false);
    expect(mockIsPlatformAdmin).toHaveBeenCalledWith('manage-only');
    expect(mockIsProjectAdmin).toHaveBeenCalledWith('manage-only', 'proj-alpha');
  });
});

describe('updateInterviewStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPlatformAdmin.mockResolvedValue(false);
    mockIsProjectAdmin.mockResolvedValue(false);
  });

  function mockStatusPersist() {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    return setMock;
  }

  it('DoD-4 persists terminal status before making grounding cleanup-eligible', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewStatus('interview-1', 'user-1', 'complete');

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(setMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'complete' }),
    );
    expect(setMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ isActive: false }),
    );
  });

  it('throws 400 for an invalid status', async () => {
    await expect(
      updateInterviewStatus('interview-1', 'user-1', 'invalid_status' as any),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid interview status') });
  });

  it('throws 404 when the interview does not exist', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(null);

    await expect(
      updateInterviewStatus('interview-missing', 'user-1', 'complete'),
    ).rejects.toMatchObject({ message: 'Interview not found' });
  });

  it('lets the author set status to complete', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const setMock = mockStatusPersist();

    await updateInterviewStatus('interview-1', 'user-1', 'complete');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
  });

  it.each([
    ['PRD section owner', 'owner-prd'],
    ['design doc section owner', 'owner-dd'],
    ['design prototype section owner', 'owner-proto'],
    ['QA section owner', 'owner-qa'],
  ])('lets the %s set status to complete when they are not the author', async (_label, userId) => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const setMock = mockStatusPersist();

    await updateInterviewStatus('interview-1', userId, 'complete');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
  });

  it('lets a project admin set status to complete when they are not the author or a section owner', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    mockIsProjectAdmin.mockResolvedValue(true);
    const setMock = mockStatusPersist();

    await updateInterviewStatus('interview-1', 'project-admin', 'complete');

    expect(mockIsProjectAdmin).toHaveBeenCalledWith('project-admin', 'proj-alpha');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
  });

  it('lets a platform admin set status to complete when they are not the author or a section owner', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    mockIsPlatformAdmin.mockResolvedValue(true);
    const setMock = mockStatusPersist();

    await updateInterviewStatus('interview-1', 'platform-admin', 'complete');

    expect(mockIsPlatformAdmin).toHaveBeenCalledWith('platform-admin');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'complete' }));
  });

  it('throws 403 when a user who is not the author, a section owner, or an admin sets complete', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);

    await expect(
      updateInterviewStatus('interview-1', 'user-other', 'complete'),
    ).rejects.toMatchObject({ status: 403, message: COMPLETE_FORBIDDEN });
  });

  it.each([
    ['author', 'user-1'],
    ['section owner', 'owner-prd'],
  ])('throws 409 when the %s completes an archived interview', async (_label, userId) => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      status: 'archived',
    });

    await expect(
      updateInterviewStatus('interview-1', userId, 'complete'),
    ).rejects.toMatchObject({ status: 409, message: COMPLETE_INVALID_STATUS });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('throws 409 when a completer marks an already-complete interview complete', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      status: 'complete',
    });

    await expect(
      updateInterviewStatus('interview-1', 'user-1', 'complete'),
    ).rejects.toMatchObject({ status: 409, message: COMPLETE_INVALID_STATUS });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('throws 409 when a completer marks a playbook interview complete', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      playbookRunId: 'run-1',
    });

    await expect(
      updateInterviewStatus('interview-1', 'user-1', 'complete'),
    ).rejects.toMatchObject({ status: 409, message: COMPLETE_INVALID_STATUS });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it.each([
    ['in_progress'],
    ['archived'],
  ])('throws 403 when a section owner sets status to %s', async (status) => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);

    await expect(
      updateInterviewStatus('interview-1', 'owner-prd', status as 'in_progress' | 'archived'),
    ).rejects.toMatchObject({ status: 403, message: AUTHOR_STATUS_FORBIDDEN });
  });

  it('lets the author reopen and archive', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const setMock = mockStatusPersist();

    await updateInterviewStatus('interview-1', 'user-1', 'in_progress');
    await updateInterviewStatus('interview-1', 'user-1', 'archived');

    expect(setMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'in_progress' }));
    expect(setMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'archived' }));
  });

  it('still rejects a platform admin who tries to archive or reopen someone else\'s interview', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    mockIsPlatformAdmin.mockResolvedValue(true);

    await expect(
      updateInterviewStatus('interview-1', 'platform-admin', 'archived'),
    ).rejects.toMatchObject({ status: 403, message: AUTHOR_STATUS_FORBIDDEN });
    await expect(
      updateInterviewStatus('interview-1', 'platform-admin', 'in_progress'),
    ).rejects.toMatchObject({ status: 403, message: AUTHOR_STATUS_FORBIDDEN });
  });
});

// ── updateInterviewTitle ───────────────────────────────────────────────────────

describe('updateInterviewTitle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates the title when the requesting user is the author', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewTitle('interview-1', 'user-1', 'New Title');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New Title' }),
    );
  });

  it('throws 404 when the interview does not exist', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(null);

    await expect(
      updateInterviewTitle('interview-missing', 'user-1', 'Title'),
    ).rejects.toMatchObject({ message: 'Interview not found' });
  });

  it('throws 403 when a non-author tries to rename', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);

    await expect(
      updateInterviewTitle('interview-1', 'user-other', 'Hijacked Title'),
    ).rejects.toMatchObject({ message: 'Only the author can rename the interview' });
  });
});

// ── updateInterviewPhaseAssignments ───────────────────────────────────────────

describe('updateInterviewPhaseAssignments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNotification.mockResolvedValue({ id: 'notif-1' });
  });

  it('updates only the supplied phase assignments', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      discoveryAssigneeId: null,
      deliveryAssigneeId: null,
      technicalAssigneeId: null,
    });
    mockGetActiveUsers.mockResolvedValue([
      { oid: 'discovery-1', displayName: 'Discovery User' },
      { oid: 'technical-1', displayName: 'Technical User' },
    ]);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewPhaseAssignments('interview-1', 'user-1', {
      discoveryAssigneeId: 'discovery-1',
      technicalAssigneeId: 'technical-1',
    });

    expect(setMock).toHaveBeenCalledWith({
      discoveryAssigneeId: 'discovery-1',
      technicalAssigneeId: 'technical-1',
      updatedAt: expect.any(String),
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('does not clear an existing phase when another phase is assigned', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      discoveryAssigneeId: 'discovery-1',
      deliveryAssigneeId: null,
      technicalAssigneeId: null,
    });
    mockGetActiveUsers.mockResolvedValue([
      { oid: 'delivery-1', displayName: 'Delivery User' },
    ]);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewPhaseAssignments('interview-1', 'user-1', {
      deliveryAssigneeId: 'delivery-1',
    });

    expect(setMock).toHaveBeenCalledWith({
      deliveryAssigneeId: 'delivery-1',
      updatedAt: expect.any(String),
    });
  });

  it('leaves unspecified phase assignees unchanged', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      discoveryAssigneeId: 'discovery-1',
      deliveryAssigneeId: 'delivery-1',
      technicalAssigneeId: null,
    });
    mockGetActiveUsers.mockResolvedValue([
      { oid: 'technical-1', displayName: 'Technical User' },
    ]);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewPhaseAssignments('interview-1', 'user-1', {
      technicalAssigneeId: 'technical-1',
    });

    expect(setMock).toHaveBeenCalledWith({
      technicalAssigneeId: 'technical-1',
      updatedAt: expect.any(String),
    });
  });

  it('clears a phase when the client sends null without touching the others', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      discoveryAssigneeId: 'discovery-1',
      deliveryAssigneeId: 'delivery-1',
      technicalAssigneeId: 'technical-1',
    });
    mockGetActiveUsers.mockResolvedValue([]);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewPhaseAssignments('interview-1', 'user-1', {
      discoveryAssigneeId: null,
    });

    expect(setMock).toHaveBeenCalledWith({
      discoveryAssigneeId: null,
      updatedAt: expect.any(String),
    });
  });

  it('rejects a user who is not active in the interview project', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    mockGetActiveUsers.mockResolvedValue([]);

    await expect(updateInterviewPhaseAssignments('interview-1', 'user-1', {
      deliveryAssigneeId: 'outside-project',
    })).rejects.toMatchObject({
      message: 'Phase assignees must be active users in this project',
    });
  });

  it('does not let a section owner assign phases', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    mockIsPlatformAdmin.mockResolvedValue(false);
    mockIsProjectAdmin.mockResolvedValue(false);

    await expect(updateInterviewPhaseAssignments('interview-1', 'owner-prd', {
      discoveryAssigneeId: 'owner-prd',
    })).rejects.toMatchObject({
      status: 403,
      message: 'Only the interview owner, a project admin, or a platform admin can assign phases',
    });
  });
});

// ── deleteInterview ────────────────────────────────────────────────────────────

describe('deleteInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the interview when the requesting user is the author', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteInterview('interview-1', 'user-1');

    const { cancelRun } = jest.requireMock('../services/chatAgentService') as { cancelRun: jest.Mock };
    expect(cancelRun).toHaveBeenCalledWith(interviewRow.chatThreadId);
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('throws 404 when the interview does not exist', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(null);

    await expect(deleteInterview('interview-missing', 'user-1')).rejects.toMatchObject({
      message: 'Interview not found',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('throws 403 when a non-author tries to delete', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);

    await expect(deleteInterview('interview-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can delete the interview',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('throws 409 and keeps the interview when a build uses it', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    mockDb.query.buildRuns.findFirst.mockResolvedValueOnce({ id: 'build-1' });

    await expect(deleteInterview('interview-1', 'user-1')).rejects.toMatchObject({
      status: 409,
      message: 'This interview belongs to a build. Cancel the build instead.',
    });
    const { cancelRun } = jest.requireMock('../services/chatAgentService') as { cancelRun: jest.Mock };
    expect(cancelRun).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});
