/**
 * W4-A / S7 — Interactive gateway frames, host gate removal, HTTP harness routes,
 * thread create harness stamping, and snapshot tests (TBI-010, PBI-008).
 *
 * Covers:
 *  - VT-23 / TBI-010 DoD-1 / PBI-008 AC-0: Socket command drops before receipt ->
 *      HTTP retry with same commandId applies once and returns original receipt
 *  - VT-24 / PBI-008 AC-1: Repository insert throws -> HTTP 500, no row/run ->
 *      retry after recovery returns 200 and applies once
 *  - VT-36 / TBI-010 DoD-0: Write-access socket sends command frame -> receives
 *      receipt frame and state frame
 *  - VT-37 / PBI-008: Socket reconnects mid-run with lastEventId -> one state frame
 *      on connect, replay has no lost or doubled events/messages
 *  - VT-38 / TBI-010 DoD-2: Read-only socket receives state + event frames; sending
 *      command returns rejected receipt frame
 *  - VT-39: mountInteractiveGateway opens socket with AI_RUNS_INTERACTIVE_GATEWAY unset
 *      and both flags off when session + thread read access succeed
 *  - VT-40 / TBI-010 DoD-3: POST /api/chat/threads with harnessArea stamps area/version
 *      (and 422s on unknown-area / invalid-context / missing-model);
 *      GET /api/harness/threads/:id/snapshot returns messages, state, latestSummary
 */
import express from 'express';
import type http from 'http';
import type { Duplex } from 'stream';
import request from 'supertest';
import type {
  AgentRunEventEnvelope,
  ChatThread,
} from '../../../shared/types/chat';
import type {
  HarnessCommandBody,
  HarnessReceipt,
  HarnessSummaryMarker,
  HarnessThreadState,
} from '../../../shared/types/chatHarness';
import { getAreaProfile } from '../../services/chatHarness/areaProfiles';
import type { ResolvedAreaProfile } from '../../services/chatHarness/areaProfileResolver';
import {
  createChatHarnessCommandHandler,
} from '../../services/chatHarness/chatHarnessCommandHandler';
import type {
  ChatHarnessCommandRepository,
  ChatHarnessCommandRow,
  InsertCommandInput,
  UpdateCommandReceiptPatch,
} from '../../services/chatHarness/chatHarnessCommandRepository';
import {
  attachInteractiveThreadStream,
  type InteractiveGatewayDependencies,
  type InteractiveGatewaySocket,
} from '../../services/interactiveGatewayService';
import { createChatHarnessRouter } from '../../routes/chatHarness';
import {
  isInteractiveGatewayEnabled,
  mountInteractiveGateway,
} from '../../services/interactiveGatewayHost';
import { WebSocketServer } from 'ws';
import { getUserId } from '../../utils/requestUser';
import { resolveThreadAccess } from '../../services/threadAccessService';
import { isFeatureEnabled } from '../../services/featureFlagService';
import * as chatService from '../../services/chatAgentService';
import { resolveSkillConfig } from '../../services/projectSettingsService';
import { getUserPermissions } from '../../services/rbacService';
import { getAppSetting } from '../../services/appSettingsService';
import chatRouter from '../../routes/chat';

jest.mock('ws', () => ({
  WebSocketServer: jest.fn(),
}));

jest.mock('../../utils/requestUser', () => {
  const actual = jest.requireActual('../../utils/requestUser');
  return {
    ...actual,
    getUserId: jest.fn(() => '20000000-0000-4000-8000-000000000022'),
  };
});

jest.mock('../../services/threadAccessService', () => ({
  resolveThreadAccess: jest.fn(),
  canWriteThread: jest.fn(),
}));

