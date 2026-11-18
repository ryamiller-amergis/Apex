const mockSelectResults: unknown[][] = [];
const mockReturning = jest.fn();
const mockOnConflictDoUpdate = jest.fn((_config: unknown) => ({ returning: mockReturning }));
const mockValues = jest.fn((_values: unknown) => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockDeleteWhere = jest.fn(async (_where: unknown) => undefined);

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const result = Promise.resolve(mockSelectResults.shift() ?? []);
          return Object.assign(result, { limit: () => result });
        },
      }),
    }),
    insert: () => ({ values: mockValues }),
    delete: () => ({ where: mockDeleteWhere }),
  },
}));

import {
  WorkflowMessageFeedbackError,
  listMyMessageFeedback,
  parsePutBody,
  putMessageFeedback,
} from '../services/workflowMessageFeedbackService';

const interviewId = '22222222-2222-4222-8222-222222222222';
const threadId = '44444444-4444-4444-8444-444444444444';
const messageId = '33333333-3333-4333-8333-333333333333';

const openInterview = { project: 'proj-a', threadId, status: 'in_progress' };
const agentMessage = { threadId, role: 'agent' };
const thumbsUp = { surface: 'interview' as const, subjectId: interviewId, rating: 'up' as const, comment: null };

async function expectError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toBeInstanceOf(WorkflowMessageFeedbackError);
  await promise.catch((err: WorkflowMessageFeedbackError) => {
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectResults.length = 0;
});

describe('putMessageFeedback', () => {
  it('saves the rating, replacing any earlier one from the same user', async () => {
    mockSelectResults.push([openInterview], [agentMessage]);
    mockReturning.mockResolvedValue([{
      messageId, rating: 'up', comment: null, updatedAt: '2026-10-22T12:00:00.000Z',
    }]);
    const result = await putMessageFeedback('proj-a', 'user-1', messageId, thumbsUp);
    expect(result.entry).toEqual({ messageId, rating: 'up', comment: null, updatedAt: '2026-10-22T12:00:00.000Z' });
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      project: 'proj-a', surface: 'interview', subjectId: interviewId, messageId, userId: 'user-1', rating: 'up',
    }));
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ rating: 'up', comment: null }),
    }));
  });

  it('deletes the rating when rating is null', async () => {
    mockSelectResults.push([openInterview], [agentMessage]);
    const result = await putMessageFeedback('proj-a', 'user-1', messageId, { ...thumbsUp, rating: null });
    expect(result.entry).toBeNull();
    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockValues).not.toHaveBeenCalled();
  });

  it('treats an interview in another project as not found', async () => {
    mockSelectResults.push([{ ...openInterview, project: 'proj-b' }]);
    await expectError(putMessageFeedback('proj-a', 'user-1', messageId, thumbsUp), 404, 'SUBJECT_NOT_FOUND');
  });

  it('closes ratings once the interview is no longer in progress', async () => {
    mockSelectResults.push([{ ...openInterview, status: 'complete' }]);
    await expectError(putMessageFeedback('proj-a', 'user-1', messageId, thumbsUp), 409, 'SUBJECT_CLOSED');
  });

  it('rejects a message from another thread and a user message', async () => {
    mockSelectResults.push([openInterview], [{ threadId: 'other', role: 'agent' }]);
    await expectError(putMessageFeedback('proj-a', 'user-1', messageId, thumbsUp), 404, 'MESSAGE_NOT_FOUND');
    mockSelectResults.push([openInterview], [{ threadId, role: 'user' }]);
    await expectError(putMessageFeedback('proj-a', 'user-1', messageId, thumbsUp), 422, 'NOT_AGENT_MESSAGE');
  });

  describe('home chat', () => {
    const ownedThread = { userId: 'user-1', kickoff: { project: 'proj-a' } };
    const bad = { surface: 'chat' as const, subjectId: threadId, rating: 'bad' as const, comment: 'Missed the point' };

    it('saves the owner’s rating with its comment', async () => {
      mockSelectResults.push([ownedThread], [agentMessage]);
      mockReturning.mockResolvedValue([{
        messageId, rating: 'bad', comment: 'Missed the point', updatedAt: '2026-10-22T12:00:00.000Z',
      }]);
      const result = await putMessageFeedback('proj-a', 'user-1', messageId, bad);
      expect(result.entry?.rating).toBe('bad');
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'chat', subjectId: threadId, rating: 'bad', comment: 'Missed the point',
      }));
    });

    it('treats someone else’s chat, or a chat in another project, as not found', async () => {
      mockSelectResults.push([{ ...ownedThread, userId: 'user-2' }]);
      await expectError(putMessageFeedback('proj-a', 'user-1', messageId, bad), 404, 'SUBJECT_NOT_FOUND');
      mockSelectResults.push([{ ...ownedThread, kickoff: { project: 'proj-b' } }]);
      await expectError(putMessageFeedback('proj-a', 'user-1', messageId, bad), 404, 'SUBJECT_NOT_FOUND');
    });
  });
});

describe('parsePutBody', () => {
  const chat = { surface: 'chat', subjectId: interviewId };

  it('requires a comment for Bad and Needs improvement, but not for Good', () => {
    for (const rating of ['bad', 'needs_improvement']) {
      expect(() => parsePutBody({ ...chat, rating, comment: '   ' })).toThrow('Say what the agent could do better.');
    }
    expect(parsePutBody({ ...chat, rating: 'good' })).toEqual({ ...chat, rating: 'good', comment: null });
  });

  it('trims the comment, caps its length, and drops it when clearing', () => {
    expect(parsePutBody({ ...chat, rating: 'bad', comment: '  too long  ' }).comment).toBe('too long');
    expect(() => parsePutBody({ ...chat, rating: 'bad', comment: 'x'.repeat(2001) })).toThrow(/under 2000/);
    expect(parsePutBody({ ...chat, rating: null, comment: 'ignored' }).comment).toBeNull();
  });

  it('rejects thumbs on a chat and chat ratings on an interview', () => {
    expect(() => parsePutBody({ ...chat, rating: 'up' })).toThrow('rating is invalid for this surface');
    expect(() => parsePutBody({ surface: 'interview', subjectId: interviewId, rating: 'good' }))
      .toThrow('rating is invalid for this surface');
  });
});

describe('listMyMessageFeedback', () => {
  it('returns the caller’s entries for the interview', async () => {
    mockSelectResults.push([openInterview], [
      { messageId, rating: 'down', comment: null, updatedAt: '2026-10-22T12:00:00.000Z' },
    ]);
    const result = await listMyMessageFeedback('proj-a', 'user-1', 'interview', interviewId);
    expect(result).toEqual({
      surface: 'interview',
      subjectId: interviewId,
      entries: [{ messageId, rating: 'down', comment: null, updatedAt: '2026-10-22T12:00:00.000Z' }],
    });
  });
});
