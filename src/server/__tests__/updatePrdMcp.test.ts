/**
 * Unit tests for the update_prd MCP tool handler.
 *
 * Tests handleUpdatePrd exported from src/server/mcp/ado/server.ts.
 */

// ── Teams bot mock ────────────────────────────────────────────────────────────

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
  handleIncoming: jest.fn().mockResolvedValue(undefined),
}));

// ── DB mock ──────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });
  return {
    db: {
      update: jest.fn().mockImplementation(makeUpdateChain),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  getThread: jest.fn(),
}));

jest.mock('../services/adrService', () => ({
  stageAdrProposedContent: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { handleUpdateAdr, handleUpdatePrd } from '../mcp/ado/server';

const { getThread: mockGetThread } = jest.requireMock('../services/chatAgentService') as { getThread: jest.Mock };
const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { stageAdrProposedContent: mockStageAdrProposedContent } = jest.requireMock('../services/adrService') as {
  stageAdrProposedContent: jest.Mock;
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleUpdatePrd', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));
  });

  it('returns error when thread not found', async () => {
    mockGetThread.mockResolvedValue(null);

    const result = await handleUpdatePrd({
      threadId: 'no-thread',
      prdId: 'prd-1',
      section: 'content',
      content: '# New content',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toMatch(/thread not found/i);
  });

  it('updates proposedContent when section is "content"', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1' });

    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const result = await handleUpdatePrd({
      threadId: 'thread-1',
      prdId: 'prd-1',
      section: 'content',
      content: '# Proposed content',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, section: 'content' });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ proposedContent: '# Proposed content' }),
    );
  });

  it('updates proposedBacklogJson when section is "backlog"', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1' });

    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    const backlogObj = { epics: [{ title: 'Epic 1' }] };
    const result = await handleUpdatePrd({
      threadId: 'thread-1',
      prdId: 'prd-1',
      section: 'backlog',
      content: JSON.stringify(backlogObj),
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, section: 'backlog' });
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ proposedBacklogJson: backlogObj }),
    );
  });

  it('returns { ok: true, section } on success', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1' });

    const result = await handleUpdatePrd({
      threadId: 'thread-1',
      prdId: 'prd-1',
      section: 'content',
      content: '# Updated',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.section).toBe('content');
  });
});

describe('handleUpdateAdr', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStageAdrProposedContent.mockResolvedValue(undefined);
  });

  it('rejects an unknown assistant thread', async () => {
    mockGetThread.mockResolvedValue(null);
    const result = await handleUpdateAdr({
      threadId: 'missing',
      adrId: 'adr-1',
      content: '# Revised ADR',
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Thread not found' });
    expect(mockStageAdrProposedContent).not.toHaveBeenCalled();
  });

  it('stages content through the ADR service using the thread owner', async () => {
    mockGetThread.mockResolvedValue({ id: 'thread-1', userId: 'author-1' });
    const result = await handleUpdateAdr({
      threadId: 'thread-1',
      adrId: 'adr-1',
      content: '# Revised ADR',
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
    expect(mockStageAdrProposedContent).toHaveBeenCalledWith(
      'adr-1',
      'author-1',
      'thread-1',
      '# Revised ADR',
    );
  });
});
