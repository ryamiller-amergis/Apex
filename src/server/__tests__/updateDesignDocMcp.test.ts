/**
 * Unit tests for the update_design_doc MCP tool handler.
 */

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn().mockResolvedValue(undefined),
  handleIncoming: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../db/drizzle', () => ({
  db: {
    update: jest.fn(),
    query: { prds: { findFirst: jest.fn() } },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  getThread: jest.fn(),
}));

jest.mock('../services/adrService', () => ({
  stageAdrProposedContent: jest.fn(),
}));

jest.mock('../services/designDocService', () => ({
  getDesignDoc: jest.fn(),
  syncDesignDocContent: jest.fn(),
  stageDesignDocProposedContent: jest.fn(),
  updateDesignDocContent: jest.fn(),
}));

jest.mock('../services/prdService', () => ({
  resolvePrdCommentWithApply: jest.fn(),
}));

jest.mock('../services/testCaseService', () => ({
  addTestCaseToPrd: jest.fn(),
}));

import { getThread } from '../services/chatAgentService';
import {
  getDesignDoc,
  stageDesignDocProposedContent,
  syncDesignDocContent,
} from '../services/designDocService';
import { handleUpdateDesignDoc } from '../mcp/ado/server';

const mockGetThread = getThread as jest.Mock;
const mockGetDesignDoc = getDesignDoc as jest.Mock;
const mockStage = stageDesignDocProposedContent as jest.Mock;
const mockSync = syncDesignDocContent as jest.Mock;

describe('handleUpdateDesignDoc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stages proposed design content for the normal assistant thread', async () => {
    mockGetThread.mockResolvedValue({ id: 'assistant-1', userId: 'user-1' });
    mockGetDesignDoc.mockResolvedValue({
      id: 'doc-1',
      fixBaseline: null,
    });
    mockStage.mockResolvedValue(undefined);

    const result = await handleUpdateDesignDoc({
      threadId: 'assistant-1',
      docId: 'doc-1',
      section: 'design',
      content: '# Revised design',
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      section: 'design',
      fixMode: false,
    });
    expect(mockStage).toHaveBeenCalledWith('doc-1', 'user-1', {
      designContent: '# Revised design',
    });
    expect(mockSync).not.toHaveBeenCalled();
  });

  it('writes live content when called from the active fix-validation thread', async () => {
    mockGetThread.mockResolvedValue({ id: 'fix-thread', userId: 'user-1' });
    mockGetDesignDoc.mockResolvedValue({
      id: 'doc-1',
      fixBaseline: {
        design: 'old',
        techSpec: 'old',
        assumptions: 'old',
        capturedAt: '2026-01-01T00:00:00Z',
        fixThreadId: 'fix-thread',
      },
    });
    mockSync.mockResolvedValue(undefined);

    const result = await handleUpdateDesignDoc({
      threadId: 'fix-thread',
      docId: 'doc-1',
      section: 'tech-spec',
      content: '# Fixed tech',
    });

    expect(JSON.parse(result.content[0].text)).toEqual({
      ok: true,
      section: 'tech-spec',
      fixMode: true,
    });
    expect(mockSync).toHaveBeenCalledWith('doc-1', { techSpecContent: '# Fixed tech' });
    expect(mockStage).not.toHaveBeenCalled();
  });

  it('stages proposed content when fixBaseline exists but thread is the normal assistant', async () => {
    mockGetThread.mockResolvedValue({ id: 'assistant-1', userId: 'user-1' });
    mockGetDesignDoc.mockResolvedValue({
      id: 'doc-1',
      fixBaseline: {
        design: 'old',
        techSpec: 'old',
        assumptions: 'old',
        capturedAt: '2026-01-01T00:00:00Z',
        fixThreadId: 'fix-thread',
      },
    });
    mockStage.mockResolvedValue(undefined);

    const result = await handleUpdateDesignDoc({
      threadId: 'assistant-1',
      docId: 'doc-1',
      section: 'assumptions',
      content: '# Proposed assumptions',
    });

    expect(JSON.parse(result.content[0].text).fixMode).toBe(false);
    expect(mockStage).toHaveBeenCalledWith('doc-1', 'user-1', {
      assumptionsContent: '# Proposed assumptions',
    });
  });
});
