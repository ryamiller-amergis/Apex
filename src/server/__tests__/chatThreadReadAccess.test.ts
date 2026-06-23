/**
 * Integration-style tests for document-scoped read access on /api/chat/threads/:id.
 */

import request from 'supertest';
import express from 'express';
import type { ChatThread } from '../../shared/types/chat';

let mockPermissionGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (mockPermissionGranted) next();
      else res.status(403).json({ error: 'Forbidden', missing: _keys });
    },
  requireAnyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  attachPermissions: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThread: jest.fn(),
  getThreadAsync: jest.fn(),
  listThreadSummaries: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  subscribeToThread: jest.fn().mockReturnValue(() => {}),
  cancelRun: jest.fn(),
  closeThread: jest.fn(),
  readOutputPrd: jest.fn().mockReturnValue(null),
  writeOutputPrd: jest.fn(),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  isPrdReady: jest.fn().mockReturnValue(false),
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
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'viewer-1' } };
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
