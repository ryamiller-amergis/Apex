/**
 * Tests for POST /api/interviews/design-docs/:id/assistant-thread
 *
 * Covers:
 * - Returning an existing thread ID without creating a new one
 * - Refreshing kickoff-context.md with the latest DB content on every call
 * - Graceful handling when the workspace directory has been cleaned up
 * - Creating a new thread (and writing kickoff context) when none exists yet
 * - 404 when the design doc is not found
 */

import request from 'supertest';
import express from 'express';
import fs from 'fs';
import interviewRouter from '../routes/interviews';
import * as designDocService from '../services/designDocService';
import * as prdService from '../services/prdService';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../services/interviewService');
jest.mock('../services/prdService');
jest.mock('../services/designDocService');

jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  createThread: jest.fn(),
  getThreadAsync: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('global-model'),
  getAppSetting: jest.fn().mockResolvedValue(null),
  setAppSetting: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-test'),
}));

// Direct DB call in the route — mock the Drizzle instance.
jest.mock('../db/drizzle', () => {
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  });
  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });
  return {
    db: {
      select: jest.fn().mockImplementation(makeSelectChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
    },
  };
});

// ── Typed mock references ─────────────────────────────────────────────────────

const { getDesignDoc: mockGetDesignDoc } = jest.requireMock('../services/designDocService') as {
  getDesignDoc: jest.Mock;
};

const { getPrd: mockGetPrd } = jest.requireMock('../services/prdService') as {
  getPrd: jest.Mock;
};

const { createThread: mockCreateThread } = jest.requireMock('../services/chatAgentService') as {
  createThread: jest.Mock;
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/interviews', interviewRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
  });
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseDoc = {
  id: 'doc-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  chatThreadId: 'thread-gen-1',
  qaChatThreadId: null,
  docAssistantThreadId: null as string | null,
  status: 'draft',
  authorId: 'user-test',
  designContent: '# Design\nContent here.',
  techSpecContent: '# Tech Spec\nContent here.',
  assumptionsContent: '# Assumptions\nContent here.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/interviews/design-docs/:id/assistant-thread — existing thread', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('returns the existing threadId without creating a new thread', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: 'thread-existing' };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: '/tmp/workspace' }]),
    }));

    const res = await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-existing' });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('writes kickoff-context.md with the latest doc content from DB', async () => {
    const doc = {
      ...baseDoc,
      docAssistantThreadId: 'thread-existing',
      designContent: '# Updated Design',
      techSpecContent: '# Updated Tech Spec',
      assumptionsContent: '# Updated Assumptions',
    };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue({ id: 'prd-1', content: '# PRD content' });
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: '/workspace/dir' }]),
    }));

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeSpy.mock.calls[0] as [string, string, string];
    expect(filePath).toContain('.ai-pilot');
    expect(filePath).toContain('kickoff-context.md');
    expect(content).toContain('thread-existing');
    expect(content).toContain('doc-1');
    expect(content).toContain('# Updated Design');
    expect(content).toContain('# Updated Tech Spec');
    expect(content).toContain('# Updated Assumptions');
    expect(content).toContain('# PRD content');
  });

  it('includes the doc_id and thread_id header in the refreshed context', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: 'thread-abc' };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: '/workspace' }]),
    }));

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    const [, content] = writeSpy.mock.calls[0] as [string, string, string];
    expect(content).toContain('doc_id: doc-1');
    expect(content).toContain('thread_id: thread-abc');
  });

  it('skips the file write when the thread has no workspaceDir', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: 'thread-existing' };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: null }]),
    }));

    const res = await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-existing' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('skips the file write when the DB row for the thread is not found', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: 'thread-orphan' };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);
    // No row returned — thread was deleted from DB
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    }));

    const res = await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-orphan' });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('returns 200 even when writeFileSync throws (workspace cleaned up)', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: 'thread-existing' };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);
    mockDb.select.mockImplementation(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([{ workspaceDir: '/gone/workspace' }]),
    }));
    writeSpy.mockImplementation(() => { throw new Error('ENOENT: no such file or directory'); });

    const res = await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-existing' });
  });
});

describe('POST /api/interviews/design-docs/:id/assistant-thread — new thread creation', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    mockCreateThread.mockResolvedValue({ id: 'thread-new', workspaceDir: '/workspace/new' });
    mockDb.update.mockImplementation(() => ({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('creates a new thread and returns its ID', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: null };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threadId: 'thread-new' });
    expect(mockCreateThread).toHaveBeenCalledTimes(1);
  });

  it('writes kickoff-context.md with the real thread ID (not the placeholder)', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: null };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [filePath, content] = writeSpy.mock.calls[0] as [string, string, string];
    expect(filePath).toContain('kickoff-context.md');
    expect(content).not.toContain('__THREAD_ID__');
    expect(content).toContain('thread-new');
  });

  it('passes skipAutoKickoff: true to createThread', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: null };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-test',
      expect.any(Object),
      { skipAutoKickoff: true },
    );
  });

  it('persists docAssistantThreadId on the design doc row', async () => {
    const doc = { ...baseDoc, docAssistantThreadId: null };
    mockGetDesignDoc.mockResolvedValue(doc);
    mockGetPrd.mockResolvedValue(null);
    const mockSet = jest.fn().mockReturnThis();
    const mockWhere = jest.fn().mockResolvedValue(undefined);
    mockDb.update.mockReturnValue({ set: mockSet, where: mockWhere });

    await request(buildApp()).post('/api/interviews/design-docs/doc-1/assistant-thread');

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ docAssistantThreadId: 'thread-new' }),
    );
  });
});

describe('POST /api/interviews/design-docs/:id/assistant-thread — error cases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when the design doc does not exist', async () => {
    mockGetDesignDoc.mockResolvedValue(null);

    const res = await request(buildApp()).post('/api/interviews/design-docs/missing/assistant-thread');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Design doc not found' });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });
});
