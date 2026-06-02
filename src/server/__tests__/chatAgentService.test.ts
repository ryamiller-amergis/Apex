/**
 * Unit tests for thread-retention behavior in chatAgentService.
 * Verifies that closeThread never deletes the chat_threads row when
 * the thread is interview-backed or referenced by any document row
 * (PRD or design doc), guarding against cascade data loss.
 */

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn().mockReturnValue(''),
}));

jest.mock('@cursor/sdk', () => {
  class CursorAgentError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'CursorAgentError';
    }
  }
  return {
    Agent: { create: jest.fn(), resume: jest.fn() },
    CursorAgentError,
  };
});

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: jest.fn().mockResolvedValue(null) },
      prds: { findFirst: jest.fn().mockResolvedValue(null) },
      designDocs: { findFirst: jest.fn().mockResolvedValue(null) },
    },
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  and: jest.fn(),
  isNull: jest.fn(),
  or: jest.fn(),
}));

jest.mock('../db/schema', () => ({
  interviews: {},
  prds: {},
  designDocs: {},
  chatThreads: {},
}));

jest.mock('../services/chatThreadRepository', () => ({
  upsertThread: jest.fn().mockResolvedValue(undefined),
  insertMessage: jest.fn().mockResolvedValue(undefined),
  listThreadsByUser: jest.fn().mockResolvedValue([]),
  loadFullThread: jest.fn().mockResolvedValue(null),
  deleteThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/prdService', () => ({ syncPrdContent: jest.fn() }));

jest.mock('../services/designDocService', () => ({
  syncDesignDocContent: jest.fn(),
  syncValidationResult: jest.fn(),
  syncPerFeatureDesignDocs: jest.fn(),
}));

jest.mock('../services/telemetry', () => ({
  trackAgentError: jest.fn(),
  trackEvent: jest.fn(),
}));

jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => '/tmp/test-data',
  isAzureWwwroot: () => false,
}));

jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { createThread, closeThread, markAsInterviewThread } from '../services/chatAgentService';

const { deleteThread: mockPgDeleteThread } = jest.requireMock('../services/chatThreadRepository') as {
  deleteThread: jest.Mock;
};

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

// ── closeThread — thread retention ────────────────────────────────────────────

describe('closeThread — thread retention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockDb.query.prds.findFirst.mockResolvedValue(null);
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does not delete the chat_threads row when the thread is interview-backed', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );
    markAsInterviewThread(thread.id);

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('does not delete the chat_threads row when the thread backs a PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({ id: 'prd-1' });

    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('does not delete the chat_threads row when the thread backs a design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'dd-1' });

    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('deletes the chat_threads row for a standalone thread with no document backing', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    await closeThread(thread.id);

    expect(mockPgDeleteThread).toHaveBeenCalledWith(thread.id);
  });

  it('is a no-op for a thread ID that no longer exists in memory or DB', async () => {
    await closeThread('nonexistent-thread-id');

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });
});

// ── markAsInterviewThread ─────────────────────────────────────────────────────

describe('markAsInterviewThread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockDb.query.prds.findFirst.mockResolvedValue(null);
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('marks the thread so closeThread skips DB deletion', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    markAsInterviewThread(thread.id);
    await closeThread(thread.id);

    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('is idempotent — calling it twice does not throw', async () => {
    const thread = await createThread(
      'user-1',
      { project: 'proj', repo: 'org/repo', branch: 'main' },
      { skipAutoKickoff: true },
    );

    expect(() => {
      markAsInterviewThread(thread.id);
      markAsInterviewThread(thread.id);
    }).not.toThrow();

    await closeThread(thread.id);
    expect(mockPgDeleteThread).not.toHaveBeenCalled();
  });

  it('is a no-op for a thread ID not present in memory', () => {
    expect(() => markAsInterviewThread('ghost-thread')).not.toThrow();
  });
});
