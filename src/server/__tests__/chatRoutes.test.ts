/**
 * Integration-style tests for the /api/chat routes.
 *
 * - All service dependencies are mocked so no real DB or agent runner is used.
 * - The RBAC middleware is mocked with a controllable pass/block flag so each
 *   test suite can verify both the happy path and the 403 gate.
 */
import request from 'supertest';
import express from 'express';

// ── Controllable permission flag ───────────────────────────────────────────────
// Must start with 'mock' so Jest's hoist transform allows the factory to
// reference it before the let declaration executes.
let mockPermissionGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (..._keys: string[]) =>
    (_req: any, res: any, next: any) => {
      if (mockPermissionGranted) {
        next();
      } else {
        res.status(403).json({ error: 'Forbidden', missing: _keys });
      }
    },
  requireAnyPermission: (..._keys: string[]) =>
    (_req: any, _res: any, next: any) => next(),
  attachPermissions: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThread: jest.fn(),
  getThreadAsync: jest.fn(),
  listThreadSummaries: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn(),
  subscribeToThread: jest.fn().mockReturnValue(() => {}),
  cancelRun: jest.fn(),
  permanentlyDeleteThread: jest.fn(),
  readOutputPrd: jest.fn().mockReturnValue(null),
  writeOutputPrd: jest.fn(),
  readOutputBacklog: jest.fn().mockReturnValue(null),
}));

jest.mock('../services/wikiCatalog', () => ({
  saveWikiPage: jest.fn(),
}));

jest.mock('../services/chatThreadRepository', () => ({
  toggleFlag: jest.fn(),
}));

jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'worker-a',
  replayRunEvents: jest.fn().mockResolvedValue([]),
  subscribeRunEvents: jest.fn().mockReturnValue(() => {}),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn().mockReturnValue('user-1'),
}));

const mockResolveThreadAccess = jest.fn();
const mockCanWriteThread = jest.fn();

jest.mock('../services/threadAccessService', () => ({
  resolveThreadAccess: (...args: unknown[]) => mockResolveThreadAccess(...args),
  canWriteThread: (...args: unknown[]) => mockCanWriteThread(...args),
}));

import chatRouter, {
  buildRunStatusResponse,
  formatRunEventSse,
  shouldAssignRunEventSseId,
  shouldForwardPgRunEvent,
} from '../routes/chat';
import * as chatAgentService from '../services/chatAgentService';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';

const mockChatService = chatAgentService as jest.Mocked<typeof chatAgentService>;

// ── App factory ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { profile: { oid: 'user-1' } };
    next();
  });
  app.use('/api/chat', chatRouter);
  return app;
}

describe('chat run-event SSE transport', () => {
  const envelope = {
    eventId: 'event-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sourceInstance: 'worker-a',
    sequence: 1,
    timestamp: '2026-07-14T12:00:00.000Z',
    type: 'status',
    phase: 'implementation',
    status: 'running',
    detail: 'Implementing',
    event: { type: 'status', status: 'running' },
  } as AgentRunEventEnvelope;

  it('writes the durable event id as the SSE id', () => {
    expect(formatRunEventSse(envelope)).toBe(
      `id: event-1\ndata: ${JSON.stringify({
        ...envelope.event,
        runId: 'run-1',
        eventTimestamp: envelope.timestamp,
        semanticPhase: 'implementation',
        semanticStatus: 'running',
        semanticDetail: 'Implementing',
      })}\n\n`,
    );
  });

  it('suppresses the owner worker PostgreSQL echo', () => {
    expect(shouldForwardPgRunEvent(envelope, 'worker-a')).toBe(false);
    expect(shouldForwardPgRunEvent({ ...envelope, sourceInstance: 'worker-b' }, 'worker-a')).toBe(true);
  });

  it('assigns reconnect cursors only to persisted run events', () => {
    expect(shouldAssignRunEventSseId(envelope)).toBe(true);
    expect(shouldAssignRunEventSseId({
      ...envelope,
      type: 'token',
      event: { type: 'token', text: 'ephemeral' },
    })).toBe(false);
  });

  it('exposes watchdog health and persisted progress without using heartbeat as progress', () => {
    const now = Date.parse('2026-07-14T12:10:00.000Z');
    expect(buildRunStatusResponse({
      id: 'run-1',
      status: 'running',
      lastError: 'No meaningful progress for more than 2 minutes',
      createdAt: '2026-07-14T12:00:00.000Z',
      startedAt: '2026-07-14T12:00:00.000Z',
      heartbeatAt: '2026-07-14T12:09:59.000Z',
      progressAt: '2026-07-14T12:05:00.000Z',
      progressLabel: 'Running focused tests',
      progressPhase: 'testing',
      timeoutAt: '2026-07-14T14:00:00.000Z',
    }, now, {
      heartbeatTimeoutMs: 5 * 60_000,
      queuedTimeoutMs: 90_000,
      progressStaleMs: 2 * 60_000,
      longRunMs: 30 * 60_000,
      hardLimitMs: 2 * 60 * 60_000,
    })).toMatchObject({
      runId: 'run-1',
      health: 'progress_stale',
      progressAt: '2026-07-14T12:05:00.000Z',
      progressLabel: 'Running focused tests',
      progressPhase: 'testing',
      elapsedMs: 10 * 60_000,
    });
  });
});

