/**
 * Unit tests for declarative server-side Chat Harness area lifecycle hooks
 * (`areaHooks.ts`) and their integration into `chatHarnessCommandHandler.ts`.
 */
import type { ChatThread } from '../../../shared/types/chat';
import type { HarnessAreaId } from '../../../shared/types/chatHarness';
import type { FrozenBrainstormArtifact } from '../../../shared/types/brainstormArtifact';
import type { FrozenBrainstormTurn } from '../../../shared/types/durableInteractiveTurn';
import type { ChatHarnessCommandRepository, ChatHarnessCommandRow } from '../../services/chatHarness/chatHarnessCommandRepository';
import { createChatHarnessCommandHandler } from '../../services/chatHarness/chatHarnessCommandHandler';
import {
  clearAreaHooksForTest,
  getAreaHooks,
  listRegisteredAreaHookIds,
  registerAreaHooks,
  type ChatHarnessAreaHooks,
} from '../../services/chatHarness/areaHooks';
import { getAreaProfile } from '../../services/chatHarness/areaProfiles';
import type { ResolvedAreaProfile } from '../../services/chatHarness/areaProfileResolver';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const CMD_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const PREV_RUN_ID = '44444444-4444-4444-8444-444444444444';

function makeThread(area: HarnessAreaId = 'prd-assistant'): ChatThread {
  return {
    id: THREAD_ID,
    userId: 'user-1',
    createdAt: '2026-11-19T12:00:00.000Z',
    lastActivityAt: '2026-11-19T12:00:00.000Z',
    flagged: false,
    status: 'idle',
    harnessArea: area,
    harnessVersion: 1,
    kickoff: {
      project: 'Apex',
      repo: 'Apex',
      branch: 'main',
      model: 'composer-2.5',
      skillPath: '/.cursor/skills/prd-assistant/SKILL.md',
    },
    messages: [],
    workspaceDir: '/tmp/thread-1',
  };
}

