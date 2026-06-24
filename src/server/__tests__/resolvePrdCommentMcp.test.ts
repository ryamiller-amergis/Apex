/**
 * Unit tests for the resolve_prd_comment MCP tool handler.
 *
 * Tests handleResolvePrdComment exported from src/server/mcp/ado/server.ts.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../services/chatAgentService', () => ({
  getThread: jest.fn(),
}));

jest.mock('../services/prdService', () => ({
  resolvePrdCommentWithApply: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { handleResolvePrdComment } from '../mcp/ado/server';

const { getThread: mockGetThread } = jest.requireMock('../services/chatAgentService') as { getThread: jest.Mock };
const { resolvePrdCommentWithApply: mockResolvePrdCommentWithApply } = jest.requireMock('../services/prdService') as {
  resolvePrdCommentWithApply: jest.Mock;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleResolvePrdComment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns error when thread not found', async () => {
    mockGetThread.mockResolvedValue(null);

    const result = await handleResolvePrdComment({
      threadId: 'no-thread',
      commentId: 'comment-1',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/thread not found/i);
  });

  it('calls resolvePrdCommentWithApply with commentId and userId from thread', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1' });
    mockResolvePrdCommentWithApply.mockResolvedValue(undefined);

    await handleResolvePrdComment({ threadId: 'thread-1', commentId: 'comment-abc' });

    expect(mockResolvePrdCommentWithApply).toHaveBeenCalledWith('comment-abc', 'user-1');
  });

  it('returns { ok: true, commentId } on success', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1' });
    mockResolvePrdCommentWithApply.mockResolvedValue(undefined);

    const result = await handleResolvePrdComment({ threadId: 'thread-1', commentId: 'comment-xyz' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, commentId: 'comment-xyz' });
  });

  it('returns error message when resolvePrdCommentWithApply throws', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1' });
    mockResolvePrdCommentWithApply.mockRejectedValue(new Error('Comment not found'));

    const result = await handleResolvePrdComment({ threadId: 'thread-1', commentId: 'bad-comment' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/comment not found/i);
  });
});