// ── Permission gate: chat:view ─────────────────────────────────────────────────

describe('chat routes — chat:view permission gate', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
    mockChatService.listThreadSummaries.mockResolvedValue([]);
  });

  it('passes through to the handler when the user has chat:view', async () => {
    const res = await request(buildApp()).get('/api/chat/threads');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 403 when the user lacks chat:view', async () => {
    mockPermissionGranted = false;

    const res = await request(buildApp()).get('/api/chat/threads');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', missing: ['chat:view'] });
  });

  it('gates every sub-route — POST /threads also returns 403 without permission', async () => {
    mockPermissionGranted = false;

    const res = await request(buildApp())
      .post('/api/chat/threads')
      .send({ kickoff: { project: 'proj', repo: 'repo' } });

    expect(res.status).toBe(403);
  });
});

// ── Handler behaviour (with permission) ───────────────────────────────────────

describe('GET /api/chat/threads', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
  });

  it('returns 200 with an empty thread list', async () => {
    mockChatService.listThreadSummaries.mockResolvedValue([]);

    const res = await request(buildApp()).get('/api/chat/threads');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 500 when listThreadSummaries throws', async () => {
    mockChatService.listThreadSummaries.mockRejectedValue(new Error('DB error'));

    const res = await request(buildApp()).get('/api/chat/threads');

    expect(res.status).toBe(500);
  });
});

describe('GET /api/chat/threads — messagePreview for history labels', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
  });

  it('returns messagePreview so the client can render "PillLabel - description" labels', async () => {
    mockChatService.listThreadSummaries.mockResolvedValue([
      {
        id: 't1',
        userId: 'user-1',
        title: 'App Knowledge - what does auth look like',
        status: 'idle',
        kickoff: { project: 'P', repo: 'R', pillLabel: 'App Knowledge' },
        messagePreview: 'what does auth look like',
        flagged: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any);

    const res = await request(buildApp()).get('/api/chat/threads');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].messagePreview).toBe('what does auth look like');
    expect(res.body[0].kickoff.pillLabel).toBe('App Knowledge');
  });

  it('includes title fallback when messagePreview is absent', async () => {
    mockChatService.listThreadSummaries.mockResolvedValue([
      {
        id: 't2',
        userId: 'user-1',
        title: 'App Knowledge - describe the login flow',
        status: 'idle',
        kickoff: { project: 'P', repo: 'R', pillLabel: 'App Knowledge' },
        flagged: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
    ] as any);

    const res = await request(buildApp()).get('/api/chat/threads');

    expect(res.status).toBe(200);
    expect(res.body[0].title).toBe('App Knowledge - describe the login flow');
    expect(res.body[0].messagePreview).toBeUndefined();
  });
});

