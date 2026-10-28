/**
 * Build-intake branch of the chat routes (FEAT-005): flag gate, attachment
 * refusal, turn hook, and replay after a dropped stream.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';

jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAnyPermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  attachPermissions: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThread: jest.fn(),
  listThreadSummaries: jest.fn().mockResolvedValue([]),
  searchThreadSummaries: jest.fn().mockResolvedValue([]),
  sendMessage: jest.fn(),
  subscribeToThread: jest.fn().mockReturnValue(() => {}),
  cancelRun: jest.fn(),
  isExplicitAdoWriteIntent: jest.fn().mockReturnValue(false),
  skillRequiresAdoOperations: jest.fn().mockReturnValue(false),
  permanentlyDeleteThread: jest.fn(),
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  isPrdReady: jest.fn().mockReturnValue(false),
}));

jest.mock('../services/projectSettingsService', () => ({ resolveSkillConfig: jest.fn() }));
jest.mock('../services/chatThreadRepository', () => ({ toggleFlag: jest.fn() }));
jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'worker-a',
  replayRunEventPage: jest.fn().mockResolvedValue({ events: [], nextEventId: null, hasMore: false }),
  subscribeRunEvents: jest.fn().mockReturnValue(() => {}),
}));
jest.mock('../services/interactiveLiveBus', () => ({
  interactiveLiveBus: { subscribe: jest.fn().mockReturnValue(() => {}), publish: jest.fn(), isEnabled: jest.fn().mockReturnValue(false) },
}));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/menuSettingsService', () => ({ getMenuConfig: jest.fn() }));
jest.mock('../services/mcpServerReadService', () => ({ assertCallerCanUseMcpServer: jest.fn() }));
jest.mock('../services/rbacService', () => ({ getUserPermissions: jest.fn().mockResolvedValue(new Set()) }));
jest.mock('../services/durableInteractiveTurnService', () => ({
  DurableInteractiveTurnError: class extends Error {},
  durableInteractiveTurnService: { retry: jest.fn() },
}));
jest.mock('../utils/requestUser', () => ({ getUserId: jest.fn().mockReturnValue('requester-1') }));
jest.mock('../services/adoUserToken', () => ({ getAdoTokenForUser: jest.fn() }));
jest.mock('../services/chatAdoWriteAuth', () => ({ registerChatAdoWriteTurn: jest.fn() }));
jest.mock('../utils/superAdmin', () => ({ isSuperAdminRequest: jest.fn(() => false) }));
jest.mock('../services/groupService', () => ({ getUserGroupIds: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/interviewOrchestratorService', () => ({
  prepareAssistedInterviewTurn: jest.fn(),
  prepareAutonomousInterviewTurn: jest.fn().mockResolvedValue({ internalContext: null }),
}));

const mockResolveThreadAccess = jest.fn();
const mockCanWriteThread = jest.fn();
jest.mock('../services/threadAccessService', () => ({
  resolveThreadAccess: (...args: unknown[]) => mockResolveThreadAccess(...args),
  canWriteThread: (...args: unknown[]) => mockCanWriteThread(...args),
}));

const mockIsBuildFromPromptEnabled = jest.fn();
jest.mock('../services/buildAccessService', () => ({
  isBuildFromPromptEnabled: (...args: unknown[]) => mockIsBuildFromPromptEnabled(...args),
}));

const mockPrepareBuildIntakeTurn = jest.fn();
jest.mock('../services/buildIntakeService', () => ({
  ...jest.requireActual('../services/buildIntakeService'),
  prepareBuildIntakeTurn: (...args: unknown[]) => mockPrepareBuildIntakeTurn(...args),
}));

const mockAutoDraftBuildBriefForThread = jest.fn();
jest.mock('../services/buildBriefService', () => ({
  autoDraftBuildBriefForThread: (...args: unknown[]) => mockAutoDraftBuildBriefForThread(...args),
}));

import chatRouter from '../routes/chat';
import * as chatAgentService from '../services/chatAgentService';
import type { ChatThread } from '../../shared/types/chat';
import { BUILD_INTAKE_PAUSED_MESSAGE } from '../../shared/types/buildAccess';

const mockChat = chatAgentService as jest.Mocked<typeof chatAgentService>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  return app;
}

function intakeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    userId: 'requester-1',
    status: 'idle',
    kickoff: {
      project: 'Apex',
      repo: 'org/target',
      playbookInterview: { runId: 'run-1', stepId: 'intake', snapshot: { key: 'build-intake', mode: 'human_led' } },
    } as ChatThread['kickoff'],
    workspaceDir: '/tmp',
    flagged: false,
    messages: [],
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const plainThread = (): ChatThread => ({ ...intakeThread(), kickoff: { project: 'Apex', repo: 'org/apex' } });
const CONTEXT = '<<<INTERNAL_INTAKE_CONTEXT>>>\nbudget\n<<<END_INTERNAL_INTAKE_CONTEXT>>>';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveThreadAccess.mockResolvedValue({ thread: intakeThread(), access: 'owner' });
  mockCanWriteThread.mockResolvedValue(true);
  mockIsBuildFromPromptEnabled.mockResolvedValue(true);
  mockPrepareBuildIntakeTurn.mockResolvedValue({ internalContext: CONTEXT, sensitiveClasses: [] });
  mockChat.sendMessage.mockResolvedValue({ route: 'legacy' } as never);
  mockChat.getThread.mockResolvedValue(null);
});

describe('POST /threads/:id/messages on a build-intake thread', () => {
  it('VT-10: flagged text reaches sendMessage unchanged with the hook context (PBI-010 AC-2)', async () => {
    const text = 'Our product code is A9F3K2X7Q1M8Z5P4';
    mockPrepareBuildIntakeTurn.mockResolvedValue({ internalContext: CONTEXT, sensitiveClasses: ['secret_key_value'] });

    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({ text, turnId: '11111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(202);
    expect(mockPrepareBuildIntakeTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      messageText: text,
      turnId: '11111111-1111-4111-8111-111111111111',
    });
    expect(mockChat.sendMessage).toHaveBeenCalledWith(
      'thread-1',
      text,
      undefined,
      [],
      expect.objectContaining({ internalContext: CONTEXT }),
    );
  });

  it('FEAT-006 U1: confirming the intake summary drafts the brief after the message is sent', async () => {
    mockPrepareBuildIntakeTurn.mockResolvedValue({ internalContext: CONTEXT, sensitiveClasses: [], confirmed: true });

    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({ text: 'Answer: A — Confirm', turnId: 't-confirm' });

    expect(res.status).toBe(202);
    expect(mockChat.sendMessage).toHaveBeenCalled();
    expect(mockAutoDraftBuildBriefForThread).toHaveBeenCalledWith('thread-1');
  });

  it('FEAT-006 U1: an ordinary answer does not draft the brief', async () => {
    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({ text: 'Only managers', turnId: 't-answer' });

    expect(res.status).toBe(202);
    expect(mockAutoDraftBuildBriefForThread).not.toHaveBeenCalled();
  });

  it('VT-09 (route): a hook failure still sends the message', async () => {
    mockPrepareBuildIntakeTurn.mockRejectedValue(new TypeError('boom'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({ text: 'Bearer abcdefgh12345678SECRET', turnId: 't1' });

    expect(res.status).toBe(202);
    expect(mockChat.sendMessage).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    errorSpy.mockRestore();
  });

  it('VT-14: flag off returns 403 with the pause message and sends nothing', async () => {
    mockIsBuildFromPromptEnabled.mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({ text: 'hello', turnId: 't1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(BUILD_INTAKE_PAUSED_MESSAGE);
    expect(mockIsBuildFromPromptEnabled).toHaveBeenCalledWith({ userId: 'requester-1', project: 'Apex' });
    expect(mockChat.sendMessage).not.toHaveBeenCalled();
  });

  it('VT-14: reads still work with the flag off', async () => {
    mockIsBuildFromPromptEnabled.mockResolvedValue(false);

    const res = await request(buildApp()).get('/api/chat/threads/thread-1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('thread-1');
  });

  it('VT-15: attachments return 400 and nothing is sent', async () => {
    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({
        text: 'see file',
        turnId: 't1',
        attachments: [{ id: 'a1', name: 'a.txt', type: 'text/plain', size: 5, content: 'hello' }],
      });

    expect(res.status).toBe(400);
    expect(mockChat.sendMessage).not.toHaveBeenCalled();
  });

  it('VT-15: a non-build thread with an attachment behaves as today', async () => {
    mockResolveThreadAccess.mockResolvedValue({ thread: plainThread(), access: 'owner' });

    const res = await request(buildApp())
      .post('/api/chat/threads/thread-1/messages')
      .send({
        text: 'see file',
        turnId: 't1',
        attachments: [{ id: 'a1', name: 'a.txt', type: 'text/plain', size: 5, content: 'hello' }],
      });

    expect(res.status).toBe(202);
    expect(mockPrepareBuildIntakeTurn).not.toHaveBeenCalled();
    expect(mockIsBuildFromPromptEnabled).not.toHaveBeenCalled();
  });
});

describe('VT-06 — replay after a dropped stream (PBI-009 AC-1)', () => {
  function readUntilStatus(port: number, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get({ port, path: '/api/chat/threads/thread-1/stream', headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.includes('"type":"status"')) {
            req.destroy();
            resolve(body);
          }
        });
      });
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });
  }

  it('replays every stored message once, in order, when resuming with Last-Event-ID', async () => {
    const stored = intakeThread({
      messages: [
        { id: 'm1', role: 'user', text: 'Add dark mode', ts: '2026-01-01T00:00:01Z' },
        { id: 'm2', role: 'agent', text: 'You want dark mode.', ts: '2026-01-01T00:00:02Z' },
        { id: 'm3', role: 'user', text: 'Yes', ts: '2026-01-01T00:00:03Z' },
      ],
    });
    mockResolveThreadAccess.mockResolvedValue({ thread: stored, access: 'owner' });
    mockChat.getThread.mockResolvedValue(stored);

    const server = buildApp().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const body = await readUntilStatus(port, { 'Last-Event-ID': 'event-after-m1' });
      const ids = [...body.matchAll(/"id":"(m\d)"/g)].map((match) => match[1]);
      expect(ids).toEqual(['m1', 'm2', 'm3']);
    } finally {
      server.close();
    }
  });
});