jest.mock('../../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

jest.mock('../../services/chatAgentService', () => {
  const actual = jest.requireActual('../../services/chatAgentService');
  return {
    ...actual,
    createThread: jest.fn(),
    getThread: jest.fn(),
  };
});

jest.mock('../../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

jest.mock('../../services/appSettingsService', () => ({
  getAppSetting: jest.fn(),
}));

jest.mock('../../middleware/rbac', () => ({
  requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../../services/groupService', () => ({
  getUserGroupIds: jest.fn(async () => []),
}));

const THREAD_ID = '10000000-0000-4000-8000-000000000011';
const USER_ID = '20000000-0000-4000-8000-000000000022';
const READER_ID = '20000000-0000-4000-8000-000000000099';
const RUN_ID_1 = '30000000-0000-4000-8000-000000000031';
const CMD_1 = '40000000-0000-4000-8000-000000000001';
const CMD_2 = '40000000-0000-4000-8000-000000000002';

const mockWebSocketServer = WebSocketServer as unknown as jest.Mock;
const mockGetUserId = getUserId as jest.MockedFunction<typeof getUserId>;
const mockResolveThreadAccess =
  resolveThreadAccess as jest.MockedFunction<typeof resolveThreadAccess>;
const mockIsFeatureEnabled =
  isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;
const mockCreateThread = chatService.createThread as jest.MockedFunction<
  typeof chatService.createThread
>;
const mockResolveSkillConfig =
  resolveSkillConfig as jest.MockedFunction<typeof resolveSkillConfig>;
const mockGetUserPermissions =
  getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;
const mockGetAppSetting =
  getAppSetting as jest.MockedFunction<typeof getAppSetting>;

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: THREAD_ID,
    userId: USER_ID,
    status: 'idle',
    harnessArea: 'agent-home',
    harnessVersion: 1,
    kickoff: {
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
    },
    messages: [
      {
        id: 'msg-hidden',
        role: 'user',
        text: 'Begin.',
        hidden: true,
        ts: '2026-11-19T00:00:00.000Z',
      },
      {
        id: 'msg-visible-1',
        role: 'user',
        text: 'Hello agent',
        ts: '2026-11-19T00:00:01.000Z',
      },
      {
        id: 'msg-visible-2',
        role: 'agent',
        text: 'Hello user',
        ts: '2026-11-19T00:00:02.000Z',
      },
    ],
    workspaceDir: '/tmp/apex-thread',
    flagged: false,
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActivityAt: '2026-11-19T00:00:02.000Z',
    ...overrides,
  };
}

function makeResolvedProfile(area: 'agent-home' | 'prd-assistant' = 'agent-home'): ResolvedAreaProfile {
  const profile = getAreaProfile(area);
  return {
    profile,
    project: 'Apex',
    settingsId: 'settings-1',
    skill: profile.requiresSkill
      ? { name: area, path: `.cursor/skills/${area}/SKILL.md`, source: 'project-setting' }
      : null,
    model: 'claude-sonnet-4-6',
    effort: null,
    permission: profile.permission,
    workflowClass: profile.workflowClass,
    toolAllowlist: profile.toolAllowlist,
    disallowedTools: profile.disallowedTools,
    customTools: profile.customTools,
    writeConfirmation: profile.writeConfirmation,
    safety: profile.safety,
    recreationCapChars: profile.recreationCapChars,
    rating: profile.rating,
  };
}

function makeInMemoryRepo(options?: { failNextInsert?: boolean }) {
  const rows = new Map<string, ChatHarnessCommandRow>();
  let failNextInsert = options?.failNextInsert ?? false;
  let seq = 0;

  const repo: ChatHarnessCommandRepository = {
    async insertIfAbsent(input: InsertCommandInput) {
      if (failNextInsert) {
        failNextInsert = false;
        throw new Error('Transient Postgres insert failure');
      }
      const key = `${input.threadId}:${input.commandId}`;
      const existing = rows.get(key);
      if (existing) {
        return { inserted: false, row: { ...existing } };
      }
      seq += 1;
      const nowIso = '2026-11-19T01:00:00.000Z';
      const created: ChatHarnessCommandRow = {
        id: `cmd-row-${seq}`,
        threadId: input.threadId,
        commandId: input.commandId,
        runId: input.runId ?? null,
        kind: input.kind,
        status: input.status,
        reason: input.reason ?? null,
        payload: input.payload ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      rows.set(key, created);
      return { inserted: true, row: { ...created } };
    },
    async findByCommandId(threadId, commandId) {
      const found = rows.get(`${threadId}:${commandId}`);
      return found ? { ...found } : null;
    },
    async updateReceipt(
      threadId: string,
      commandId: string,
      patch: UpdateCommandReceiptPatch,
    ) {
      const key = `${threadId}:${commandId}`;
      const existing = rows.get(key);
      if (!existing) return null;
      const updated: ChatHarnessCommandRow = {
        ...existing,
        status: patch.status,
        reason: 'reason' in patch ? (patch.reason ?? null) : existing.reason,
        runId: 'runId' in patch ? (patch.runId ?? null) : existing.runId,
        updatedAt: '2026-11-19T01:00:01.000Z',
      };
      rows.set(key, updated);
      return { ...updated };
    },
    async countActiveSteersForRun() {
      return 0;
    },
    async listPendingCommands(threadId) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.threadId === threadId &&
            (r.status === 'accepted' || r.status === 'queued'),
        )
        .map((r) => ({
          commandId: r.commandId,
          kind: r.kind,
          status: r.status as 'accepted' | 'queued',
        }));
    },
    async listPendingControlForRun() {
      return [];
    },
  };

  return {
    repo,
    rows,
    setFailNextInsert(val: boolean) {
      failNextInsert = val;
    },
  };
}

