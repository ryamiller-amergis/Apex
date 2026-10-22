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

  it('does not accept chat ratings yet', async () => {
    await expectError(
      putMessageFeedback('proj-a', 'user-1', messageId, { surface: 'chat', subjectId: threadId, rating: 'good' }),
      422,
      'SURFACE_NOT_AVAILABLE',
    );
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
