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
  updateInterviewTitle,
  deleteInterview,
} from '../services/interviewService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const { createNotification: mockCreateNotification } = jest.requireMock('../services/notificationService') as {
  createNotification: jest.Mock;
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

const interviewRow = {
  id: 'interview-1',
  chatThreadId: 'thread-1',
  authorId: 'user-1',
  title: 'My Interview',
  project: 'proj-alpha',
  repo: 'org/repo-alpha',
  status: 'in_progress',
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

  it('maps prdOwnerName and designDocOwnerName from joined owner relations', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      prds: [],
      prdOwnerId: 'user-prd',
      prdOwner: { displayName: 'Alice PRD Owner' },
      designDocOwnerId: 'user-dd',
      designDocOwner: { displayName: 'Bob DD Owner' },
    });

    const result = await getInterview('interview-1');

    expect(result).not.toBeNull();
    expect(result!.prdOwnerId).toBe('user-prd');
    expect(result!.prdOwnerName).toBe('Alice PRD Owner');
    expect(result!.designDocOwnerId).toBe('user-dd');
    expect(result!.designDocOwnerName).toBe('Bob DD Owner');
  });

  it('returns undefined for owner name fields when owners are not set', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...interviewRow,
      prds: [],
      prdOwnerId: null,
      prdOwner: null,
      designDocOwnerId: null,
      designDocOwner: null,
    });

    const result = await getInterview('interview-1');

    expect(result!.prdOwnerId).toBeUndefined();
    expect(result!.prdOwnerName).toBeUndefined();
    expect(result!.designDocOwnerId).toBeUndefined();
    expect(result!.designDocOwnerName).toBeUndefined();
  });
});

// ── updateInterviewStatus ──────────────────────────────────────────────────────

describe('updateInterviewStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates status when the requesting user is the author', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateInterviewStatus('interview-1', 'user-1', 'complete');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete' }),
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

  it('throws 403 when a non-author tries to update status', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);

    await expect(
      updateInterviewStatus('interview-1', 'user-other', 'complete'),
    ).rejects.toMatchObject({ message: 'Only the author can change interview status' });
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

// ── deleteInterview ────────────────────────────────────────────────────────────

describe('deleteInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the interview when the requesting user is the author', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue(interviewRow);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteInterview('interview-1', 'user-1');

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
});
