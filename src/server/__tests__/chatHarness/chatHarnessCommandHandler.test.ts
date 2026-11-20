/**
 * W3-A / S6 — Command repository, state frame builder, toolGrantResolver, and command handler.
 *
 * Covers:
 *  - TBI-009 (DoD-0..3): all 6 steer rows (S-1..S-6), duplicate command id, read-only rejection, 6th steer cap
 *  - PBI-004 (AC-0..3): steer running turn, 5-steer cap, turn-ended fallback, read-only steer
 *  - PBI-005 (AC-1..3): cancel 2 s timeout, cancel already-finished, read-only cancel
 *  - PBI-006 (AC-3): read-only summarize, summarize while running
 *  - PBI-008 (AC-2..3): concurrent duplicate commandId, revoked write access on retry
 *  - Verification Matrix: VT-01..04, VT-07, VT-09..11, VT-15..16, VT-25..26, VT-51
 */
import type { ChatAttachment, ChatThread } from '../../../shared/types/chat';
import type {
  HarnessCommandBody,
  HarnessControlMessage,
  HarnessReceipt,
} from '../../../shared/types/chatHarness';
import type { FrozenInteractiveToolGrant } from '../../../shared/types/durableInteractiveTurn';
import { getAreaProfile } from '../../services/chatHarness/areaProfiles';
import type { ResolvedAreaProfile } from '../../services/chatHarness/areaProfileResolver';
import type { HarnessControlAck } from '../../services/chatHarness/chatHarnessControlBus';
import {
  sanitizeCommandPayload,
  rowToHarnessReceipt,
  createChatHarnessCommandRepository,
  type ChatHarnessCommandRepository,
  type ChatHarnessCommandRow,
  type InsertCommandInput,
  type UpdateCommandReceiptPatch,
} from '../../services/chatHarness/chatHarnessCommandRepository';
import {
  buildHarnessThreadState,
  loadHarnessThreadState,
} from '../../services/chatHarness/chatHarnessStateFrame';
import {
  MAX_CHAT_ATTACHMENTS,
  resolveHarnessToolGrant,
  validateHarnessAttachments,
} from '../../services/chatHarness/toolGrantResolver';
import {
  HarnessCommandError,
  canCommandThread,
  createChatHarnessCommandHandler,
  type ChatHarnessCommandHandlerDeps,
  type ThreadRunState,
} from '../../services/chatHarness/chatHarnessCommandHandler';
import { DurableInteractiveTurnError } from '../../services/durableInteractiveTurnService';
import type { ThreadAccessResult } from '../../services/threadAccessService';

const THREAD_ID = '10000000-0000-4000-8000-000000000011';
const USER_ID = '20000000-0000-4000-8000-000000000022';
const OTHER_USER_ID = '20000000-0000-4000-8000-000000000099';
const ACTIVE_RUN_ID = '30000000-0000-4000-8000-000000000033';
const NEW_RUN_ID = '30000000-0000-4000-8000-000000000044';
const FAILED_RUN_ID = '30000000-0000-4000-8000-000000000055';

const CMD_1 = '40000000-0000-4000-8000-000000000001';
const CMD_2 = '40000000-0000-4000-8000-000000000002';
const CMD_3 = '40000000-0000-4000-8000-000000000003';
const CMD_4 = '40000000-0000-4000-8000-000000000004';
const CMD_5 = '40000000-0000-4000-8000-000000000005';
const CMD_6 = '40000000-0000-4000-8000-000000000006';

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: THREAD_ID,
    userId: USER_ID,
    status: 'running',
    activeRunId: ACTIVE_RUN_ID,
    harnessArea: 'agent-home',
    harnessVersion: 1,
    kickoff: {
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
    },
    messages: [],
    workspaceDir: '/tmp/apex-thread',
    flagged: false,
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActivityAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeResolvedProfile(area: 'agent-home' | 'brainstorm' | 'calendar-work-item' | 'cab-release' = 'agent-home'): ResolvedAreaProfile {
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

/**
 * In-memory atomic command repository matching PostgreSQL `UNIQUE (thread_id, command_id)`
 * + `ON CONFLICT DO NOTHING RETURNING *` semantics for concurrent tests (VT-25).
 */
function makeInMemoryCommandRepository(options?: {
  onReceiptChanged?: (threadId: string, receipt: HarnessReceipt) => void;
}): {
  repo: ChatHarnessCommandRepository;
  rows: Map<string, ChatHarnessCommandRow>;
  insertCalls: InsertCommandInput[];
  updateCalls: Array<{ threadId: string; commandId: string; patch: UpdateCommandReceiptPatch }>;
} {
  const rows = new Map<string, ChatHarnessCommandRow>();
  const insertCalls: InsertCommandInput[] = [];
  const updateCalls: Array<{ threadId: string; commandId: string; patch: UpdateCommandReceiptPatch }> = [];
  let seq = 0;

  const keyFor = (threadId: string, commandId: string) => `${threadId}:${commandId}`;

  const repo: ChatHarnessCommandRepository = {
    async insertIfAbsent(input) {
      insertCalls.push(input);
      const key = keyFor(input.threadId, input.commandId);
      const existing = rows.get(key);
      if (existing) {
        return { inserted: false, row: { ...existing } };
      }
      seq += 1;
      const nowIso = new Date().toISOString();
      const created: ChatHarnessCommandRow = {
        id: `row-${seq}`,
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
      const found = rows.get(keyFor(threadId, commandId));
      return found ? { ...found } : null;
    },

    async updateReceipt(threadId, commandId, patch) {
      updateCalls.push({ threadId, commandId, patch });
      const key = keyFor(threadId, commandId);
      const existing = rows.get(key);
      if (!existing) return null;
      if (patch.expectedStatus && existing.status !== patch.expectedStatus) {
        return null;
      }
      const updated: ChatHarnessCommandRow = {
        ...existing,
        status: patch.status,
        reason: 'reason' in patch ? (patch.reason ?? null) : existing.reason,
        runId: 'runId' in patch ? (patch.runId ?? null) : existing.runId,
        updatedAt: new Date().toISOString(),
      };
      rows.set(key, updated);
      options?.onReceiptChanged?.(threadId, rowToHarnessReceipt(updated));
      return { ...updated };
    },

    async countActiveSteersForRun(threadId, runId) {
      let count = 0;
      for (const row of rows.values()) {
        if (
          row.threadId === threadId &&
          row.runId === runId &&
          row.kind === 'steer' &&
          (row.status === 'accepted' || row.status === 'applied')
        ) {
          count += 1;
        }
      }
      return count;
    },

    async listPendingCommands(threadId) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.threadId === threadId &&
            (row.status === 'accepted' || row.status === 'queued'),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((row) => ({
          commandId: row.commandId,
          kind: row.kind,
          status: row.status as 'accepted' | 'queued',
        }));
    },

    async listPendingControlForRun(threadId, runId) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.threadId === threadId &&
            row.runId === runId &&
            (row.kind === 'steer' || row.kind === 'cancel') &&
            row.status === 'accepted',
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((row) =>
          row.kind === 'steer'
            ? {
                commandId: row.commandId,
                kind: 'steer' as const,
                ...(typeof row.payload?.text === 'string'
                  ? { text: row.payload.text }
                  : {}),
              }
            : {
                commandId: row.commandId,
                kind: 'cancel' as const,
              },
        );
    },
  };

  return { repo, rows, insertCalls, updateCalls };
}

