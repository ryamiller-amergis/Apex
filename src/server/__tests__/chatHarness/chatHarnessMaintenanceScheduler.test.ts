/**
 * W4-A / S9 — Chat harness maintenance scheduler tests (TBI-013).
 *
 * Covers:
 *  - TBI-013 DoD-0: Row older than 24 hours has payload nulled after job runs
 *  - TBI-013 DoD-1: Row younger than 24 hours keeps its payload
 *  - TBI-013 DoD-2: Purged row id, kind, status stay readable and still dedupe retries
 *  - VT-44: 25h row purged, 23h row kept, batched purge, logs counts only (no payload text)
 *  - VT-45: Retrying purged commandId returns original receipt and applies nothing twice
 *  - VT-46: Stale accepted steer (>60s, no active run) becomes queued follow-up under same
 *           commandId; stale accepted summarize/cancel becomes rejected 'Did not reach the agent'
 */
import type { ChatThread } from '../../../shared/types/chat';
import type { HarnessReceipt } from '../../../shared/types/chatHarness';
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
  CHAT_HARNESS_MAINTENANCE_INTERVAL_MS,
  createChatHarnessMaintenanceScheduler,
  runChatHarnessMaintenanceTick,
} from '../../services/chatHarness/chatHarnessMaintenanceScheduler';

const THREAD_ID = '10000000-0000-4000-8000-000000000101';
const USER_ID = '20000000-0000-4000-8000-000000000202';
const RUN_OLD = '30000000-0000-4000-8000-000000000303';
const RUN_FOLLOWUP = '30000000-0000-4000-8000-000000000404';

const CMD_OLD = '40000000-0000-4000-8000-000000000011';
const CMD_YOUNG = '40000000-0000-4000-8000-000000000012';
const CMD_STALE_STEER = '40000000-0000-4000-8000-000000000013';
const CMD_FRESH_STEER = '40000000-0000-4000-8000-000000000014';
const CMD_STALE_SUMMARIZE = '40000000-0000-4000-8000-000000000015';
const CMD_STALE_CANCEL = '40000000-0000-4000-8000-000000000016';

const NOW = new Date('2026-11-19T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function secondsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

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
    messages: [],
    workspaceDir: '/tmp/apex-maint',
    flagged: false,
    createdAt: hoursAgo(30),
    lastActivityAt: hoursAgo(1),
    ...overrides,
  };
}