function makeFakeSocket() {
  const frames: Array<Record<string, unknown>> = [];
  let closeHandler: () => void = () => {};
  let messageHandler: (data: string) => void = () => {};
  const socket: InteractiveGatewaySocket = {
    send: (data: string) => {
      frames.push(JSON.parse(data) as Record<string, unknown>);
    },
    onClose: (handler: () => void) => {
      closeHandler = handler;
    },
    onMessage: (handler: (data: string) => void) => {
      messageHandler = handler;
    },
  };
  return {
    socket,
    frames,
    sendFromClient: (payload: unknown) =>
      messageHandler(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      ),
    triggerClose: () => closeHandler(),
  };
}

function makeEnvelope(
  eventId: string,
  sequence: number,
  overrides: Partial<AgentRunEventEnvelope> = {},
): AgentRunEventEnvelope {
  return {
    eventId,
    threadId: THREAD_ID,
    runId: RUN_ID_1,
    sourceInstance: 'actor-1',
    sequence,
    timestamp: `2026-11-19T01:00:${String(sequence).padStart(2, '0')}.000Z`,
    type: 'token',
    phase: 'implementation',
    status: 'running',
    event: { type: 'token', text: `tok-${eventId}` },
    ...overrides,
  };
}

function makeGatewayDeps(
  overrides: Partial<InteractiveGatewayDependencies> = {},
) {
  let durableCb: (env: AgentRunEventEnvelope) => void = () => {};
  let liveCb: (env: AgentRunEventEnvelope) => void = () => {};
  let commandReceiptCb: (receipt: HarnessReceipt) => void = () => {};
  const deps: InteractiveGatewayDependencies = {
    loadThreadSnapshot: jest.fn(async () => ({
      messages: [],
      status: 'running' as const,
      eventDrivenTermination: true,
      activeRunId: RUN_ID_1,
    })),
    loadThreadState: jest.fn(async (): Promise<HarnessThreadState> => ({
      threadStatus: 'running',
      activeRunId: RUN_ID_1,
      phase: 'running',
      harnessArea: 'agent-home',
      pendingCommands: [],
      latestSummary: null,
      canWrite: true,
    })),
    replayRunEvents: jest.fn(async () => []),
    subscribeDurableEvents: (_threadId, cb) => {
      durableCb = cb;
      return jest.fn();
    },
    subscribeToThread: () => jest.fn(),
    subscribeLiveEvents: (_threadId, cb) => {
      liveCb = cb;
      return jest.fn();
    },
    subscribeThreadCommands: (_threadId, cb) => {
      commandReceiptCb = cb;
      return jest.fn();
    },
    eventForRunEnvelope: (env) => env.event as never,
    ...overrides,
  };
  return {
    deps,
    emitDurable: (env: AgentRunEventEnvelope) => durableCb(env),
    emitLive: (env: AgentRunEventEnvelope) => liveCb(env),
    emitCommandReceipt: (receipt: HarnessReceipt) => commandReceiptCb(receipt),
  };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Chat harness gateway frames & HTTP routes (S7 / TBI-010 / PBI-008)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserId.mockReturnValue(USER_ID);
    mockResolveSkillConfig.mockResolvedValue(null);
    mockGetAppSetting.mockResolvedValue(null);
  });

  it('VT-36 / DoD-0: write-access socket sends a command frame and receives a receipt frame and state frame', async () => {
    const store = makeInMemoryRepo();
    const admitTurn = jest.fn(async () => ({
      runId: RUN_ID_1,
      threadId: THREAD_ID,
      status: 'queued' as const,
      turnId: CMD_1,
      interactiveClass: 'fast' as const,
    }));
    const handler = createChatHarnessCommandHandler({
      repository: store.repo,
      resolveThreadAccess: async () => ({
        access: 'owner',
        thread: makeThread(),
      }),
      canWriteThread: async () => true,
      getUserPermissions: async () => new Set(['chat:create']),
      resolveAreaProfile: async () => makeResolvedProfile(),
      resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
      admitTurn,
      trackEvent: jest.fn(),
    });

    const { socket, frames, sendFromClient } = makeFakeSocket();
    const { deps } = makeGatewayDeps({
      loadThreadState: jest.fn(async (): Promise<HarnessThreadState> => ({
        threadStatus: store.rows.size > 0 ? 'running' : 'idle',
        activeRunId: store.rows.size > 0 ? RUN_ID_1 : null,
        phase: store.rows.size > 0 ? 'starting' : 'idle',
        harnessArea: 'agent-home',
        pendingCommands: await store.repo.listPendingCommands(THREAD_ID),
        latestSummary: null,
        canWrite: true,
      })),
      onCommand: (body: HarnessCommandBody) =>
        handler.handle({
          userId: USER_ID,
          threadId: THREAD_ID,
          body,
          transport: 'socket',
        }),
    });

    await attachInteractiveThreadStream(socket, THREAD_ID, {}, deps);
    // Initial state frame sent on connect
    expect(frames.filter((f) => f.type === 'state')).toHaveLength(1);

    sendFromClient({
      type: 'command',
      commandId: CMD_1,
      kind: 'send',
      text: 'Write a hello world function',
    });
    await flushAsync();

    const receiptFrames = frames.filter((f) => f.type === 'receipt');
    expect(receiptFrames).toHaveLength(1);
    expect(receiptFrames[0]).toMatchObject({
      type: 'receipt',
      receipt: {
        commandId: CMD_1,
        kind: 'send',
        status: 'accepted',
        runId: RUN_ID_1,
      },
    });

    const stateFrames = frames.filter((f) => f.type === 'state');
    expect(stateFrames.length).toBeGreaterThanOrEqual(2);
    expect(stateFrames[stateFrames.length - 1]).toMatchObject({
      type: 'state',
      state: {
        activeRunId: RUN_ID_1,
        pendingCommands: [
          { commandId: CMD_1, kind: 'send', status: 'accepted' },
        ],
      },
    });

    // Invalid command frame yields an error frame
    sendFromClient({ type: 'command', commandId: 'not-a-uuid', kind: 'send', text: 'hi' });
    await flushAsync();
    expect(frames[frames.length - 1]).toMatchObject({
      type: 'error',
      code: 'invalid-command',
    });

    handler.dispose();
  });

  it('VT-23 / DoD-1 / PBI-008 AC-0: socket drops before receipt; HTTP retry with same commandId applies once and returns original receipt', async () => {
    const store = makeInMemoryRepo();
    const admitTurn = jest.fn(async () => ({
      runId: RUN_ID_1,
      threadId: THREAD_ID,
      status: 'queued' as const,
      turnId: CMD_1,
      interactiveClass: 'fast' as const,
    }));
    const thread = makeThread();
    const handler = createChatHarnessCommandHandler({
      repository: store.repo,
      resolveThreadAccess: async () => ({ access: 'owner', thread }),
      canWriteThread: async () => true,
      getUserPermissions: async () => new Set(['chat:create']),
      resolveAreaProfile: async () => makeResolvedProfile(),
      resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
      admitTurn,
      trackEvent: jest.fn(),
    });

    // Socket receives command and immediately drops before the receipt frame can be delivered
    const { socket, frames, sendFromClient, triggerClose } = makeFakeSocket();
    const { deps } = makeGatewayDeps({
      onCommand: async (body: HarnessCommandBody) => {
        const receipt = await handler.handle({
          userId: USER_ID,
          threadId: THREAD_ID,
          body,
          transport: 'socket',
        });
        triggerClose(); // Drop socket before gateway sends receipt frame
        return receipt;
      },
    });

    await attachInteractiveThreadStream(socket, THREAD_ID, {}, deps);
    sendFromClient({
      type: 'command',
      commandId: CMD_1,
      kind: 'send',
      text: 'Check status',
    });
    await flushAsync();

    // Client never saw receipt on the dropped socket
    expect(frames.filter((f) => f.type === 'receipt')).toHaveLength(0);
    expect(admitTurn).toHaveBeenCalledTimes(1);

    // Client retries the exact same command over HTTP POST /api/harness/threads/:id/commands
    const app = express();
    app.use(express.json());
    app.use(
      '/api/harness',
      createChatHarnessRouter({
        commandHandler: handler,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        getAdoTokenForUser: async () => null,
      }),
    );

    const res = await request(app)
      .post(`/api/harness/threads/${THREAD_ID}/commands`)
      .send({
        commandId: CMD_1,
        kind: 'send',
        text: 'Check status',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      commandId: CMD_1,
      kind: 'send',
      status: 'accepted',
      runId: RUN_ID_1,
    });
    // Still only ONE run admitted!
    expect(admitTurn).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it('VT-24 / PBI-008 AC-1: repository insert throws -> HTTP 500 with no row/run; retry after recovery returns 200 and applies once', async () => {
    const store = makeInMemoryRepo({ failNextInsert: true });
    const admitTurn = jest.fn(async () => ({
      runId: RUN_ID_1,
      threadId: THREAD_ID,
      status: 'queued' as const,
      turnId: CMD_2,
      interactiveClass: 'fast' as const,
    }));
    const thread = makeThread();
    const handler = createChatHarnessCommandHandler({
      repository: store.repo,
      resolveThreadAccess: async () => ({ access: 'owner', thread }),
      canWriteThread: async () => true,
      getUserPermissions: async () => new Set(['chat:create']),
      resolveAreaProfile: async () => makeResolvedProfile(),
      resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
      admitTurn,
      trackEvent: jest.fn(),
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/harness',
      createChatHarnessRouter({
        commandHandler: handler,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        getAdoTokenForUser: async () => null,
      }),
    );

    // First attempt fails at repo insert
    const firstRes = await request(app)
      .post(`/api/harness/threads/${THREAD_ID}/commands`)
      .send({
        commandId: CMD_2,
        kind: 'send',
        text: 'Retryable message',
      });

    expect(firstRes.status).toBe(500);
    expect(store.rows.size).toBe(0);
    expect(admitTurn).not.toHaveBeenCalled();

    // Retry after DB recovers succeeds and applies once
    const retryRes = await request(app)
      .post(`/api/harness/threads/${THREAD_ID}/commands`)
      .send({
        commandId: CMD_2,
        kind: 'send',
        text: 'Retryable message',
      });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body).toMatchObject({
      commandId: CMD_2,
      kind: 'send',
      status: 'accepted',
      runId: RUN_ID_1,
    });
    expect(store.rows.size).toBe(1);
    expect(admitTurn).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it('VT-37 / PBI-008: reconnect mid-run with lastEventId emits one state frame on connect and replays without lost or doubled events', async () => {
    const { socket, frames } = makeFakeSocket();
    const { deps, emitLive } = makeGatewayDeps({
      replayRunEvents: jest.fn(async () => [
        makeEnvelope('e2', 2),
        makeEnvelope('e3', 3),
      ]),
    });

    await attachInteractiveThreadStream(
      socket,
      THREAD_ID,
      { lastEventId: 'e1' },
      deps,
    );

    // Duplicate of e3 followed by new live e4
    emitLive(makeEnvelope('e3', 3));
    emitLive(makeEnvelope('e4', 4));

    const stateFrames = frames.filter((f) => f.type === 'state');
    expect(stateFrames).toHaveLength(1);

    const eventIds = frames
      .filter((f) => f.type === 'event' && f.id)
      .map((f) => f.id);
    expect(eventIds).toEqual(['e2', 'e3', 'e4']);
  });

  it('VT-38 / DoD-2: read-only socket receives state and event frames, and gets rejected receipt on command', async () => {
    const store = makeInMemoryRepo();
    const thread = makeThread();
    const handler = createChatHarnessCommandHandler({
      repository: store.repo,
      resolveThreadAccess: async () => ({ access: 'read', thread }),
      canWriteThread: async () => false,
      getUserPermissions: async () => new Set(['chat:create']),
      resolveAreaProfile: async () => makeResolvedProfile(),
      resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
      trackEvent: jest.fn(),
    });

    const { socket, frames, sendFromClient } = makeFakeSocket();
    const { deps, emitLive } = makeGatewayDeps({
      loadThreadState: jest.fn(async (): Promise<HarnessThreadState> => ({
        threadStatus: 'running',
        activeRunId: RUN_ID_1,
        phase: 'running',
        harnessArea: 'agent-home',
        pendingCommands: [],
        latestSummary: null,
        canWrite: false,
      })),
      onCommand: (body: HarnessCommandBody) =>
        handler.handle({
          userId: READER_ID,
          threadId: THREAD_ID,
          body,
          transport: 'socket',
        }),
    });

    await attachInteractiveThreadStream(socket, THREAD_ID, {}, deps);
    emitLive(makeEnvelope('ev-ro-1', 1));

    expect(frames.some((f) => f.type === 'state')).toBe(true);
    expect(
      frames.some((f) => f.type === 'event' && f.id === 'ev-ro-1'),
    ).toBe(true);

    sendFromClient({
      type: 'command',
      commandId: CMD_1,
      kind: 'steer',
      text: 'Try to steer as viewer',
    });
    await flushAsync();

    const receipt = frames.find((f) => f.type === 'receipt');
    expect(receipt).toMatchObject({
      type: 'receipt',
      receipt: {
        commandId: CMD_1,
        kind: 'steer',
        status: 'rejected',
        reason: 'You have read-only access to this chat',
      },
    });
    expect(store.rows.size).toBe(0);
    handler.dispose();
  });

  it('VT-39: mountInteractiveGateway opens socket with env unset and both flags off when session + read access succeed', async () => {
    const prevEnv = process.env.AI_RUNS_INTERACTIVE_GATEWAY;
    delete process.env.AI_RUNS_INTERACTIVE_GATEWAY;
    try {
      expect(isInteractiveGatewayEnabled()).toBe(true);

      let upgradeHandler:
        | ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)
        | undefined;
      const handleUpgrade = jest.fn();
      mockWebSocketServer.mockImplementation(() => ({ handleUpgrade }));
      mockIsFeatureEnabled.mockResolvedValue(false);
      mockResolveThreadAccess.mockResolvedValue({
        access: 'read',
        thread: makeThread(),
      });

      const server = {
        on: jest.fn((event: string, cb: typeof upgradeHandler) => {
          if (event === 'upgrade') upgradeHandler = cb;
        }),
      } as unknown as http.Server;
      const pass: express.RequestHandler = (_req, _res, next) => next();

      mountInteractiveGateway(server, {
        sessionMiddleware: pass,
        passportInitialize: pass,
        passportSession: pass,
      });

      const socket = { destroy: jest.fn() } as unknown as Duplex;
      upgradeHandler?.(
        { url: `/api/interactive/threads/${THREAD_ID}/stream` } as http.IncomingMessage,
        socket,
        Buffer.alloc(0),
      );
      await flushAsync();

      expect(handleUpgrade).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(mockIsFeatureEnabled).not.toHaveBeenCalled();

      // Unauthorized thread still destroys socket
      mockResolveThreadAccess.mockResolvedValueOnce(null);
      const deniedSocket = { destroy: jest.fn() } as unknown as Duplex;
      upgradeHandler?.(
        { url: `/api/interactive/threads/${THREAD_ID}/stream` } as http.IncomingMessage,
        deniedSocket,
        Buffer.alloc(0),
      );
      await flushAsync();
      expect(deniedSocket.destroy).toHaveBeenCalledTimes(1);
    } finally {
      if (prevEnv !== undefined) {
        process.env.AI_RUNS_INTERACTIVE_GATEWAY = prevEnv;
      }
    }
  });

  it('VT-40 / DoD-3: POST /api/chat/threads stamps harnessArea/version and GET /api/harness/threads/:id/snapshot returns messages, state, and latestSummary', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['interviews:view', 'chat:view']));
    mockResolveSkillConfig.mockResolvedValue({
      id: 'settings-1',
      project: 'Apex',
      prdAssistantSkillPath: '.cursor/skills/prd-assistant/SKILL.md',
      prdAssistantModel: 'claude-sonnet-4-6',
    } as never);
    mockCreateThread.mockResolvedValue(
      makeThread({
        id: THREAD_ID,
        harnessArea: 'prd-assistant',
        harnessVersion: 1,
      }),
    );

    const chatApp = express();
    chatApp.use(express.json());
    chatApp.use('/api/chat', chatRouter);

    // Valid harnessArea + harnessContext
    const createRes = await request(chatApp)
      .post('/api/chat/threads')
      .send({
        kickoff: { project: 'Apex', repo: 'AI-Pilot' },
        skipAutoKickoff: true,
        harnessArea: 'prd-assistant',
        harnessContext: { kind: 'prd', id: 'prd-123' },
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      threadId: THREAD_ID,
      harnessArea: 'prd-assistant',
      harnessVersion: 1,
    });
    expect(mockCreateThread).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ project: 'Apex', repo: 'AI-Pilot' }),
      expect.objectContaining({
        skipAutoKickoff: true,
        harness: { area: 'prd-assistant', version: 1 },
      }),
    );

    // Unknown area -> 422
    const unknownRes = await request(chatApp)
      .post('/api/chat/threads')
      .send({
        kickoff: { project: 'Apex', repo: 'AI-Pilot' },
        harnessArea: 'not-a-real-area',
      });
    expect(unknownRes.status).toBe(422);
    expect(unknownRes.body.code).toBe('unknown-area');

    // Invalid context for area -> 422
    const invalidCtxRes = await request(chatApp)
      .post('/api/chat/threads')
      .send({
        kickoff: { project: 'Apex', repo: 'AI-Pilot' },
        harnessArea: 'prd-assistant',
        harnessContext: { kind: 'adr', id: 'adr-1' },
      });
    expect(invalidCtxRes.status).toBe(422);
    expect(invalidCtxRes.body.code).toBe('invalid-context');

    // Missing model -> 422
    mockResolveSkillConfig.mockResolvedValueOnce({
      id: 'settings-1',
      project: 'Apex',
      prdAssistantSkillPath: '.cursor/skills/prd-assistant/SKILL.md',
    } as never);
    mockGetAppSetting.mockResolvedValueOnce(null);
    const missingModelRes = await request(chatApp)
      .post('/api/chat/threads')
      .send({
        kickoff: { project: 'Apex', repo: 'AI-Pilot' },
        harnessArea: 'prd-assistant',
      });
    expect(missingModelRes.status).toBe(422);
    expect(missingModelRes.body.code).toBe('missing-model');

    // Snapshot route returns non-hidden messages, state, and latestSummary (no summaryText)
    const latestSummary: HarnessSummaryMarker = {
      id: 'sum-1',
      source: 'user',
      fallback: false,
      createdAt: '2026-11-19T00:05:00.000Z',
    };
    const thread = makeThread({
      harnessArea: 'prd-assistant',
      harnessVersion: 1,
    });
    const harnessApp = express();
    harnessApp.use(express.json());
    harnessApp.use(
      '/api/harness',
      createChatHarnessRouter({
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        listPendingCommands: async () => [],
        getLatestSummaryMarker: async () => latestSummary,
        canCommandThread: async () => true,
      }),
    );

    const snapRes = await request(harnessApp).get(
      `/api/harness/threads/${THREAD_ID}/snapshot`,
    );

    expect(snapRes.status).toBe(200);
    expect(snapRes.body.messages.map((m: { id: string }) => m.id)).toEqual([
      'msg-visible-1',
      'msg-visible-2',
    ]);
    expect(snapRes.body.latestSummary).toEqual(latestSummary);
    expect(snapRes.body.state).toEqual({
      threadStatus: 'idle',
      activeRunId: null,
      phase: 'idle',
      harnessArea: 'prd-assistant',
      pendingCommands: [],
      latestSummary,
      canWrite: true,
    });
    expect(snapRes.body.latestSummary.summaryText).toBeUndefined();
    expect(snapRes.body.canWrite).toBe(true);
  });
});