function makeHandlerHarness(overrides: {
  thread?: ChatThread | null;
  threadAccess?: 'owner' | 'read';
  canWrite?: boolean;
  permissions?: Set<string>;
  runState?: ThreadRunState;
  toolGrantResult?:
    | { ok: true; toolGrant: FrozenInteractiveToolGrant | null; toolGrantInput?: { allowedOperations: ReadonlyArray<'ado:read' | 'ado:write'>; delegatedAdoToken: string | null } }
    | { ok: false; reason: 'Sign in again to continue' };
  cancelConfirmTimeoutMs?: number;
  onReceiptChanged?: (threadId: string, receipt: HarnessReceipt) => void;
  subscribeAck?: (
    threadId: string,
    cb: (ack: HarnessControlAck) => void,
  ) => () => void;
} = {}) {
  let currentThread = overrides.thread === undefined ? makeThread() : overrides.thread;
  let currentAccess: 'owner' | 'read' = overrides.threadAccess ?? 'owner';
  let currentCanWrite = overrides.canWrite ?? true;
  let currentPermissions =
    overrides.permissions ??
    new Set(['chat:create', 'brainstorm:create', 'calendar:view', 'planning:releases']);
  let currentRunState: ThreadRunState = overrides.runState ?? {
    activeRunId: ACTIVE_RUN_ID,
    hasQueuedTurn: false,
    activeRunStatus: 'running',
  };

  const mem = makeInMemoryCommandRepository({
    onReceiptChanged: overrides.onReceiptChanged,
  });
  const publishedControls: HarnessControlMessage[] = [];
  const telemetryEvents: Array<{
    name: string;
    props?: Record<string, string>;
    measurements?: Record<string, number>;
  }> = [];

  const admitMock = jest.fn().mockResolvedValue({
    turnId: CMD_1,
    runId: NEW_RUN_ID,
    status: 'queued' as const,
    interactiveClass: 'fast' as const,
  });
  const retryMock = jest.fn().mockResolvedValue({
    turnId: CMD_1,
    runId: NEW_RUN_ID,
    status: 'queued' as const,
    interactiveClass: 'fast' as const,
  });
  const cancelRunMock = jest.fn().mockResolvedValue(undefined);
  const resolveThreadAccessMock = jest.fn(async (): Promise<ThreadAccessResult | null> => {
    if (!currentThread) return null;
    return { access: currentAccess, thread: currentThread };
  });
  const canWriteThreadMock = jest.fn(async () => currentCanWrite);
  const getUserPermissionsMock = jest.fn(async () => currentPermissions);
  const getThreadRunStateMock = jest.fn(async () => currentRunState);
  const resolveAreaProfileMock = jest.fn(async (area: string) =>
    makeResolvedProfile(area as 'agent-home' | 'brainstorm' | 'calendar-work-item' | 'cab-release'),
  );
  const resolveToolGrantMock = jest.fn(async () =>
    overrides.toolGrantResult ?? { ok: true as const, toolGrant: null },
  );
  const publishControlMock = jest.fn(async (msg: HarnessControlMessage) => {
    publishedControls.push(msg);
  });
  const trackEventMock = jest.fn(
    (
      name: string,
      props?: Record<string, string>,
      measurements?: Record<string, number>,
    ) => {
      telemetryEvents.push({ name, props, measurements });
    },
  );

  const deps: ChatHarnessCommandHandlerDeps = {
    repository: mem.repo,
    resolveThreadAccess: resolveThreadAccessMock,
    canWriteThread: canWriteThreadMock,
    getUserPermissions: getUserPermissionsMock,
    resolveAreaProfile: resolveAreaProfileMock,
    resolveToolGrant: resolveToolGrantMock,
    getThreadRunState: getThreadRunStateMock,
    admitTurn: admitMock,
    retryTurn: retryMock,
    cancelRun: cancelRunMock,
    controlBus: {
      publishControl: publishControlMock,
      ...(overrides.subscribeAck ? { subscribeAck: overrides.subscribeAck } : {}),
    },
    trackEvent: trackEventMock,
    cancelConfirmTimeoutMs: overrides.cancelConfirmTimeoutMs ?? 2_000,
  };

  const handler = createChatHarnessCommandHandler(deps);

  return {
    handler,
    mem,
    publishedControls,
    telemetryEvents,
    admitMock,
    retryMock,
    cancelRunMock,
    resolveThreadAccessMock,
    canWriteThreadMock,
    getUserPermissionsMock,
    getThreadRunStateMock,
    resolveAreaProfileMock,
    resolveToolGrantMock,
    publishControlMock,
    trackEventMock,
    setAccess(next: {
      thread?: ChatThread | null;
      access?: 'owner' | 'read';
      canWrite?: boolean;
      permissions?: Set<string>;
      runState?: ThreadRunState;
    }) {
      if ('thread' in next) currentThread = next.thread ?? null;
      if (next.access !== undefined) currentAccess = next.access;
      if (next.canWrite !== undefined) currentCanWrite = next.canWrite;
      if (next.permissions !== undefined) currentPermissions = next.permissions;
      if (next.runState !== undefined) currentRunState = next.runState;
    },
  };
}