function makeResolvedProfile(area: HarnessAreaId): ResolvedAreaProfile {
  const profile = getAreaProfile(area);
  return {
    profile,
    project: 'Apex',
    settingsId: null,
    skill: {
      name: 'prd-assistant',
      path: '/.cursor/skills/prd-assistant/SKILL.md',
      source: 'project-setting',
    },
    model: 'composer-2.5',
    effort: 'low',
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

function makeInMemoryRepo(): ChatHarnessCommandRepository {
  const rows = new Map<string, ChatHarnessCommandRow>();
  const key = (threadId: string, commandId: string) => `${threadId}:${commandId}`;
  return {
    async insertIfAbsent(input) {
      const k = key(input.threadId, input.commandId);
      const existing = rows.get(k);
      if (existing) return { inserted: false, row: existing };
      const row: ChatHarnessCommandRow = {
        id: k,
        threadId: input.threadId,
        commandId: input.commandId,
        kind: input.kind,
        status: input.status,
        reason: input.reason ?? null,
        runId: input.runId ?? null,
        payload: input.payload ?? null,
        createdAt: '2026-11-19T12:00:00.000Z',
        updatedAt: '2026-11-19T12:00:00.000Z',
      };
      rows.set(k, row);
      return { inserted: true, row };
    },
    async findByCommandId(threadId, commandId) {
      return rows.get(key(threadId, commandId)) ?? null;
    },
    async updateReceipt(threadId, commandId, patch) {
      const k = key(threadId, commandId);
      const existing = rows.get(k);
      if (!existing) return null;
      if (patch.expectedStatus && existing.status !== patch.expectedStatus) return null;
      const updated: ChatHarnessCommandRow = {
        ...existing,
        status: patch.status,
        reason: patch.reason ?? existing.reason,
        runId: patch.runId !== undefined ? patch.runId : existing.runId,
        updatedAt: '2026-11-19T12:00:01.000Z',
      };
      rows.set(k, updated);
      return updated;
    },
    async countActiveSteersForRun() {
      return 0;
    },
    async listPendingCommands() {
      return [];
    },
    async listPendingControlForRun() {
      return [];
    },
  };
}

describe('areaHooks registry', () => {
  afterEach(() => {
    clearAreaHooksForTest();
  });

  it('registers, resolves, lists, and unregisters area hooks cleanly', () => {
    const hooks: ChatHarnessAreaHooks = {
      beforeSend: async () => ({ internalContext: 'extra' }),
    };
    const unregister = registerAreaHooks('prd-assistant', hooks);

    expect(getAreaHooks('prd-assistant')).toBe(hooks);
    expect(listRegisteredAreaHookIds()).toEqual(['prd-assistant']);

    unregister();
    expect(getAreaHooks('prd-assistant')).toBeUndefined();
    expect(listRegisteredAreaHookIds()).toEqual([]);
  });
});

describe('chatHarnessCommandHandler + areaHooks integration', () => {
  const buildHandler = (opts: {
    area?: HarnessAreaId;
    hooks?: ChatHarnessAreaHooks;
    admitTurn?: jest.Mock;
    retryTurn?: jest.Mock;
    cancelRun?: jest.Mock;
    runState?: { activeRunId: string | null; hasQueuedTurn: boolean };
  }) => {
    const area = opts.area ?? 'prd-assistant';
    const thread = makeThread(area);
    const admitTurn =
      opts.admitTurn ??
      jest.fn().mockResolvedValue({
        turnId: CMD_ID,
        runId: RUN_ID,
        status: 'queued',
        interactiveClass: 'agentic',
      });
    const retryTurn =
      opts.retryTurn ??
      jest.fn().mockResolvedValue({
        turnId: CMD_ID,
        runId: RUN_ID,
        status: 'queued',
        interactiveClass: 'agentic',
      });
    const cancelRun = opts.cancelRun ?? jest.fn().mockResolvedValue(undefined);

    const handler = createChatHarnessCommandHandler({
      repository: makeInMemoryRepo(),
      resolveThreadAccess: async () => ({
        thread,
        access: 'owner',
        project: 'Apex',
      }),
      canWriteThread: async () => true,
      getUserPermissions: async () =>
        new Set([getAreaProfile(area).permission, 'brainstorm:create']),
      resolveAreaProfile: async () => makeResolvedProfile(area),
      resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
      getThreadRunState: async () =>
        opts.runState ?? { activeRunId: null, hasQueuedTurn: false },
      admitTurn,
      retryTurn,
      cancelRun,
      controlBus: { publishControl: jest.fn().mockResolvedValue(undefined) },
      stampThreadHarness: async () => true,
      getAreaHooks: (requestedArea) =>
        requestedArea === area ? opts.hooks : undefined,
      trackEvent: jest.fn(),
    });

    return { handler, admitTurn, retryTurn, cancelRun };
  };

  it('enriches send admission with beforeSend overrides and calls afterSendAccepted', async () => {
    const afterSendAccepted = jest.fn();
    const brainstormPayload = {
      sessionId: 'sess-1',
      creatorContext: { displayName: 'Ryan', roles: [], groups: [], bio: null },
      artifact: {
        type: 'discovery_brief',
        version: 1,
        content: '# Brief',
      },
      intent: { kind: 'chat' },
    } as unknown as FrozenBrainstormTurn;

    const { handler, admitTurn } = buildHandler({
      area: 'brainstorm',
      hooks: {
        beforeSend: async () => ({
          internalContext: '# Current artifact\n- Version: 1',
          areaKeyContext: 'Brief v1',
          brainstorm: brainstormPayload,
          modelOverride: 'claude-sonnet-4-5',
        }),
        afterSendAccepted,
      },
    });

    const receipt = await handler.handle({
      userId: 'user-1',
      threadId: THREAD_ID,
      transport: 'socket',
      body: {
        kind: 'send',
        commandId: CMD_ID,
        text: 'Draft a quick scope',
      },
    });

    expect(receipt.status).toBe('accepted');
    expect(receipt.runId).toBe(RUN_ID);
    expect(admitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Draft a quick scope',
        modelOverride: 'claude-sonnet-4-5',
        internalContext: '# Current artifact\n- Version: 1',
        areaKeyContext: 'Brief v1',
        brainstorm: brainstormPayload,
      }),
    );
    expect(afterSendAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'brainstorm',
        threadId: THREAD_ID,
        commandId: CMD_ID,
        runId: RUN_ID,
      }),
    );
  });

  it('rejects send cleanly without calling admitTurn when beforeSend returns rejectReason', async () => {
    const { handler, admitTurn } = buildHandler({
      hooks: {
        beforeSend: async () => ({
          rejectReason: 'You have read-only access to this chat',
        }),
      },
    });

    const receipt = await handler.handle({
      userId: 'user-1',
      threadId: THREAD_ID,
      transport: 'http',
      body: {
        kind: 'send',
        commandId: CMD_ID,
        text: 'Should be rejected',
      },
    });

    expect(receipt.status).toBe('rejected');
    expect(receipt.reason).toBe('You have read-only access to this chat');
    expect(admitTurn).not.toHaveBeenCalled();
  });

  it('invokes beforeSend.onAdmissionFailed rollback when admitTurn throws', async () => {
    const onAdmissionFailed = jest.fn();
    const boom = new Error('admission down');
    const { handler } = buildHandler({
      admitTurn: jest.fn().mockRejectedValue(boom),
      hooks: {
        beforeSend: async () => ({
          internalContext: 'doc context',
          onAdmissionFailed,
        }),
      },
    });

    await expect(
      handler.handle({
        userId: 'user-1',
        threadId: THREAD_ID,
        transport: 'socket',
        body: {
          kind: 'send',
          commandId: CMD_ID,
          text: 'Hello',
        },
      }),
    ).rejects.toThrow('admission down');

    expect(onAdmissionFailed).toHaveBeenCalledWith(boom);
  });

  it('passes refreshedBrainstormArtifact from beforeRetry and calls afterRetryAccepted', async () => {
    const refreshedArtifact = {
      type: 'technical_design',
      version: 3,
      content: '# Design v3',
    } as unknown as FrozenBrainstormArtifact;
    const afterRetryAccepted = jest.fn();

    const { handler, retryTurn } = buildHandler({
      area: 'brainstorm',
      hooks: {
        beforeRetry: async () => ({
          refreshedBrainstormArtifact: refreshedArtifact,
        }),
        afterRetryAccepted,
      },
    });

    const receipt = await handler.handle({
      userId: 'user-1',
      threadId: THREAD_ID,
      transport: 'socket',
      body: {
        kind: 'retry',
        commandId: CMD_ID,
        runId: PREV_RUN_ID,
      },
    });

    expect(receipt.status).toBe('accepted');
    expect(retryTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        runId: PREV_RUN_ID,
        refreshedBrainstormArtifact: refreshedArtifact,
      }),
    );
    expect(afterRetryAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        targetRunId: PREV_RUN_ID,
        runId: RUN_ID,
      }),
    );
  });

  it('calls afterCancelAccepted when cancelling an active run', async () => {
    const afterCancelAccepted = jest.fn();
    const { handler, cancelRun } = buildHandler({
      runState: { activeRunId: PREV_RUN_ID, hasQueuedTurn: false },
      hooks: { afterCancelAccepted },
    });

    const receipt = await handler.handle({
      userId: 'user-1',
      threadId: THREAD_ID,
      transport: 'socket',
      body: {
        kind: 'cancel',
        commandId: CMD_ID,
      },
    });

    expect(receipt.status).toBe('accepted');
    expect(cancelRun).toHaveBeenCalledWith(THREAD_ID);
    expect(afterCancelAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'prd-assistant',
        activeRunId: PREV_RUN_ID,
      }),
    );
    handler.dispose();
  });

  it('runs beforeSend and afterSendAccepted when steer falls back to a follow-up send', async () => {
    const afterSendAccepted = jest.fn();
    const { handler, admitTurn } = buildHandler({
      runState: { activeRunId: null, hasQueuedTurn: false },
      hooks: {
        beforeSend: async (ctx) => {
          expect(ctx.fromSteerFollowUp).toBe(true);
          return { internalContext: 'fresh-doc-context' };
        },
        afterSendAccepted,
      },
    });

    const receipt = await handler.handle({
      userId: 'user-1',
      threadId: THREAD_ID,
      transport: 'socket',
      body: {
        kind: 'steer',
        commandId: CMD_ID,
        text: 'Follow up with section 2',
      },
    });

    expect(receipt.status).toBe('queued');
    expect(admitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        internalContext: 'fresh-doc-context',
      }),
    );
    expect(afterSendAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        fromSteerFollowUp: true,
      }),
    );
  });
});