describe('GET /api/chat/threads — project filter', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
    mockChatService.listThreadSummaries.mockResolvedValue([]);
  });

  it('passes project query param to listThreadSummaries', async () => {
    await request(buildApp()).get('/api/chat/threads?project=MyProject');

    expect(mockChatService.listThreadSummaries).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ project: 'MyProject' }),
    );
  });

  it('does not pass project when query param is absent', async () => {
    await request(buildApp()).get('/api/chat/threads');

    expect(mockChatService.listThreadSummaries).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ project: undefined }),
    );
  });
});

describe('POST /api/chat/threads', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
  });

  it('returns 400 when kickoff.project is missing', async () => {
    const res = await request(buildApp())
      .post('/api/chat/threads')
      .send({ kickoff: { repo: 'repo' } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'kickoff.project is required' });
  });

  it('returns 400 when kickoff.repo is missing', async () => {
    const res = await request(buildApp())
      .post('/api/chat/threads')
      .send({ kickoff: { project: 'proj' } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'kickoff.repo is required' });
  });
});

describe('POST /api/chat/threads — happy path', () => {
  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
  });

  it('creates a thread and returns threadId', async () => {
    mockChatService.createThread.mockResolvedValue({
      id: 'new-thread-id',
      userId: 'user-1',
      kickoff: { project: 'MaxView', repo: 'MaxView', pillLabel: 'App Knowledge' },
      messages: [],
      status: 'idle',
      workspaceDir: '/tmp/ws',
      flagged: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    } as any);

    const kickoff = {
      project: 'MaxView',
      repo: 'MaxView',
      pillLabel: 'App Knowledge',
      skillPath: '/.cursor/skills/app-knowledge/SKILL.md',
    };

    const res = await request(buildApp())
      .post('/api/chat/threads')
      .send({ kickoff, skipAutoKickoff: true });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ threadId: 'new-thread-id' });
    expect(mockChatService.createThread).toHaveBeenCalledWith(
      'user-1',
      kickoff,
      { skipAutoKickoff: true },
    );
  });
});

describe('chat thread lifecycle', () => {
  const threadId = 'lifecycle-thread-id';
  const kickoff = {
    project: 'MaxView',
    repo: 'MaxView',
    pillLabel: 'App Knowledge',
    skillPath: '/.cursor/skills/app-knowledge/SKILL.md',
  };

  const createdThread = {
    id: threadId,
    userId: 'user-1',
    kickoff,
    messages: [],
    status: 'idle',
    workspaceDir: '/tmp/ws',
    flagged: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  };

  const listedSummary = {
    id: threadId,
    userId: 'user-1',
    title: 'App Knowledge - How does auth work?',
    status: 'idle',
    kickoff,
    messagePreview: 'How does auth work?',
    flagged: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    mockPermissionGranted = true;
    jest.clearAllMocks();
    mockResolveThreadAccess.mockResolvedValue({
      thread: createdThread,
      access: 'owner',
    });
    mockCanWriteThread.mockResolvedValue(true);
  });

  it('create -> list -> delete -> list empty', async () => {
    const app = buildApp();

    mockChatService.createThread.mockResolvedValue(createdThread as any);

    const createRes = await request(app)
      .post('/api/chat/threads')
      .send({ kickoff, skipAutoKickoff: true });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toEqual({ threadId });

    mockChatService.listThreadSummaries.mockResolvedValue([listedSummary] as any);

    const listRes = await request(app).get('/api/chat/threads?project=MaxView');

    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(threadId);
    expect(listRes.body[0].kickoff.pillLabel).toBe('App Knowledge');
    expect(listRes.body[0].messagePreview).toBe('How does auth work?');

    mockChatService.permanentlyDeleteThread.mockResolvedValue(undefined);

    const deleteRes = await request(app).delete(`/api/chat/threads/${threadId}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });
    expect(mockChatService.permanentlyDeleteThread).toHaveBeenCalledWith(threadId);

    mockChatService.listThreadSummaries.mockResolvedValue([]);

    const listAfterDeleteRes = await request(app).get('/api/chat/threads?project=MaxView');

    expect(listAfterDeleteRes.status).toBe(200);
    expect(listAfterDeleteRes.body).toEqual([]);
  });
});