describe('W3-A / S6 — chatHarnessCommandHandler & supporting modules', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── VT-01 / PBI-004 AC-0 / TBI-009 DoD-0 (S-1, S-3, S-4) ───────────────────

  it('VT-01 / PBI-004 AC-0 / TBI-009 DoD-0 (S-1): active run steer returns accepted immediately, publishes control, and ack steered updates to applied', async () => {
    const receiptUpdates: HarnessReceipt[] = [];
    const h = makeHandlerHarness({
      onReceiptChanged: (_tid, receipt) => receiptUpdates.push(receipt),
    });

    const firstReceipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Focus on the login flow' },
      transport: 'socket',
    });

    // Returns accepted immediately before actor ack
    expect(firstReceipt.commandId).toBe(CMD_1);
    expect(firstReceipt.kind).toBe('steer');
    expect(firstReceipt.status).toBe('accepted');
    expect(firstReceipt.runId).toBe(ACTIVE_RUN_ID);
    expect(h.publishedControls).toHaveLength(1);
    expect(h.publishedControls[0]).toMatchObject({
      kind: 'steer',
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      text: 'Focus on the login flow',
    });

    // Actor acks steered -> updates stored row to applied
    const ack: HarnessControlAck = {
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      kind: 'steer',
      disposition: 'steered',
      timestamp: new Date().toISOString(),
    };
    await h.handler.handleControlAck(ack);

    const stored = await h.mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(stored?.status).toBe('applied');
    expect(receiptUpdates[receiptUpdates.length - 1]?.status).toBe('applied');
  });

  it('TBI-009 DoD-0 (S-3 & S-4): held ack keeps accepted until subsequent steered ack; merged ack updates directly to applied', async () => {
    const h = makeHandlerHarness();

    // S-3: held during summarizing -> stays accepted, then steered -> applied
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Hold until summary completes' },
      transport: 'socket',
    });
    await h.handler.handleControlAck({
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      kind: 'steer',
      disposition: 'held',
      timestamp: new Date().toISOString(),
    });
    expect((await h.mem.repo.findByCommandId(THREAD_ID, CMD_1))?.status).toBe('accepted');

    await h.handler.handleControlAck({
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      kind: 'steer',
      disposition: 'steered',
      timestamp: new Date().toISOString(),
    });
    expect((await h.mem.repo.findByCommandId(THREAD_ID, CMD_1))?.status).toBe('applied');

    // S-4: merged while agent acquiring -> applied
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_2, kind: 'steer', text: 'Merge into initial prompt' },
      transport: 'socket',
    });
    await h.handler.handleControlAck({
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_2,
      kind: 'steer',
      disposition: 'merged',
      timestamp: new Date().toISOString(),
    });
    expect((await h.mem.repo.findByCommandId(THREAD_ID, CMD_2))?.status).toBe('applied');
  });

  // ── VT-02 / PBI-004 AC-1 / TBI-009 DoD-1 & DoD-3 (S-6) ─────────────────────

  it('VT-02 / PBI-004 AC-1 / TBI-009 DoD-1 & DoD-3 (S-6): 6th steer is rejected, stored, and repeated commandId returns identical receipt without calling control bus', async () => {
    const h = makeHandlerHarness();

    for (const cmdId of [CMD_1, CMD_2, CMD_3, CMD_4, CMD_5]) {
      const r = await h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: { commandId: cmdId, kind: 'steer', text: `Steer ${cmdId}` },
        transport: 'socket',
      });
      expect(r.status).toBe('accepted');
      await h.handler.handleControlAck({
        threadId: THREAD_ID,
        runId: ACTIVE_RUN_ID,
        commandId: cmdId,
        kind: 'steer',
        disposition: 'steered',
        timestamp: new Date().toISOString(),
      });
    }
    expect(h.publishedControls).toHaveLength(5);

    // 6th steer rejected and stored
    const sixth = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_6, kind: 'steer', text: 'Sixth steer' },
      transport: 'socket',
    });
    expect(sixth.status).toBe('rejected');
    expect(sixth.reason).toBe('Wait for this step to finish');
    expect(h.publishedControls).toHaveLength(5);

    const storedSixth = await h.mem.repo.findByCommandId(THREAD_ID, CMD_6);
    expect(storedSixth?.status).toBe('rejected');
    expect(storedSixth?.reason).toBe('Wait for this step to finish');

    // Repeat same commandId -> returns identical stored receipt, no actor/control call
    const repeat = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_6, kind: 'steer', text: 'Sixth steer' },
      transport: 'http',
    });
    expect(repeat).toEqual(sixth);
    expect(h.publishedControls).toHaveLength(5);
  });

  // ── VT-03 / PBI-004 AC-2 / TBI-009 DoD-0 (S-2) ─────────────────────────────

  it('VT-03 / PBI-004 AC-2 / TBI-009 DoD-0 (S-2a): steer with no active run admits new send with turnId=commandId and returns queued', async () => {
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });

    const receipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Send as follow-up' },
      transport: 'socket',
    });

    expect(receipt.status).toBe('queued');
    expect(receipt.reason).toBe('Turn had finished, sent as a new message');
    expect(receipt.runId).toBe(NEW_RUN_ID);
    expect(h.admitMock).toHaveBeenCalledTimes(1);
    expect(h.admitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: CMD_1,
        threadId: THREAD_ID,
        userId: USER_ID,
        text: 'Send as follow-up',
      }),
    );
    expect(h.publishedControls).toHaveLength(0);
  });

  it('VT-03 / PBI-004 AC-2 / TBI-009 DoD-0 (S-2b): steer when actor acks turn-ended admits new send with turnId=commandId and updates receipt to queued', async () => {
    const h = makeHandlerHarness();

    const first = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Late steer after finish' },
      transport: 'socket',
    });
    expect(first.status).toBe('accepted');

    await h.handler.handleControlAck({
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      kind: 'steer',
      disposition: 'turn-ended',
      timestamp: new Date().toISOString(),
    });

    expect(h.admitMock).toHaveBeenCalledTimes(1);
    expect(h.admitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: CMD_1,
        threadId: THREAD_ID,
        userId: USER_ID,
        text: 'Late steer after finish',
      }),
    );
    const updated = await h.mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(updated?.status).toBe('queued');
    expect(updated?.reason).toBe('Turn had finished, sent as a new message');
    expect(updated?.runId).toBe(NEW_RUN_ID);
  });

  // ── VT-04 / PBI-004 AC-3 / TBI-009 DoD-2 ───────────────────────────────────

  it('VT-04 / PBI-004 AC-3 / TBI-009 DoD-2: read-only user steer is rejected, writes no row, makes no downstream call, and repeat re-checks access', async () => {
    const h = makeHandlerHarness({
      threadAccess: 'read',
      canWrite: false,
    });

    const r1 = await h.handler.handle({
      userId: OTHER_USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Unauthorized steer' },
      transport: 'socket',
    });
    expect(r1.status).toBe('rejected');
    expect(r1.reason).toBe('You have read-only access to this chat');
    expect(h.mem.rows.size).toBe(0);
    expect(h.publishedControls).toHaveLength(0);
    expect(h.admitMock).not.toHaveBeenCalled();

    // Repeat with same commandId re-checks access (still denied)
    const r2 = await h.handler.handle({
      userId: OTHER_USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Unauthorized steer' },
      transport: 'http',
    });
    expect(r2.status).toBe('rejected');
    expect(r2.reason).toBe('You have read-only access to this chat');
    expect(h.canWriteThreadMock).toHaveBeenCalledTimes(2);
    expect(h.mem.rows.size).toBe(0);

    // If write access is later granted, retrying same commandId now succeeds
    h.setAccess({ canWrite: true });
    const r3 = await h.handler.handle({
      userId: OTHER_USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Now authorized steer' },
      transport: 'http',
    });
    expect(r3.status).toBe('accepted');
    expect(h.mem.rows.size).toBe(1);
  });

  it('VT-04 (Brainstorm access): canCommandThread requires owner + brainstorm:create for brainstorm area', async () => {
    const brainstormProfile = getAreaProfile('brainstorm');
    const brainstormThread = makeThread({ harnessArea: 'brainstorm' });

    // Owner with brainstorm:create -> allowed
    await expect(
      canCommandThread(
        USER_ID,
        { access: 'owner', thread: brainstormThread },
        brainstormProfile,
        {
          canWriteThread: jest.fn().mockResolvedValue(false), // Brainstorm does not use canWriteThread
          getUserPermissions: jest.fn().mockResolvedValue(new Set(['brainstorm:create'])),
        },
      ),
    ).resolves.toBe(true);

    // Non-owner (read) even with brainstorm:create -> denied
    await expect(
      canCommandThread(
        OTHER_USER_ID,
        { access: 'read', thread: brainstormThread },
        brainstormProfile,
        {
          canWriteThread: jest.fn().mockResolvedValue(true),
          getUserPermissions: jest.fn().mockResolvedValue(new Set(['brainstorm:create'])),
        },
      ),
    ).resolves.toBe(false);

    // Owner without brainstorm:create -> denied
    await expect(
      canCommandThread(
        USER_ID,
        { access: 'owner', thread: brainstormThread },
        brainstormProfile,
        {
          canWriteThread: jest.fn().mockResolvedValue(true),
          getUserPermissions: jest.fn().mockResolvedValue(new Set(['brainstorm:view'])),
        },
      ),
    ).resolves.toBe(false);
  });

  // ── VT-07 / TBI-009 DoD-0 (S-5) ────────────────────────────────────────────

  it('VT-07 / TBI-009 DoD-0 (S-5): steer when another turn of thread is queued ahead admits follow-up with reason Queued as follow-up', async () => {
    const h = makeHandlerHarness({
      runState: { activeRunId: ACTIVE_RUN_ID, hasQueuedTurn: true, activeRunStatus: 'queued' },
    });

    const receipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Follow up after queued turn' },
      transport: 'socket',
    });

    expect(receipt.status).toBe('queued');
    expect(receipt.reason).toBe('Queued as follow-up');
    expect(receipt.runId).toBe(NEW_RUN_ID);
    expect(h.admitMock).toHaveBeenCalledTimes(1);
    expect(h.admitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: CMD_1,
        text: 'Follow up after queued turn',
      }),
    );
    expect(h.publishedControls).toHaveLength(0);
    // Queued steers do NOT count toward the 5-steer active run cap
    expect(await h.mem.repo.countActiveSteersForRun(THREAD_ID, ACTIVE_RUN_ID)).toBe(0);
  });

  // ── VT-09 / PBI-005 AC-1 ───────────────────────────────────────────────────

  it('VT-09 / PBI-005 AC-1: cancel without ack after 2 s updates receipt to rejected Stop did not reach the agent while cancelRequested stays set', async () => {
    jest.useFakeTimers();
    const receiptUpdates: HarnessReceipt[] = [];
    const h = makeHandlerHarness({
      onReceiptChanged: (_tid, r) => receiptUpdates.push(r),
      cancelConfirmTimeoutMs: 2_000,
    });

    const receipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'cancel' },
      transport: 'socket',
    });

    expect(receipt.status).toBe('accepted');
    expect(receipt.runId).toBe(ACTIVE_RUN_ID);
    expect(h.cancelRunMock).toHaveBeenCalledWith(THREAD_ID);
    expect(h.publishedControls).toHaveLength(1);
    expect(h.publishedControls[0]).toMatchObject({
      kind: 'cancel',
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
    });

    // Advance 2 seconds with no cancel ack
    await jest.advanceTimersByTimeAsync(2_000);

    const stored = await h.mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(stored?.status).toBe('rejected');
    expect(stored?.reason).toBe('Stop did not reach the agent');
    expect(receiptUpdates[receiptUpdates.length - 1]).toMatchObject({
      commandId: CMD_1,
      status: 'rejected',
      reason: 'Stop did not reach the agent',
    });
    // cancelRun was invoked once to set cancelRequested and never undone
    expect(h.cancelRunMock).toHaveBeenCalledTimes(1);
    h.handler.dispose();
  });

  it('VT-09 (ack before timeout): cancel ack within 2 s updates receipt to applied and cancels the timeout timer', async () => {
    jest.useFakeTimers();
    const h = makeHandlerHarness({ cancelConfirmTimeoutMs: 2_000 });

    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'cancel' },
      transport: 'socket',
    });

    await h.handler.handleControlAck({
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      kind: 'cancel',
      disposition: 'cancelled',
      timestamp: new Date().toISOString(),
    });

    await jest.advanceTimersByTimeAsync(3_000);

    const stored = await h.mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(stored?.status).toBe('applied');
    expect(stored?.reason).toBeNull();
    h.handler.dispose();
  });

  // ── VT-10 / PBI-005 AC-2 ───────────────────────────────────────────────────

  it('VT-10 / PBI-005 AC-2: cancel when turn already finished returns applied Turn had already finished with no cancelRun or control call', async () => {
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });

    const receipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'cancel' },
      transport: 'socket',
    });

    expect(receipt.status).toBe('applied');
    expect(receipt.reason).toBe('Turn had already finished');
    expect(h.cancelRunMock).not.toHaveBeenCalled();
    expect(h.publishedControls).toHaveLength(0);
  });

  // ── VT-11 / PBI-005 AC-3 ───────────────────────────────────────────────────

  it('VT-11 / PBI-005 AC-3: read-only user cancel is rejected, run keeps running, and no row is written', async () => {
    const h = makeHandlerHarness({
      threadAccess: 'read',
      canWrite: false,
    });

    const receipt = await h.handler.handle({
      userId: OTHER_USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'cancel' },
      transport: 'socket',
    });

    expect(receipt.status).toBe('rejected');
    expect(receipt.reason).toBe('You have read-only access to this chat');
    expect(h.cancelRunMock).not.toHaveBeenCalled();
    expect(h.publishedControls).toHaveLength(0);
    expect(h.mem.rows.size).toBe(0);
  });

  // ── VT-15 / PBI-006 AC-3 ───────────────────────────────────────────────────

  it('VT-15 / PBI-006 AC-3: read-only user summarize is rejected with no admit and no row written', async () => {
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
      threadAccess: 'read',
      canWrite: false,
    });

    const receipt = await h.handler.handle({
      userId: OTHER_USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'summarize' },
      transport: 'http',
    });

    expect(receipt.status).toBe('rejected');
    expect(receipt.reason).toBe('You have read-only access to this chat');
    expect(h.admitMock).not.toHaveBeenCalled();
    expect(h.mem.rows.size).toBe(0);
  });

  // ── VT-16 / PBI-006 ────────────────────────────────────────────────────────

  it('VT-16 / PBI-006: summarize while turn is running is rejected with Wait for this reply to finish; idle summarize admits operation run', async () => {
    const h = makeHandlerHarness();

    const rejected = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'summarize' },
      transport: 'socket',
    });

    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('Wait for this reply to finish');
    expect(h.admitMock).not.toHaveBeenCalled();

    // When thread becomes idle, summarize succeeds with operation: 'summarize'
    h.setAccess({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });

    const accepted = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_2, kind: 'summarize' },
      transport: 'socket',
    });

    expect(accepted.status).toBe('accepted');
    expect(accepted.runId).toBe(NEW_RUN_ID);
    expect(h.admitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: CMD_2,
        threadId: THREAD_ID,
        userId: USER_ID,
        text: '',
        operation: 'summarize',
        harness: expect.objectContaining({
          area: 'agent-home',
          operation: 'summarize',
        }),
      }),
    );
  });

  // ── VT-25 / PBI-008 AC-2 / TBI-009 DoD-1 ───────────────────────────────────

  it('VT-25 / PBI-008 AC-2 / TBI-009 DoD-1: concurrent duplicate commandId admits once and returns the same receipt to both callers', async () => {
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });

    // Delay admit slightly so both concurrent calls race on insertIfAbsent
    h.admitMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                turnId: CMD_1,
                runId: NEW_RUN_ID,
                status: 'queued',
                interactiveClass: 'fast',
              }),
            10,
          ),
        ),
    );

    const body: HarnessCommandBody = {
      commandId: CMD_1,
      kind: 'send',
      text: 'Hello concurrent world',
    };

    const [r1, r2] = await Promise.all([
      h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body,
        transport: 'socket',
      }),
      h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body,
        transport: 'http',
      }),
    ]);

    expect(h.admitMock).toHaveBeenCalledTimes(1);
    expect(h.mem.rows.size).toBe(1);
    expect(r1).toEqual(r2);
    expect(r1.commandId).toBe(CMD_1);
    expect(r1.status).toBe('accepted');
    expect(r1.runId).toBe(NEW_RUN_ID);
  });

  it('TBI-009 DoD-1 (conflict & purged dedupe): mismatched payload/kind for existing commandId returns Command id already used without altering row; purged payload still dedupes', async () => {
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });

    const first = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'send', text: 'Original message' },
      transport: 'socket',
    });
    expect(first.status).toBe('accepted');

    // Different text with same commandId -> rejected, stored row unchanged
    const conflictText = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'send', text: 'Tampered different message' },
      transport: 'http',
    });
    expect(conflictText.status).toBe('rejected');
    expect(conflictText.reason).toBe('Command id already used');
    expect((await h.mem.repo.findByCommandId(THREAD_ID, CMD_1))?.status).toBe('accepted');

    // Different kind with same commandId -> rejected, stored row unchanged
    const conflictKind = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'cancel' },
      transport: 'http',
    });
    expect(conflictKind.status).toBe('rejected');
    expect(conflictKind.reason).toBe('Command id already used');
    expect((await h.mem.repo.findByCommandId(THREAD_ID, CMD_1))?.kind).toBe('send');

    // Simulate 24h payload purge (payload = null) -> retry still returns original receipt
    const row = h.mem.rows.get(`${THREAD_ID}:${CMD_1}`)!;
    row.payload = null;
    const afterPurge = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'send', text: 'Original message' },
      transport: 'http',
    });
    expect(afterPurge.status).toBe('accepted');
    expect(afterPurge.runId).toBe(NEW_RUN_ID);
    expect(h.admitMock).toHaveBeenCalledTimes(1);
  });

  // ── VT-26 / PBI-008 AC-3 ───────────────────────────────────────────────────

  it('VT-26 / PBI-008 AC-3: command exists as accepted, write access is revoked, retry same commandId is rejected and stored row stays unchanged', async () => {
    const h = makeHandlerHarness();

    // First send succeeds and stores row as accepted
    const initial = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Initial steer' },
      transport: 'socket',
    });
    expect(initial.status).toBe('accepted');

    // Write access is removed while user is offline
    h.setAccess({ canWrite: false });

    const retried = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Initial steer' },
      transport: 'http',
    });

    expect(retried.status).toBe('rejected');
    expect(retried.reason).toBe('You have read-only access to this chat');
    expect(h.publishedControls).toHaveLength(1); // Not re-published
    // Stored row unchanged
    const stored = await h.mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(stored?.status).toBe('accepted');
    expect(stored?.reason).toBeNull();
  });

  // ── VT-51 / TBI-009 NFR (zero text logging + chat.harness.command telemetry) ─

  it('VT-51 / TBI-009 NFR: secret text never appears in console.* or trackEvent across send/steer/summarize/cancel, while commandId appears in chat.harness.command', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const secretSteer = 'SUPER-SECRET-STEER-TOKEN-987654';
    const secretMessage = 'SUPER-SECRET-MESSAGE-BODY-123456';

    const h = makeHandlerHarness();

    // Steer
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: secretSteer },
      transport: 'socket',
    });
    // Cancel
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_2, kind: 'cancel' },
      transport: 'socket',
    });
    // Switch to idle for send & summarize
    h.setAccess({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });
    // Send
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_3, kind: 'send', text: secretMessage },
      transport: 'http',
    });
    // Summarize
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_4, kind: 'summarize' },
      transport: 'socket',
    });
    // Error path: ensure error logging records commandId only and never leaks user text
    h.admitMock.mockRejectedValueOnce(new Error(`boom: ${secretMessage}`));
    await expect(
      h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: { commandId: CMD_5, kind: 'send', text: secretMessage },
        transport: 'http',
      }),
    ).rejects.toThrow();
    h.handler.dispose();

    const allLogs = JSON.stringify([
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]);
    const allTelemetry = JSON.stringify(h.telemetryEvents);

    expect(allLogs).not.toContain(secretSteer);
    expect(allLogs).not.toContain(secretMessage);
    expect(allLogs).toContain(CMD_5);
    expect(allTelemetry).not.toContain(secretSteer);
    expect(allTelemetry).not.toContain(secretMessage);

    const commandEvents = h.telemetryEvents.filter((e) => e.name === 'chat.harness.command');
    expect(commandEvents).toHaveLength(4);
    expect(commandEvents.map((e) => e.props?.commandId)).toEqual([CMD_1, CMD_2, CMD_3, CMD_4]);
    for (const evt of commandEvents) {
      expect(evt.props).toEqual(
        expect.objectContaining({
          area: 'agent-home',
          kind: expect.any(String),
          status: expect.any(String),
          reasonCode: expect.any(String),
          transport: expect.stringMatching(/^(socket|http)$/),
          commandId: expect.any(String),
        }),
      );
      expect(typeof evt.measurements?.latencyMs).toBe('number');
    }
  });

  // ── Validation, retry, TURN_ID_CONFLICT, ADO tool grant, attachment sanitization ─

  it('validates command body, missing thread, retry command, and TURN_ID_CONFLICT from admit', async () => {
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });

    // Invalid body -> 400
    await expect(
      h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: { commandId: 'not-a-uuid', kind: 'steer', text: '' },
        transport: 'http',
      }),
    ).rejects.toMatchObject({
      name: 'HarnessCommandError',
      code: 'invalid-command',
      statusCode: 400,
    });

    // Too many attachments (> 5) -> 400
    const sixAttachments: ChatAttachment[] = Array.from({ length: 6 }, (_, i) => ({
      id: `att-${i}`,
      name: `file-${i}.txt`,
      type: 'text/plain',
      size: 10,
      content: 'hello',
    }));
    await expect(
      h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: { commandId: CMD_1, kind: 'send', text: 'too many', attachments: sixAttachments },
        transport: 'http',
      }),
    ).rejects.toBeInstanceOf(HarnessCommandError);

    // Retry command -> calls durable retry
    const retryReceipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_2, kind: 'retry', runId: FAILED_RUN_ID },
      transport: 'socket',
    });
    expect(retryReceipt.status).toBe('accepted');
    expect(retryReceipt.runId).toBe(NEW_RUN_ID);
    expect(h.retryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        runId: FAILED_RUN_ID,
        userId: USER_ID,
      }),
    );

    // TURN_ID_CONFLICT from admit -> rejected receipt Command id already used
    h.admitMock.mockRejectedValueOnce(new DurableInteractiveTurnError('TURN_ID_CONFLICT', 409));
    const conflictReceipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_3, kind: 'send', text: 'Conflict turn' },
      transport: 'socket',
    });
    expect(conflictReceipt.status).toBe('rejected');
    expect(conflictReceipt.reason).toBe('Command id already used');

    // Missing thread -> 404
    h.setAccess({ thread: null });
    await expect(
      h.handler.handle({
        userId: USER_ID,
        threadId: THREAD_ID,
        body: { commandId: CMD_4, kind: 'cancel' },
        transport: 'http',
      }),
    ).rejects.toMatchObject({
      name: 'HarnessCommandError',
      code: 'thread-not-found',
      statusCode: 404,
    });
  });

  it('toolGrantResolver returns Sign in again to continue when ADO token is required and absent, and handler writes no row', async () => {
    const missingTokenResult = await resolveHarnessToolGrant(
      {
        userId: USER_ID,
        projectId: 'Apex',
        area: 'calendar-work-item',
        requestToken: null,
      },
      {
        getStoredAdoToken: jest.fn().mockResolvedValue(null),
      },
    );
    expect(missingTokenResult).toEqual({
      ok: false,
      reason: 'Sign in again to continue',
    });

    // When token is available, returns encrypted grant
    const fakeGrant: FrozenInteractiveToolGrant = {
      userId: USER_ID,
      projectId: 'Apex',
      allowedOperations: ['ado:read', 'ado:write'],
      expiresAt: '2026-11-19T01:00:00.000Z',
      encryptedAdoToken: {
        algorithm: 'aes-256-gcm',
        iv: 'iv',
        ciphertext: 'ct',
        authTag: 'tag',
      },
    };
    const okResult = await resolveHarnessToolGrant(
      {
        userId: USER_ID,
        projectId: 'Apex',
        area: 'cab-release',
        requestToken: 'delegated-token-abc',
      },
      {
        getStoredAdoToken: jest.fn().mockResolvedValue(null),
        encryptToolGrant: jest.fn().mockReturnValue(fakeGrant),
      },
    );
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.toolGrant).toEqual(fakeGrant);
    }

    // Handler rejects with Sign in again to continue and writes NO row so HTTP resend works
    const h = makeHandlerHarness({
      thread: makeThread({ harnessArea: 'calendar-work-item', status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
      toolGrantResult: { ok: false, reason: 'Sign in again to continue' },
    });

    const receipt = await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'send', text: 'Update work item 123' },
      transport: 'socket',
    });
    expect(receipt.status).toBe('rejected');
    expect(receipt.reason).toBe('Sign in again to continue');
    expect(h.mem.rows.size).toBe(0);
    expect(h.admitMock).not.toHaveBeenCalled();
  });

  it('sanitizes send attachment payloads to attachmentIds only and validates attachment bounds', async () => {
    expect(MAX_CHAT_ATTACHMENTS).toBe(5);

    const attachments: ChatAttachment[] = [
      {
        id: 'att-1',
        name: 'secret.png',
        type: 'image/png',
        size: 128,
        content: 'BASE64_SECRET_IMAGE_BYTES_SHOULD_NOT_BE_STORED',
        encoding: 'base64',
      },
    ];
    const validated = validateHarnessAttachments(attachments);
    expect(validated.ok).toBe(true);

    const payload = sanitizeCommandPayload({
      commandId: CMD_1,
      kind: 'send',
      text: 'See image',
      attachments,
    });
    expect(payload).toMatchObject({
      text: 'See image',
      attachmentIds: ['att-1'],
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('BASE64_SECRET_IMAGE_BYTES_SHOULD_NOT_BE_STORED');
    expect(payload).not.toHaveProperty('attachments');

    // Verify handler persists sanitized payload via repository
    const h = makeHandlerHarness({
      thread: makeThread({ status: 'idle', activeRunId: undefined }),
      runState: { activeRunId: null, hasQueuedTurn: false, activeRunStatus: null },
    });
    await h.handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'send', text: 'See image', attachments },
      transport: 'http',
    });
    const stored = await h.mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(stored?.payload).toMatchObject({ attachmentIds: ['att-1'] });
    expect(JSON.stringify(stored?.payload)).not.toContain('BASE64_SECRET_IMAGE_BYTES_SHOULD_NOT_BE_STORED');
  });

  it('builds and loads text-free HarnessThreadState via chatHarnessStateFrame', async () => {
    const state = buildHarnessThreadState({
      thread: {
        status: 'running',
        activeRunId: ACTIVE_RUN_ID,
        harnessArea: 'prd-assistant',
      },
      pendingCommands: [
        { commandId: CMD_1, kind: 'steer', status: 'accepted' },
      ],
      latestSummary: {
        id: 'sum-1',
        source: 'user',
        fallback: false,
        createdAt: '2026-11-19T00:05:00.000Z',
      },
      canWrite: true,
    });

    expect(state).toEqual({
      threadStatus: 'running',
      activeRunId: ACTIVE_RUN_ID,
      phase: 'running',
      harnessArea: 'prd-assistant',
      pendingCommands: [{ commandId: CMD_1, kind: 'steer', status: 'accepted' }],
      latestSummary: {
        id: 'sum-1',
        source: 'user',
        fallback: false,
        createdAt: '2026-11-19T00:05:00.000Z',
      },
      canWrite: true,
    });

    // Summarize pending command derives phase 'summarizing'
    const summarizing = buildHarnessThreadState({
      thread: {
        status: 'running',
        activeRunId: ACTIVE_RUN_ID,
        harnessArea: 'agent-home',
      },
      pendingCommands: [
        { commandId: CMD_2, kind: 'summarize', status: 'accepted' },
      ],
      latestSummary: null,
    });
    expect(summarizing.phase).toBe('summarizing');

    // loadHarnessThreadState returns null when thread missing, or assembled state when present
    const missing = await loadHarnessThreadState(THREAD_ID, {
      loadThreadSummaryRow: async () => null,
      listPendingCommands: async () => [],
      getLatestSummaryMarker: async () => null,
    });
    expect(missing).toBeNull();

    const loaded = await loadHarnessThreadState(THREAD_ID, {
      loadThreadSummaryRow: async () => ({
        status: 'idle',
        activeRunId: null,
        harnessArea: 'interview',
      }),
      listPendingCommands: async () => [],
      getLatestSummaryMarker: async () => ({
        id: 'sum-2',
        source: 'auto',
        fallback: true,
        createdAt: '2026-11-19T00:10:00.000Z',
      }),
    });
    expect(loaded).toEqual({
      threadStatus: 'idle',
      activeRunId: null,
      phase: 'idle',
      harnessArea: 'interview',
      pendingCommands: [],
      latestSummary: {
        id: 'sum-2',
        source: 'auto',
        fallback: true,
        createdAt: '2026-11-19T00:10:00.000Z',
      },
    });
  });

  it('exports createChatHarnessCommandRepository factory with listPendingControlForRun semantics', () => {
    const repo = createChatHarnessCommandRepository();
    expect(typeof repo.insertIfAbsent).toBe('function');
    expect(typeof repo.findByCommandId).toBe('function');
    expect(typeof repo.updateReceipt).toBe('function');
    expect(typeof repo.countActiveSteersForRun).toBe('function');
    expect(typeof repo.listPendingCommands).toBe('function');
    expect(typeof repo.listPendingControlForRun).toBe('function');
  });

  it('auto-subscribes to controlBus.subscribeAck on steer publish and transitions receipt to applied', async () => {
    const ackListeners = new Map<string, (ack: HarnessControlAck) => void>();
    const unsubscribe = jest.fn();
    const { handler, mem } = makeHandlerHarness({
      runState: {
        activeRunId: ACTIVE_RUN_ID,
        hasQueuedTurn: false,
        activeRunStatus: 'running',
      },
      subscribeAck: (threadId, cb) => {
        ackListeners.set(threadId, cb);
        return unsubscribe;
      },
    });

    const receipt = await handler.handle({
      userId: 'user-1',
      threadId: THREAD_ID,
      body: { commandId: CMD_1, kind: 'steer', text: 'Focus on the checklist' },
      transport: 'socket',
    });

    expect(receipt.status).toBe('accepted');
    expect(ackListeners.has(THREAD_ID)).toBe(true);

    ackListeners.get(THREAD_ID)!({
      threadId: THREAD_ID,
      runId: ACTIVE_RUN_ID,
      commandId: CMD_1,
      kind: 'steer',
      disposition: 'steered',
      timestamp: '2026-11-19T00:01:00.000Z',
    });

    await new Promise((r) => setImmediate(r));
    const updated = await mem.repo.findByCommandId(THREAD_ID, CMD_1);
    expect(updated?.status).toBe('applied');

    handler.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
