/**
 * Integration-style tests for document-scoped read access on /api/chat/threads/:id.
 */

import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ChatThread } from '../../shared/types/chat';

let mockPermissionGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (mockPermissionGranted) next();
      else res.status(403).json({ error: 'Forbidden', missing: _keys });
    },
  requireAnyPermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  attachPermissions: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThread: jest.fn(),
  getThreadAsync: jest.fn(),
  listThreadSummaries: jest.fn().mockResolvedValue([]),
  searchThreadSummaries: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  subscribeToThread: jest.fn().mockReturnValue(() => {}),
  cancelRun: jest.fn(),
  closeThread: jest.fn(),
  recoverStaleRunningThread: jest.fn().mockResolvedValue('idle'),
  permanentlyDeleteThread: jest.fn(),
  readOutputPrd: jest.fn().mockReturnValue(null),
  writeOutputPrd: jest.fn(),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  isPrdReady: jest.fn().mockReturnValue(false),
  isRepositoryReadingChatCaller: jest.fn().mockReturnValue(false),
  resolveGroundingCallerKey: jest.fn().mockReturnValue('agent-home'),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
  isProjectRepositoryCheckoutReadinessEnabled: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/projectRepositoryReadinessService', () => ({
  assertResolvedProjectRepositoryReady: jest.fn().mockResolvedValue({
    skillSettingsId: 'cfg-1',
    status: 'ready',
    sha: 'abc',
    error: null,
    startedAt: null,
    completedAt: null,
    filesystemReady: true,
  }),
  ProjectRepositoryNotReady: class ProjectRepositoryNotReady extends Error {
    readonly code = 'PROJECT_REPOSITORY_NOT_READY';
    readonly httpStatus = 409;
    readonly readinessStatus: string;
    constructor(readiness: { status: string }) {
      super('A project administrator must clone this repository before repository-dependent AI work can run.');
      this.name = 'ProjectRepositoryNotReady';
      this.readinessStatus = readiness.status;
    }
    toJSON() {
      return {
        code: 'PROJECT_REPOSITORY_NOT_READY',
        message: this.message,
        status: this.readinessStatus,
      };
    }
  },
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

jest.mock('../services/wikiCatalog', () => ({
  saveWikiPage: jest.fn(),
}));

jest.mock('../services/chatThreadRepository', () => ({
  toggleFlag: jest.fn(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('viewer-1'),
}));

const mockResolveThreadAccess = jest.fn();
const mockCanWriteThread = jest.fn();

jest.mock('../services/threadAccessService', () => ({
  resolveThreadAccess: (...args: unknown[]) => mockResolveThreadAccess(...args),
  canWriteThread: (...args: unknown[]) => mockCanWriteThread(...args),
}));

import chatRouter from '../routes/chat';
import { sendMessage } from '../services/chatAgentService';

const mockSendMessage = sendMessage as jest.Mock;

const readThread: ChatThread = {
  id: 'thread-iv-1',
  userId: 'author-1',
  status: 'idle',
  kickoff: { project: 'p', repo: 'r' },
  workspaceDir: '/tmp',
  flagged: false,
  messages: [{ id: 'm1', role: 'user', text: 'Hello', ts: '2026-01-01T00:00:00Z' }],
  createdAt: '2026-01-01T00:00:00Z',
  lastActivityAt: '2026-01-01T00:00:00Z',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { profile: { oid: string } } }).user = {
      profile: { oid: 'viewer-1' },
    };
    next();
  });
  app.use('/api/chat', chatRouter);
  return app;
}

describe('GET /api/chat/threads/:id — document-scoped read', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
    mockResolveThreadAccess.mockResolvedValue({ access: 'read', thread: readThread });
    mockCanWriteThread.mockResolvedValue(false);
  });

  it('returns 200 with messages for a non-owner with read access', async () => {
    const res = await request(buildApp()).get('/api/chat/threads/thread-iv-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('thread-iv-1');
    expect(res.body.messages).toHaveLength(1);
    expect(mockResolveThreadAccess).toHaveBeenCalledWith('viewer-1', 'thread-iv-1');
  });

  it('returns 404 when resolveThreadAccess returns null', async () => {
    mockResolveThreadAccess.mockResolvedValue(null);

    const res = await request(buildApp()).get('/api/chat/threads/thread-secret');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Thread not found' });
  });
});

describe('POST /api/chat/threads/:id/messages — write gate', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
    mockResolveThreadAccess.mockResolvedValue({ access: 'read', thread: readThread });
    mockCanWriteThread.mockResolvedValue(false);
  });

  it('returns 404 when the user has read but not write access', async () => {
    const res = await request(buildApp())
      .post('/api/chat/threads/thread-iv-1/messages')
      .send({ text: 'hello' });

    expect(res.status).toBe(404);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('accepts messages when canWriteThread is true', async () => {
    mockCanWriteThread.mockResolvedValue(true);
    mockResolveThreadAccess.mockResolvedValue({ access: 'owner', thread: readThread });

    const res = await request(buildApp())
      .post('/api/chat/threads/thread-iv-1/messages')
      .send({ text: 'hello' });

    expect(res.status).toBe(202);
    expect(mockSendMessage).toHaveBeenCalled();
  });
});