function makeResolvedProfile(): ResolvedAreaProfile {
  const profile = getAreaProfile('agent-home');
  return {
    profile,
    project: 'Apex',
    settingsId: 'settings-1',
    skill: null,
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

function makeInMemoryStore(initialRows: ChatHarnessCommandRow[]) {
  const rows = new Map<string, ChatHarnessCommandRow>();
  let seq = 0;
  for (const row of initialRows) {
    rows.set(`${row.threadId}:${row.commandId}`, { ...row });
  }

  const repo: ChatHarnessCommandRepository = {
    async insertIfAbsent(input: InsertCommandInput) {
      const key = `${input.threadId}:${input.commandId}`;
      const existing = rows.get(key);
      if (existing) {
        return { inserted: false, row: { ...existing } };
      }
      seq += 1;
      const created: ChatHarnessCommandRow = {
        id: `row-gen-${seq}`,
        threadId: input.threadId,
        commandId: input.commandId,
        runId: input.runId ?? null,
        kind: input.kind,
        status: input.status,
        reason: input.reason ?? null,
        payload: input.payload ?? null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
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
      if (patch.expectedStatus && existing.status !== patch.expectedStatus) {
        return null;
      }
      const updated: ChatHarnessCommandRow = {
        ...existing,
        status: patch.status,
        reason: 'reason' in patch ? (patch.reason ?? null) : existing.reason,
        runId: 'runId' in patch ? (patch.runId ?? null) : existing.runId,
        updatedAt: NOW.toISOString(),
      };
      rows.set(key, updated);
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

  const purgePayloadBatch = jest.fn(async (cutoffIso: string, batchSize: number) => {
    const cutoffMs = Date.parse(cutoffIso);
    const eligible = [...rows.values()]
      .filter((r) => r.payload !== null && Date.parse(r.createdAt) < cutoffMs)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, batchSize);
    for (const row of eligible) {
      row.payload = null;
      row.updatedAt = NOW.toISOString();
    }
    return eligible.length;
  });

  const findStaleAcceptedCommands = jest.fn(
    async (cutoffIso: string, limit: number) => {
      const cutoffMs = Date.parse(cutoffIso);
      return [...rows.values()]
        .filter(
          (r) =>
            r.status === 'accepted' &&
            (r.kind === 'steer' || r.kind === 'summarize' || r.kind === 'cancel') &&
            Date.parse(r.updatedAt) < cutoffMs,
        )
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
  );

  return { rows, repo, purgePayloadBatch, findStaleAcceptedCommands };
}

describe('chatHarnessMaintenanceScheduler (S9 / TBI-013)', () => {
  it('VT-44 / DoD-0 / DoD-1: nulls payloads older than 24h in batches, keeps younger payloads, and logs counts only', async () => {
    const secretOldText = 'TOP-SECRET-OLD-PROMPT-DO-NOT-LOG';
    const secretYoungText = 'TOP-SECRET-YOUNG-PROMPT-KEEP';
    const store = makeInMemoryStore([
      {
        id: 'row-1',
        threadId: THREAD_ID,
        commandId: CMD_OLD,
        runId: RUN_OLD,
        kind: 'send',
        status: 'applied',
        reason: null,
        payload: { text: secretOldText, payloadHash: 'hash-old' },
        createdAt: hoursAgo(25),
        updatedAt: hoursAgo(25),
      },
      {
        id: 'row-2',
        threadId: THREAD_ID,
        commandId: CMD_YOUNG,
        runId: RUN_OLD,
        kind: 'send',
        status: 'applied',
        reason: null,
        payload: { text: secretYoungText, payloadHash: 'hash-young' },
        createdAt: hoursAgo(23),
        updatedAt: hoursAgo(23),
      },
    ]);

    const logs: string[] = [];
    const trackEvent = jest.fn();

    const result = await runChatHarnessMaintenanceTick({
      purgePayloadBatch: store.purgePayloadBatch,
      findStaleAcceptedCommands: store.findStaleAcceptedCommands,
      repository: store.repo,
      trackEvent,
      logInfo: (msg) => logs.push(msg),
      logError: (msg) => logs.push(msg),
      now: () => NOW,
      batchSize: 1, // Force multi-iteration batch loop
    });

    expect(result).toEqual({ payloadsCleared: 1, receiptsReconciled: 0 });
    // Batch size 1 with 1 eligible row -> called twice (first returns 1, second returns 0)
    expect(store.purgePayloadBatch).toHaveBeenCalledTimes(2);

    const oldRow = await store.repo.findByCommandId(THREAD_ID, CMD_OLD);
    expect(oldRow).not.toBeNull();
    expect(oldRow!.payload).toBeNull();
    expect(oldRow!.commandId).toBe(CMD_OLD);
    expect(oldRow!.kind).toBe('send');
    expect(oldRow!.status).toBe('applied');
    expect(oldRow!.runId).toBe(RUN_OLD);

    const youngRow = await store.repo.findByCommandId(THREAD_ID, CMD_YOUNG);
    expect(youngRow).not.toBeNull();
    expect(youngRow!.payload).toEqual({
      text: secretYoungText,
      payloadHash: 'hash-young',
    });

    // Telemetry and logs contain counts only, never payload text
    expect(trackEvent).toHaveBeenCalledWith(
      'chat.harness.maintenance',
      {},
      { payloadsCleared: 1, receiptsReconciled: 0 },
    );
    const joinedLogs = logs.join('\n');
    expect(joinedLogs).not.toContain(secretOldText);
    expect(joinedLogs).not.toContain(secretYoungText);
    expect(joinedLogs).toContain('1');
  });

  it('VT-45 / DoD-2 / PBI-008: retrying a purged commandId returns the original receipt without re-applying', async () => {
    const store = makeInMemoryStore([
      {
        id: 'row-1',
        threadId: THREAD_ID,
        commandId: CMD_OLD,
        runId: RUN_OLD,
        kind: 'send',
        status: 'applied',
        reason: null,
        payload: { text: 'Original prompt before purge', payloadHash: 'hash-old' },
        createdAt: hoursAgo(25),
        updatedAt: hoursAgo(25),
      },
    ]);

    await runChatHarnessMaintenanceTick({
      purgePayloadBatch: store.purgePayloadBatch,
      findStaleAcceptedCommands: store.findStaleAcceptedCommands,
      repository: store.repo,
      trackEvent: jest.fn(),
      logInfo: jest.fn(),
      now: () => NOW,
    });

    const purged = await store.repo.findByCommandId(THREAD_ID, CMD_OLD);
    expect(purged!.payload).toBeNull();

    const admitTurn = jest.fn();
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
      now: () => NOW,
    });

    const retryReceipt: HarnessReceipt = await handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: {
        commandId: CMD_OLD,
        kind: 'send',
        text: 'Original prompt before purge',
      },
      transport: 'http',
    });

    expect(retryReceipt.commandId).toBe(CMD_OLD);
    expect(retryReceipt.kind).toBe('send');
    expect(retryReceipt.status).toBe('applied');
    expect(retryReceipt.runId).toBe(RUN_OLD);
    expect(admitTurn).not.toHaveBeenCalled();

    // Reusing the same commandId with a DIFFERENT kind is still rejected
    const conflictReceipt = await handler.handle({
      userId: USER_ID,
      threadId: THREAD_ID,
      body: {
        commandId: CMD_OLD,
        kind: 'summarize',
      },
      transport: 'http',
    });
    expect(conflictReceipt.status).toBe('rejected');
    expect(conflictReceipt.reason).toBe('Command id already used');
    handler.dispose();
  });

  it('VT-46 / PBI-004: reconciles stale accepted steers as queued follow-ups under same commandId and rejects stale summarize/cancel', async () => {
    const steerText = 'SENSITIVE-STEER-CONTENT-NEVER-LOG';
    const store = makeInMemoryStore([
      {
        id: 'row-stale-steer',
        threadId: THREAD_ID,
        commandId: CMD_STALE_STEER,
        runId: RUN_OLD,
        kind: 'steer',
        status: 'accepted',
        reason: null,
        payload: { text: steerText, userId: USER_ID, payloadHash: 'h-steer' },
        createdAt: secondsAgo(95),
        updatedAt: secondsAgo(90),
      },
      {
        id: 'row-fresh-steer',
        threadId: THREAD_ID,
        commandId: CMD_FRESH_STEER,
        runId: RUN_OLD,
        kind: 'steer',
        status: 'accepted',
        reason: null,
        payload: { text: 'Fresh steer', userId: USER_ID, payloadHash: 'h-fresh' },
        createdAt: secondsAgo(30),
        updatedAt: secondsAgo(30),
      },
      {
        id: 'row-stale-summarize',
        threadId: THREAD_ID,
        commandId: CMD_STALE_SUMMARIZE,
        runId: RUN_OLD,
        kind: 'summarize',
        status: 'accepted',
        reason: null,
        payload: null,
        createdAt: secondsAgo(95),
        updatedAt: secondsAgo(90),
      },
      {
        id: 'row-stale-cancel',
        threadId: THREAD_ID,
        commandId: CMD_STALE_CANCEL,
        runId: RUN_OLD,
        kind: 'cancel',
        status: 'accepted',
        reason: null,
        payload: null,
        createdAt: secondsAgo(95),
        updatedAt: secondsAgo(90),
      },
    ]);

    const admitTurn = jest.fn(async () => ({
      runId: RUN_FOLLOWUP,
      threadId: THREAD_ID,
      status: 'queued' as const,
      turnId: CMD_STALE_STEER,
      interactiveClass: 'fast' as const,
    }));
    const logs: string[] = [];
    const trackEvent = jest.fn();

    const result = await runChatHarnessMaintenanceTick({
      purgePayloadBatch: store.purgePayloadBatch,
      findStaleAcceptedCommands: store.findStaleAcceptedCommands,
      repository: store.repo,
      loadThread: async () => makeThread(),
      resolveAreaProfile: async () => makeResolvedProfile(),
      admitTurn,
      trackEvent,
      logInfo: (msg) => logs.push(msg),
      logError: (msg) => logs.push(msg),
      now: () => NOW,
    });

    expect(result).toEqual({ payloadsCleared: 0, receiptsReconciled: 3 });

    // Stale steer admitted as follow-up send under the SAME commandId
    expect(admitTurn).toHaveBeenCalledTimes(1);
    expect(admitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: CMD_STALE_STEER,
        threadId: THREAD_ID,
        userId: USER_ID,
        text: steerText,
      }),
    );

    const reconciledSteer = await store.repo.findByCommandId(
      THREAD_ID,
      CMD_STALE_STEER,
    );
    expect(reconciledSteer!.status).toBe('queued');
    expect(reconciledSteer!.reason).toBe('Turn had finished, sent as a new message');
    expect(reconciledSteer!.runId).toBe(RUN_FOLLOWUP);

    // Fresh (<60s) steer untouched
    const freshSteer = await store.repo.findByCommandId(
      THREAD_ID,
      CMD_FRESH_STEER,
    );
    expect(freshSteer!.status).toBe('accepted');

    // Stale summarize and cancel rejected with 'Did not reach the agent'
    const reconciledSummarize = await store.repo.findByCommandId(
      THREAD_ID,
      CMD_STALE_SUMMARIZE,
    );
    expect(reconciledSummarize!.status).toBe('rejected');
    expect(reconciledSummarize!.reason).toBe('Did not reach the agent');

    const reconciledCancel = await store.repo.findByCommandId(
      THREAD_ID,
      CMD_STALE_CANCEL,
    );
    expect(reconciledCancel!.status).toBe('rejected');
    expect(reconciledCancel!.reason).toBe('Did not reach the agent');

    expect(trackEvent).toHaveBeenCalledWith(
      'chat.harness.maintenance',
      {},
      { payloadsCleared: 0, receiptsReconciled: 3 },
    );
    expect(logs.join('\n')).not.toContain(steerText);
  });

  it('enforces single-flight overlap protection and 15-minute schedule interval', async () => {
    expect(CHAT_HARNESS_MAINTENANCE_INTERVAL_MS).toBe(15 * 60 * 1000);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const purgeSpy = jest.fn(async () => {
      await firstGate;
      return 0;
    });

    const scheduler = createChatHarnessMaintenanceScheduler({
      purgePayloadBatch: purgeSpy,
      findStaleAcceptedCommands: async () => [],
      trackEvent: jest.fn(),
      logInfo: jest.fn(),
    });

    const first = scheduler.runNow();
    const overlapping = await scheduler.runNow();
    expect(overlapping).toBe(false);

    releaseFirst();
    expect(await first).toBe(true);
    expect(purgeSpy).toHaveBeenCalledTimes(1);

    scheduler.start();
    scheduler.stop();
  });
});
