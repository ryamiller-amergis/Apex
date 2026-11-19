/**
 * W6-A / S12 — Release-gating per-area Chat Harness contract suite, recorded
 * SDK stream replay, forced-recreation replay test, and k6 load-check contract.
 *
 * Covers:
 *  - TBI-015 DoD-0..2: Table-driven contract over all 12 HARNESS_AREA_IDS ×
 *      send/stream, tool calls & write confirmation, steer, summarize (full +
 *      fallback), cancel, dropped connection + replay, resume, recreate, usage,
 *      and the 3 safety rules.
 *  - TBI-011 DoD-3 / PBI-007 AC-1 / VT-18: Forced recreation replay test
 *      (simulating 1.0.37 -> 1.4.0 agent_not_found) proving the recreated
 *      agent continues from bounded summary/context and never asks the user
 *      to repeat context.
 *  - VT-50: k6 load-test script contract (50 VUs / 500 ms receipt / 2000 ms
 *      snapshot thresholds) + receipt & snapshot latency budgets.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';

const mockFindFirst = jest.fn();
const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();
const mockNotifyRunEvent = jest.fn();
const mockTransition = jest.fn();
const mockMarkTerminal = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetCursorAgentId = jest.fn();
const mockSetCursorAgentId = jest.fn();
const mockRecordCursorChatUsage = jest.fn();
const mockWorkerInteractiveTurn = jest.fn();

jest.mock('../../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock('../../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'contract-test-instance',
  nextRunEventSequence: jest.fn().mockReturnValue(1),
  notifyRunEvent: (...args: unknown[]) => mockNotifyRunEvent(...args),
  notifyThreadCommand: jest.fn().mockResolvedValue(undefined),
  replayRunEventPage: jest.fn(),
  replayRunEvents: jest.fn(),
  subscribeRunEvents: jest.fn(() => () => {}),
  subscribeThreadCommands: jest.fn(() => () => {}),
}));

jest.mock('../../services/agentRunLifecycleService', () => ({
  transition: (...args: unknown[]) => mockTransition(...args),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));

jest.mock('../../services/telemetry', () => ({
  ...jest.requireActual('../../services/telemetry'),
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock('../../services/workerTierTelemetry', () => ({
  workerTierTelemetry: {
    inflight: jest.fn(),
    queueDepth: jest.fn(),
    queueOldestAge: jest.fn(),
    projectInflight: jest.fn(),
    admissionWait: jest.fn(),
    coldStart: jest.fn(),
    cancellation: jest.fn(),
    reaperAction: jest.fn(),
    terminalReason: jest.fn(),
    interactiveTurn: (...args: unknown[]) => mockWorkerInteractiveTurn(...args),
    interactiveFirstToken: jest.fn(),
    interactiveInflight: jest.fn(),
    interactiveShed: jest.fn(),
    interactiveActorHealth: jest.fn(),
    interactiveReplay: jest.fn(),
    interactiveStage: jest.fn(),
    interactiveHeartbeats: jest.fn(),
  },
}));

jest.mock('../../services/chatThreadRepository', () => ({
  getCursorAgentId: (...args: unknown[]) => mockGetCursorAgentId(...args),
  setCursorAgentId: (...args: unknown[]) => mockSetCursorAgentId(...args),
  insertMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/aiUsageService', () => ({
  recordCursorChatUsage: (...args: unknown[]) =>
    mockRecordCursorChatUsage(...args),
}));

jest.mock('../../services/testCaseService', () => ({
  failGeneratingTestCasesForThread: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/adrService', () => ({
  applyAdrGenerationResult: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../services/brainstormTurnLedger', () => ({
  finalizeBrainstormTerminal: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/requestUser', () => ({
  getUserId: jest.fn(() => '20000000-0000-4000-8000-000000000001'),
}));

import {
  HARNESS_AREA_IDS,
  type HarnessAreaId,
  type HarnessCommandBody,
  type HarnessSummaryMarker,
  type HarnessThreadState,
} from '../../../shared/types/chatHarness';
import type {
  AgentRunEventEnvelope,
  ChatThread,
} from '../../../shared/types/chat';
import type {
  AiRunIngestBody,
  InteractiveActorBootstrap,
} from '../../../shared/types/aiRunIngest';
import {
  DURABLE_INTERACTIVE_SPEC_VERSION,
  type DurableInteractiveTurnSpecification,
  type FrozenHarnessSpec,
  type FrozenInteractiveMcpDescriptor,
} from '../../../shared/types/durableInteractiveTurn';
import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';
import {
  getAreaProfile,
  REPOSITORY_CODE_TOOLS,
} from '../../services/chatHarness/areaProfiles';
import {
  resolveAreaProfile,
  toFrozenHarnessSpec,
} from '../../services/chatHarness/areaProfileResolver';
import {
  createChatHarnessCommandHandler,
  type ThreadRunState,
} from '../../services/chatHarness/chatHarnessCommandHandler';
import type {
  ChatHarnessCommandRepository,
  ChatHarnessCommandRow,
  InsertCommandInput,
  UpdateCommandReceiptPatch,
} from '../../services/chatHarness/chatHarnessCommandRepository';
import { createChatHarnessControlBus } from '../../services/chatHarness/chatHarnessControlBus';
import { buildRecreationPrompt } from '../../services/chatHarness/chatHarnessRecreation';
import {
  dispatchHarnessCustomTool,
  type CustomToolProposalRecord,
  type CustomToolProposalResult,
} from '../../services/chatHarness/customToolRegistry';
import { createChatHarnessRouter } from '../../routes/chatHarness';
import {
  attachInteractiveThreadStream,
  type InteractiveGatewayDependencies,
  type InteractiveGatewaySocket,
} from '../../services/interactiveGatewayService';
import { createInteractiveSessionActor } from '../../services/interactiveActorHost/interactiveSessionActor';
import {
  buildHarnessSdkCustomTools,
  resolveHarnessWritePermissionMode,
} from '../../services/interactiveActorHost/harnessCustomTools';
import { invokeInteractiveToolProxy } from '../../services/interactiveToolProxyService';
import { encryptInteractiveToolGrant } from '../../services/interactiveToolGrantCrypto';
import { buildSdkAgentOptions } from '../../services/cursorSdkAdapter/options';
import { isCursorAgentNotFound } from '../../services/cursorSdkAdapter/acquire';
import { ingest } from '../../services/aiRunIngestService';
import type { RedisLike } from '../../services/interactiveLiveBus';
import {
  createRecordedExecutionRun,
  getRecordedAreaFixture,
  RECORDED_HARNESS_STREAMS,
  REPEAT_CONTEXT_PATTERNS,
  type RecordedAreaHarnessFixture,
} from '../../fixtures/chatHarness/recordedStreams';

const TEST_SESSION_SECRET =
  'contract-suite-session-secret-with-adequate-entropy-32bytes';
const USER_ID = '20000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'Apex';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';

function makeAreaUuid(areaIndex: number, suffix: number): string {
  const areaHex = String(areaIndex + 1).padStart(4, '0');
  const suffixHex = String(suffix).padStart(12, '0');
  return `10000000-${areaHex}-4000-8000-${suffixHex}`;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

function makeFakeRedisPair(): {
  createClient: (role: 'pub' | 'sub') => RedisLike;
} {
  const listeners = new Map<
    string,
    Set<(channel: string, message: string) => void>
  >();
  const subscribed = new Set<string>();

  const makeClient = (): RedisLike => {
    const localListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
      async publish(channel: string, message: string): Promise<number> {
        if (subscribed.has(channel)) {
          for (const cb of listeners.get('message') ?? []) {
            cb(channel, message);
          }
        }
        return 1;
      },
      async subscribe(...channels: string[]): Promise<number> {
        for (const ch of channels) subscribed.add(ch);
        return subscribed.size;
      },
      async unsubscribe(...channels: string[]): Promise<number> {
        for (const ch of channels) subscribed.delete(ch);
        return subscribed.size;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (!localListeners.has(event)) localListeners.set(event, new Set());
        localListeners.get(event)!.add(listener);
        if (event === 'message') {
          if (!listeners.has('message')) listeners.set('message', new Set());
          listeners
            .get('message')!
            .add(listener as (channel: string, message: string) => void);
        }
        return this;
      },
      async quit(): Promise<void> {
        localListeners.clear();
      },
      async ping(): Promise<string> {
        return 'PONG';
      },
    };
  };

  return { createClient: () => makeClient() };
}

function makeProjectSkillConfig(
  fixture: RecordedAreaHarnessFixture,
): ProjectSkillConfig {
  const model = fixture.model;
  return {
    id: `settings-${fixture.area}`,
    project: PROJECT_ID,
    defaultModel: model,
    defaultEffort: 'medium',
    interviewSkillPath: '.cursor/skills/grill-with-docs/SKILL.md',
    interviewModel: model,
    interviewSkillOptions: [
      {
        key: 'build-intake',
        label: 'Build Intake',
        path: '.cursor/skills/build-intake/SKILL.md',
        model,
        enabled: true,
      },
    ],
    adrInterviewSkillPath: '.cursor/skills/adr-interview/SKILL.md',
    adrModel: model,
    prdAssistantSkillPath: '.cursor/skills/to-prd/SKILL.md',
    prdAssistantModel: model,
    designDocAssistantSkillPath: '.cursor/skills/prd-design-spec/SKILL.md',
    designDocAssistantModel: model,
    calendarAssistantSkillPath: '.cursor/skills/calendar-assistant/SKILL.md',
    calendarAssistantModel: model,
    testCaseSkillPath: '.cursor/skills/create-test-case/SKILL.md',
    testCaseModel: model,
    standupSkillPath: '.cursor/skills/daily-standup/SKILL.md',
    standupModel: model,
    quickSkillPills: [
      {
        label: 'Ask Apex',
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        model,
      },
      {
        label: 'Brainstorm',
        skillPath: '.cursor/skills/brainstorm/SKILL.md',
        model,
      },
      {
        label: 'CAB Release',
        skillPath: '.cursor/skills/cab-release/SKILL.md',
        model,
      },
    ],
  } as unknown as ProjectSkillConfig;
}

function makeInMemoryCommandRepo() {
  const rows = new Map<string, ChatHarnessCommandRow>();
  let seq = 0;

  const repo: ChatHarnessCommandRepository = {
    async insertIfAbsent(input: InsertCommandInput) {
      const key = `${input.threadId}:${input.commandId}`;
      const existing = rows.get(key);
      if (existing) {
        return { inserted: false, row: { ...existing } };
      }
      seq += 1;
      const ts = '2026-11-19T01:00:00.000Z';
      const created: ChatHarnessCommandRow = {
        id: `cmd-row-${seq}`,
        threadId: input.threadId,
        commandId: input.commandId,
        runId: input.runId ?? null,
        kind: input.kind,
        status: input.status,
        reason: input.reason ?? null,
        payload: input.payload ?? null,
        createdAt: ts,
        updatedAt: ts,
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
        updatedAt: '2026-11-19T01:00:01.000Z',
      };
      rows.set(key, updated);
      return { ...updated };
    },
    async countActiveSteersForRun(threadId, runId) {
      return [...rows.values()].filter(
        (r) =>
          r.threadId === threadId &&
          r.runId === runId &&
          r.kind === 'steer' &&
          (r.status === 'accepted' || r.status === 'applied'),
      ).length;
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
    async listPendingControlForRun(threadId, runId) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.threadId === threadId &&
            r.runId === runId &&
            (r.kind === 'steer' || r.kind === 'cancel') &&
            r.status === 'accepted',
        )
        .map((r) => ({
          commandId: r.commandId,
          kind: r.kind as 'steer' | 'cancel',
          ...(r.kind === 'steer' && typeof r.payload?.text === 'string'
            ? { text: r.payload.text }
            : {}),
        }));
    },
  };

  return { repo, rows };
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

function makeThread(
  area: HarnessAreaId,
  threadId: string,
  overrides: Partial<ChatThread> = {},
): ChatThread {
  return {
    id: threadId,
    userId: USER_ID,
    status: 'idle',
    harnessArea: area,
    harnessVersion: 1,
    kickoff: {
      project: PROJECT_ID,
      repo: 'AI-Pilot',
      branch: 'main',
    },
    messages: [
      {
        id: 'msg-hidden-seed',
        role: 'user',
        text: 'Hidden kickoff',
        hidden: true,
        ts: '2026-11-19T00:00:00.000Z',
      },
      {
        id: 'msg-visible-1',
        role: 'user',
        text: 'Initial user question',
        ts: '2026-11-19T00:00:01.000Z',
      },
      {
        id: 'msg-visible-2',
        role: 'agent',
        text: 'Initial agent answer',
        ts: '2026-11-19T00:00:02.000Z',
      },
    ],
    workspaceDir: `/tmp/apex-contract-${area}`,
    flagged: false,
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActivityAt: '2026-11-19T00:00:02.000Z',
    ...overrides,
  };
}

function makeDurableBootstrap(input: {
  area: HarnessAreaId;
  frozen: FrozenHarnessSpec;
  threadId: string;
  runId: string;
  attemptId: string;
  dispatchMessageId: string;
  turnId: string;
  prompt: string;
  recreationPrompt?: string;
  cursorAgentId?: string | null;
  model: string;
  workflowClass: DurableInteractiveTurnSpecification['workflowClass'];
}): InteractiveActorBootstrap {
  return {
    kind: 'interactive-actor-v2',
    specification: {
      schemaVersion: DURABLE_INTERACTIVE_SPEC_VERSION,
      kind: 'interactive-turn',
      turnId: input.turnId,
      threadId: input.threadId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      interactiveClass: 'fast',
      workflowClass: input.workflowClass,
      model: input.model,
      effort: 'medium',
      skill: null,
      currentMessage: {
        id: input.turnId,
        text: input.prompt,
        hidden: input.frozen.operation === 'summarize',
        attachments: [],
      },
      transcript: [],
      grounding: null,
      mcpServers: [],
      toolGrant: null,
      currentPrompt: input.prompt,
      recreationPrompt: input.recreationPrompt ?? input.prompt,
      deadlines: {
        absoluteTurnMs: 300_000,
        repositoryPreparationMs: null,
        firstEventMs: 30_000,
        toolCallMs: 60_000,
      },
      harness: input.frozen,
    },
    runId: input.runId,
    attemptId: input.attemptId,
    attemptNumber: 1,
    attemptStatus: 'dispatched',
    dispatchMessageId: input.dispatchMessageId,
    absoluteDeadlineAt: FUTURE_ISO,
    effectiveDeadlines: {
      repositoryPreparationMs: null,
      firstEventMs: 30_000,
      toolCallMs: 60_000,
    },
    cursorAgentId: input.cursorAgentId ?? null,
    mcpServers: {},
    projectId: PROJECT_ID,
  };
}

function setupIngestMocksForTerminal(input: {
  runId: string;
  threadId: string;
  attemptId: string;
  dispatchMessageId: string;
  specification: DurableInteractiveTurnSpecification;
}) {
  const runRow = {
    id: input.runId,
    threadId: input.threadId,
    status: 'running',
    projectId: PROJECT_ID,
    lane: 'ai-runs-interactive',
    transportVersion: 'dapr-actor-v2',
    queuedAt: '2026-11-19T01:00:00.000Z',
    dispatchedAt: '2026-11-19T01:00:00.200Z',
    dispatchMessageId: input.dispatchMessageId,
    executionSnapshot: input.specification,
    cancelRequested: false,
    cancelState: null,
    terminalReason: null,
    timeoutAt: FUTURE_ISO,
    ownerInstance: null,
    updatedAt: '2026-11-19T01:00:01.000Z',
    heartbeatAt: '2026-11-19T01:00:01.000Z',
    progressAt: null,
    progressLabel: null,
    progressPhase: null,
    startedAt: '2026-11-19T01:00:00.300Z',
    createdAt: '2026-11-19T01:00:00.000Z',
    eventDriven: true,
    lastError: null,
  };

  mockFindFirst.mockResolvedValue(runRow);

  let selectCall = 0;
  mockSelect.mockImplementation(() => {
    selectCall += 1;
    const limit = jest.fn().mockImplementation(async () => {
      if (selectCall <= 2) {
        return [
          {
            id: input.attemptId,
            runId: input.runId,
            attemptNumber: 1,
            status: 'running',
            dispatchMessageId: input.dispatchMessageId,
          },
        ];
      }
      return [
        {
          dispatchMessageId: input.dispatchMessageId,
          status: 'running',
        },
      ];
    });
    const where = jest.fn().mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where, limit });
    return { from };
  });

  mockInsert.mockReturnValue({
    values: jest.fn().mockReturnValue({
      onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    }),
  });

  mockUpdate.mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([runRow]),
      }),
    }),
  });

  const txUpdates: Array<Record<string, unknown>> = [];
  const txUpdate = jest.fn().mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      txUpdates.push(values);
      return {
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            { ...runRow, status: 'completed' },
          ]),
        }),
      };
    },
  }));

  mockTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: mockSelect,
        update: txUpdate,
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
          }),
        }),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
  );

  return { runRow, txUpdates };
}

describe('Chat Harness release-gating contract suite (TBI-015, TBI-011 DoD-3, PBI-007 AC-1, VT-18, VT-50)', () => {
  const originalSessionSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    mockNotifyRunEvent.mockResolvedValue(undefined);
    mockSetCursorAgentId.mockResolvedValue(undefined);
    mockGetCursorAgentId.mockResolvedValue(null);
    mockRecordCursorChatUsage.mockResolvedValue(undefined);
    mockTransition.mockResolvedValue({ ok: true, run: { status: 'running' } });
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: { status: 'cancelled' },
    });
  });

  afterAll(() => {
    if (originalSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSessionSecret;
    }
  });

  it('TBI-015 DoD-0 / DoD-1: recorded SDK stream fixtures exist for all 12 decided HARNESS_AREA_IDS', () => {
    expect(HARNESS_AREA_IDS).toHaveLength(12);
    expect(Object.keys(RECORDED_HARNESS_STREAMS).sort()).toEqual(
      [...HARNESS_AREA_IDS].sort(),
    );
    for (const area of HARNESS_AREA_IDS) {
      const fixture = getRecordedAreaFixture(area);
      expect(fixture.area).toBe(area);
      expect(fixture.normalTurn.events.length).toBeGreaterThanOrEqual(3);
      expect(fixture.recreateTurn.priorMessages.length).toBeGreaterThanOrEqual(
        4,
      );
      expect(fixture.recreateTurn.anchorFact.trim().length).toBeGreaterThan(0);
    }
  });

  it('VT-50: k6 load-test smoke script exists and enforces 50 VUs, 10 concurrent turns, 500 ms receipt, and 2000 ms snapshot thresholds', () => {
    const k6Path = resolve(
      __dirname,
      '../../../../scripts/load-tests/chat-harness-smoke.k6.js',
    );
    expect(existsSync(k6Path)).toBe(true);
    const script = readFileSync(k6Path, 'utf8');

    expect(script).toMatch(/vus:\s*50\b/);
    expect(script).toMatch(/10/);
    expect(script).toMatch(/\/api\/interactive\/threads\//);
    expect(script).toMatch(/\/api\/harness\/threads\/.*\/commands/);
    expect(script).toMatch(/\/api\/harness\/threads\/.*\/snapshot/);
    expect(script).toMatch(/harness_command_receipt_ms[\s\S]*p\(95\)<500/);
    expect(script).toMatch(/harness_snapshot_ms[\s\S]*p\(95\)<2000/);
    expect(script).toMatch(/http_req_failed[\s\S]*rate<0\.01/);
  });

  describe.each(HARNESS_AREA_IDS)('Area contract: %s', (area) => {
    const areaIndex = HARNESS_AREA_IDS.indexOf(area);
    const fixture = getRecordedAreaFixture(area);
    const profile = getAreaProfile(area);

    async function resolveForArea() {
      const skillConfig = makeProjectSkillConfig(fixture);
      return resolveAreaProfile(
        area,
        PROJECT_ID,
        {
          resolveSkillConfig: async () => skillConfig,
          getAppDefaultModel: async () => fixture.model,
          getAppDefaultSkill: async () => fixture.skillPath,
          getEnv: () => undefined,
        },
        {
          context: fixture.context,
        },
      );
    }

    it('Scenario 1 — send & stream: WS command yields accepted receipt + state frame (<500ms) and replays recorded SDK stream with final message', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 101);
      const cmdId = makeAreaUuid(areaIndex, 201);
      const runId = makeAreaUuid(areaIndex, 301);
      const attemptId = makeAreaUuid(areaIndex, 401);
      const dispatchMessageId = makeAreaUuid(areaIndex, 501);
      const store = makeInMemoryCommandRepo();
      const thread = makeThread(area, threadId);

      const handler = createChatHarnessCommandHandler({
        repository: store.repo,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        canWriteThread: async () => true,
        getUserPermissions: async () => new Set([profile.permission]),
        resolveAreaProfile: async () => resolved,
        resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
        getThreadRunState: async () => ({
          activeRunId: null,
          hasQueuedTurn: false,
        }),
        admitTurn: async () => ({
          runId,
          threadId,
          status: 'queued',
          turnId: cmdId,
          interactiveClass: 'fast',
        }),
        trackEvent: jest.fn(),
      });

      const { socket, frames, sendFromClient } = makeFakeSocket();
      let emitLiveToSocket: (env: AgentRunEventEnvelope) => void = () => {};
      const gatewayDeps: InteractiveGatewayDependencies = {
        loadThreadSnapshot: async () => ({
          messages: [],
          status: 'idle',
          eventDrivenTermination: true,
        }),
        loadThreadState: async (): Promise<HarnessThreadState> => ({
          threadStatus: store.rows.size > 0 ? 'running' : 'idle',
          activeRunId: store.rows.size > 0 ? runId : null,
          phase: store.rows.size > 0 ? 'running' : 'idle',
          harnessArea: area,
          pendingCommands: await store.repo.listPendingCommands(threadId),
          latestSummary: null,
          canWrite: true,
        }),
        replayRunEvents: async () => [],
        subscribeDurableEvents: () => () => {},
        subscribeToThread: () => () => {},
        subscribeLiveEvents: (_tid, cb) => {
          emitLiveToSocket = cb;
          return () => {};
        },
        subscribeThreadCommands: () => () => {},
        eventForRunEnvelope: (env) => env.event as never,
        onCommand: (body: HarnessCommandBody) =>
          handler.handle({
            userId: USER_ID,
            threadId,
            body,
            transport: 'socket',
          }),
      };

      await attachInteractiveThreadStream(socket, threadId, {}, gatewayDeps);

      const startedAt = Date.now();
      sendFromClient({
        type: 'command',
        commandId: cmdId,
        kind: 'send',
        text: fixture.normalTurn.userPrompt,
      });
      await flushAsync();
      const receiptElapsedMs = Date.now() - startedAt;

      expect(receiptElapsedMs).toBeLessThan(500);
      const receiptFrame = frames.find((f) => f.type === 'receipt');
      expect(receiptFrame).toMatchObject({
        type: 'receipt',
        receipt: {
          commandId: cmdId,
          kind: 'send',
          status: 'accepted',
          runId,
        },
      });
      expect(frames.filter((f) => f.type === 'state').length).toBeGreaterThanOrEqual(
        2,
      );

      // Replay recorded SDK stream through the real interactive session actor
      const posted: AiRunIngestBody[] = [];
      const actor = createInteractiveSessionActor({
        openWarmCheckout: jest.fn(),
        acquireAgent: jest.fn(),
        acquireDurableAgent: async (_b, checkout) => ({
          mode: 'recreated' as const,
          handle: {
            agentId: `agent-live-${area}`,
            model: resolved.model,
            workspaceRef: checkout.workspacePath,
            send: async () =>
              createRecordedExecutionRun(fixture.normalTurn.events, {
                usage: fixture.normalTurn.usage,
              }),
            dispose: async () => {},
          },
        }),
        materializeWorkspace: async (_b, destination) => ({
          workspacePath: destination,
        }),
        uploadAttemptArtifacts: async () => undefined,
        postIngest: async (_p, _r, body) => {
          posted.push(body);
          return { ok: true, cancelRequested: false };
        },
        publishLive: async (_tid, envelope) => {
          emitLiveToSocket(envelope);
        },
        agentStoreSync: {
          restoreAgentStore: async () => 'missing',
          backupAgentStore: async () => 0,
        },
      });

      const bootstrap = makeDurableBootstrap({
        area,
        frozen,
        threadId,
        runId,
        attemptId,
        dispatchMessageId,
        turnId: cmdId,
        prompt: fixture.normalTurn.userPrompt,
        model: resolved.model,
        workflowClass: resolved.workflowClass,
      });

      const outcome = await actor.handleDurableTurn({ threadId, bootstrap });
      expect(outcome).toEqual({
        status: 'completed',
        cursorAgentId: `agent-live-${area}`,
      });

      const liveEventFrames = frames.filter((f) => f.type === 'event');
      expect(liveEventFrames.length).toBeGreaterThan(0);

      const terminal = posted.find((b) => b.kind === 'terminal');
      expect(terminal).toMatchObject({
        kind: 'terminal',
        status: 'completed',
        artifactsFlushed: true,
        inputTokens: fixture.normalTurn.usage.inputTokens,
        outputTokens: fixture.normalTurn.usage.outputTokens,
      });

      const finalMsgProgress = posted.find(
        (b) => b.kind === 'progress' && b.event?.type === 'message',
      );
      expect(
        finalMsgProgress?.kind === 'progress' &&
          finalMsgProgress.event?.type === 'message'
          ? finalMsgProgress.event.message.text
          : '',
      ).toContain(fixture.normalTurn.expectedReplySubstring);

      handler.dispose();
    });

    it('Scenario 2 — tool calls & write confirmation: custom tools execute via tool proxy, writes record proposals with mode ask and autoReview false', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 102);

      const writePermission = resolveHarnessWritePermissionMode(frozen);
      expect(writePermission.autoReview).toBe(false);

      const declaredWriteTools = frozen.customTools.filter((t) => t.writes);
      expect(writePermission.writeTools).toHaveLength(declaredWriteTools.length);
      for (const writeTool of declaredWriteTools) {
        expect(writePermission.writeTools).toContainEqual({
          tool: writeTool.name,
          mode: 'ask',
        });
      }

      const grant = encryptInteractiveToolGrant(
        {
          userId: USER_ID,
          projectId: PROJECT_ID,
          allowedOperations: ['ado:read', 'ado:write'],
          delegatedAdoToken: 'delegated-test-ado-token',
          expiresAt: FUTURE_ISO,
        },
        { secret: TEST_SESSION_SECRET },
      );

      const descriptors: FrozenInteractiveMcpDescriptor[] =
        frozen.customTools.map((tool) => ({
          kind: 'custom-tool',
          serverName: tool.proxyTarget,
          toolName: tool.name,
          proxyTarget: tool.proxyTarget,
          writes: tool.writes,
          enableRepoBrowse: false,
        }));

      const recordedProposals: CustomToolProposalRecord[] = [];
      const readExecutions: string[] = [];

      const sdkTools = buildHarnessSdkCustomTools(frozen, async (call) => {
        const spec: DurableInteractiveTurnSpecification = {
          schemaVersion: DURABLE_INTERACTIVE_SPEC_VERSION,
          kind: 'interactive-turn',
          turnId: makeAreaUuid(areaIndex, 202),
          threadId,
          userId: USER_ID,
          projectId: PROJECT_ID,
          interactiveClass: 'fast',
          workflowClass: resolved.workflowClass,
          model: resolved.model,
          effort: 'medium',
          skill: null,
          currentMessage: {
            id: makeAreaUuid(areaIndex, 202),
            text: 'Run custom tool',
            hidden: false,
            attachments: [],
          },
          transcript: [],
          grounding: null,
          mcpServers: descriptors,
          toolGrant: grant,
          currentPrompt: 'Run custom tool',
          recreationPrompt: 'Run custom tool',
          deadlines: {
            absoluteTurnMs: 300_000,
            repositoryPreparationMs: null,
            firstEventMs: 30_000,
            toolCallMs: 30_000,
          },
          harness: frozen,
        };

        return invokeInteractiveToolProxy({
          claims: {
            runId: makeAreaUuid(areaIndex, 302),
            attemptId: makeAreaUuid(areaIndex, 402),
            dispatchMessageId: makeAreaUuid(areaIndex, 502),
            serverName: call.serverName,
            expiresAt: FUTURE_ISO,
          },
          specification: spec,
          body: { toolName: call.toolName, args: call.args },
          invokeCustomTool: (context) =>
            dispatchHarnessCustomTool(context, {
              recordProposal: (record) => {
                recordedProposals.push(record);
              },
              executeRead: (registration) => {
                readExecutions.push(registration.toolName);
                return { ok: true, tool: registration.toolName };
              },
            }),
        });
      });

      expect(Object.keys(sdkTools).sort()).toEqual(
        frozen.customTools.map((t) => t.name).sort(),
      );
      expect(fixture.customToolPayloads.map((p) => p.toolName).sort()).toEqual(
        frozen.customTools.map((t) => t.name).sort(),
      );

      for (const payload of fixture.customToolPayloads) {
        const sdkTool = sdkTools[payload.toolName];
        expect(sdkTool).toBeDefined();
        const rawResult = await sdkTool.execute(
          payload.args as Record<string, never>,
          {},
        );
        const contentResult = rawResult as { content: Array<{ text: string }> };
        const parsed = JSON.parse(
          contentResult.content[0].text,
        ) as CustomToolProposalResult;

        if (payload.writes) {
          expect(parsed.status).toBe('proposal_recorded');
          expect(parsed.requiresConfirmation).toBe(true);
          expect(parsed.proposalId).toBeTruthy();
          expect(parsed.confirmEndpoint).toBeTruthy();
        } else {
          expect(parsed.status).toBe('completed');
          expect(parsed.requiresConfirmation).toBe(false);
          expect(readExecutions).toContain(payload.toolName);
        }
      }

      expect(recordedProposals).toHaveLength(declaredWriteTools.length);
    });

    it('Scenario 3 — steer: active turn steered via command handler -> accepted -> SDK steer -> applied', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 103);
      const runId = makeAreaUuid(areaIndex, 303);
      const steerCmdId = makeAreaUuid(areaIndex, 203);
      const store = makeInMemoryCommandRepo();
      const thread = makeThread(area, threadId, {
        status: 'running',
        activeRunId: runId,
      });

      const fakeRedis = makeFakeRedisPair();
      const controlBus = createChatHarnessControlBus({
        config: { url: 'redis://localhost:6379', tls: false },
        createClient: (role) => fakeRedis.createClient(role),
        logger: () => {},
        keepAliveMs: 0,
      });
      await controlBus.init();

      const handler = createChatHarnessCommandHandler({
        repository: store.repo,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        canWriteThread: async () => true,
        getUserPermissions: async () => new Set([profile.permission]),
        resolveAreaProfile: async () => resolved,
        getThreadRunState: async (): Promise<ThreadRunState> => ({
          activeRunId: runId,
          hasQueuedTurn: false,
          activeRunStatus: 'running',
        }),
        controlBus,
        trackEvent: jest.fn(),
      });

      const ackApplied = deferred<void>();
      controlBus.subscribeAck(threadId, (ack) => {
        void handler.handleControlAck(ack).then(() => ackApplied.resolve());
      });

      const runStarted = deferred<void>();
      const steerGate = deferred<void>();
      const sdkSteers: string[] = [];
      const posted: AiRunIngestBody[] = [];

      const actor = createInteractiveSessionActor({
        openWarmCheckout: jest.fn(),
        acquireAgent: jest.fn(),
        acquireDurableAgent: async (_b, checkout) => ({
          mode: 'recreated' as const,
          handle: {
            agentId: `agent-steer-${area}`,
            model: resolved.model,
            workspaceRef: checkout.workspacePath,
            send: async () => {
              runStarted.resolve();
              return createRecordedExecutionRun(
                fixture.steerTurn.postSteerEvents,
                {
                  beforeGateEvents: fixture.steerTurn.preSteerEvents,
                  waitGate: steerGate.promise,
                },
              );
            },
            steer: async (text: string) => {
              sdkSteers.push(text);
              steerGate.resolve();
              return { accepted: true };
            },
            dispose: async () => {},
          },
        }),
        materializeWorkspace: async (_b, destination) => ({
          workspacePath: destination,
        }),
        uploadAttemptArtifacts: async () => undefined,
        postIngest: async (_p, _r, body) => {
          posted.push(body);
          return { ok: true, cancelRequested: false };
        },
        controlBus,
        agentStoreSync: {
          restoreAgentStore: async () => 'missing',
          backupAgentStore: async () => 0,
        },
      });

      const turnPromise = actor.handleDurableTurn({
        threadId,
        bootstrap: makeDurableBootstrap({
          area,
          frozen,
          threadId,
          runId,
          attemptId: makeAreaUuid(areaIndex, 403),
          dispatchMessageId: makeAreaUuid(areaIndex, 503),
          turnId: makeAreaUuid(areaIndex, 603),
          prompt: fixture.steerTurn.initialPrompt,
          model: resolved.model,
          workflowClass: resolved.workflowClass,
        }),
      });
      await runStarted.promise;

      const receipt = await handler.handle({
        userId: USER_ID,
        threadId,
        body: {
          commandId: steerCmdId,
          kind: 'steer',
          text: fixture.steerTurn.steerText,
        },
        transport: 'socket',
      });

      expect(receipt).toMatchObject({
        commandId: steerCmdId,
        kind: 'steer',
        status: 'accepted',
        runId,
      });

      await ackApplied.promise;
      const outcome = await turnPromise;

      expect(outcome.status).toBe('completed');
      expect(sdkSteers).toEqual([fixture.steerTurn.steerText]);

      const updatedRow = await store.repo.findByCommandId(threadId, steerCmdId);
      expect(updatedRow?.status).toBe('applied');

      const finalMsg = posted.find(
        (b) => b.kind === 'progress' && b.event?.type === 'message',
      );
      expect(
        finalMsg?.kind === 'progress' && finalMsg.event?.type === 'message'
          ? finalMsg.event.message.text
          : '',
      ).toContain(fixture.steerTurn.expectedSteeredSubstring);

      handler.dispose();
      await controlBus.shutdown();
    });

    it('Scenario 4 — summarize (full + fallback): idle summarize saves full and fallback summaries; recreation uses full and skips fallback', async () => {
      const resolved = await resolveForArea();
      const summarizeFrozen = toFrozenHarnessSpec(resolved, {
        operation: 'summarize',
      });
      const threadId = makeAreaUuid(areaIndex, 104);
      const sumCmdId = makeAreaUuid(areaIndex, 204);
      const runIdFull = makeAreaUuid(areaIndex, 304);
      const runIdFallback = makeAreaUuid(areaIndex, 314);
      const store = makeInMemoryCommandRepo();
      const thread = makeThread(area, threadId, { status: 'idle' });

      const handler = createChatHarnessCommandHandler({
        repository: store.repo,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        canWriteThread: async () => true,
        getUserPermissions: async () => new Set([profile.permission]),
        resolveAreaProfile: async () => resolved,
        getThreadRunState: async () => ({
          activeRunId: null,
          hasQueuedTurn: false,
        }),
        admitTurn: async () => ({
          runId: runIdFull,
          threadId,
          status: 'queued',
          turnId: sumCmdId,
          interactiveClass: 'fast',
        }),
        trackEvent: jest.fn(),
      });

      const receipt = await handler.handle({
        userId: USER_ID,
        threadId,
        body: { commandId: sumCmdId, kind: 'summarize' },
        transport: 'socket',
      });
      expect(receipt).toMatchObject({
        commandId: sumCmdId,
        kind: 'summarize',
        status: 'accepted',
        runId: runIdFull,
      });

      const runSummarize = async (
        runId: string,
        attemptId: string,
        events: Parameters<typeof createRecordedExecutionRun>[0],
      ) => {
        const posted: AiRunIngestBody[] = [];
        const actor = createInteractiveSessionActor({
          openWarmCheckout: jest.fn(),
          acquireAgent: jest.fn(),
          acquireDurableAgent: async (_b, checkout) => ({
            mode: 'resumed' as const,
            handle: {
              agentId: `agent-sum-${area}`,
              model: resolved.model,
              workspaceRef: checkout.workspacePath,
              send: jest.fn(),
              summarize: async () => createRecordedExecutionRun(events),
              dispose: async () => {},
            },
          }),
          materializeWorkspace: async (_b, destination) => ({
            workspacePath: destination,
          }),
          uploadAttemptArtifacts: async () => undefined,
          postIngest: async (_p, _r, body) => {
            posted.push(body);
            return { ok: true, cancelRequested: false };
          },
          agentStoreSync: {
            restoreAgentStore: async () => 'local-present',
            backupAgentStore: async () => 0,
          },
        });

        const outcome = await actor.handleDurableTurn({
          threadId,
          bootstrap: makeDurableBootstrap({
            area,
            frozen: summarizeFrozen,
            threadId,
            runId,
            attemptId,
            dispatchMessageId: makeAreaUuid(areaIndex, 504),
            turnId: sumCmdId,
            prompt: '',
            cursorAgentId: `agent-sum-${area}`,
            model: resolved.model,
            workflowClass: resolved.workflowClass,
          }),
        });
        return { outcome, posted };
      };

      // Full summary
      const fullRes = await runSummarize(
        runIdFull,
        makeAreaUuid(areaIndex, 404),
        fixture.summarize.fullEvents,
      );
      expect(fullRes.outcome.status).toBe('completed');
      const fullSummaryPost = fullRes.posted.find(
        (b) => b.kind === 'summary' && b.status === 'completed',
      );
      expect(fullSummaryPost).toMatchObject({
        kind: 'summary',
        status: 'completed',
        text: fixture.summarize.fullSummaryText,
      });

      // Fallback summary
      const fallbackRes = await runSummarize(
        runIdFallback,
        makeAreaUuid(areaIndex, 414),
        fixture.summarize.fallbackEvents,
      );
      expect(fallbackRes.outcome.status).toBe('completed');
      const fallbackSummaryPost = fallbackRes.posted.find(
        (b) => b.kind === 'summary' && b.status === 'fallback',
      );
      expect(fallbackSummaryPost).toMatchObject({
        kind: 'summary',
        status: 'fallback',
        text: fixture.summarize.fallbackSummaryText,
      });

      // Recreation uses full summary and skips fallback summary
      const promptWithFull = buildRecreationPrompt({
        areaKeyContext: fixture.areaKeyContext,
        latestFullSummary: {
          summaryText: fixture.summarize.fullSummaryText,
          coversThroughOrdinal: 2,
          isFallback: false,
        },
        messages: fixture.recreateTurn.priorMessages,
        currentTurnBlock: fixture.recreateTurn.followUpPrompt,
      });
      expect(promptWithFull).toContain('# Conversation summary');
      expect(promptWithFull).toContain(fixture.summarize.fullSummaryText);

      const promptWithFallback = buildRecreationPrompt({
        areaKeyContext: fixture.areaKeyContext,
        latestFullSummary: {
          summaryText: fixture.summarize.fallbackSummaryText,
          coversThroughOrdinal: 2,
          isFallback: true,
        },
        messages: fixture.recreateTurn.priorMessages,
        currentTurnBlock: fixture.recreateTurn.followUpPrompt,
      });
      expect(promptWithFallback).not.toContain(
        fixture.summarize.fallbackSummaryText,
      );
      expect(promptWithFallback).not.toContain('# Conversation summary');
      expect(promptWithFallback).toContain('# Recent conversation');

      handler.dispose();
    });

    it('Scenario 5 — cancel: running turn cancelled -> accepted -> actor stops & posts cancel_ack -> applied', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 105);
      const runId = makeAreaUuid(areaIndex, 305);
      const cancelCmdId = makeAreaUuid(areaIndex, 205);
      const store = makeInMemoryCommandRepo();
      const thread = makeThread(area, threadId, {
        status: 'running',
        activeRunId: runId,
      });

      const fakeRedis = makeFakeRedisPair();
      const controlBus = createChatHarnessControlBus({
        config: { url: 'redis://localhost:6379', tls: false },
        createClient: (role) => fakeRedis.createClient(role),
        logger: () => {},
        keepAliveMs: 0,
      });
      await controlBus.init();

      const handler = createChatHarnessCommandHandler({
        repository: store.repo,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        canWriteThread: async () => true,
        getUserPermissions: async () => new Set([profile.permission]),
        resolveAreaProfile: async () => resolved,
        getThreadRunState: async () => ({
          activeRunId: runId,
          hasQueuedTurn: false,
          activeRunStatus: 'running',
        }),
        cancelRun: async () => {},
        controlBus,
        trackEvent: jest.fn(),
      });

      const ackHandled = deferred<void>();
      controlBus.subscribeAck(threadId, (ack) => {
        void handler.handleControlAck(ack).then(() => ackHandled.resolve());
      });

      const runStarted = deferred<void>();
      const neverEnds = new Promise<void>(() => {});
      const onCancel = jest.fn();
      const posted: AiRunIngestBody[] = [];

      const actor = createInteractiveSessionActor({
        openWarmCheckout: jest.fn(),
        acquireAgent: jest.fn(),
        acquireDurableAgent: async (_b, checkout) => ({
          mode: 'recreated' as const,
          handle: {
            agentId: `agent-cancel-${area}`,
            model: resolved.model,
            workspaceRef: checkout.workspacePath,
            send: async () => {
              runStarted.resolve();
              return createRecordedExecutionRun([], {
                beforeGateEvents: fixture.cancelTurn.initialEvents,
                waitGate: neverEnds,
                onCancel,
              });
            },
            cancel: async () => {
              onCancel();
            },
            dispose: async () => {},
          },
        }),
        materializeWorkspace: async (_b, destination) => ({
          workspacePath: destination,
        }),
        uploadAttemptArtifacts: async () => undefined,
        postIngest: async (_p, _r, body) => {
          posted.push(body);
          return { ok: true, cancelRequested: false };
        },
        controlBus,
        durableHeartbeatMs: 60_000,
        agentStoreSync: {
          restoreAgentStore: async () => 'missing',
          backupAgentStore: async () => 0,
        },
      });

      const turnPromise = actor.handleDurableTurn({
        threadId,
        bootstrap: makeDurableBootstrap({
          area,
          frozen,
          threadId,
          runId,
          attemptId: makeAreaUuid(areaIndex, 405),
          dispatchMessageId: makeAreaUuid(areaIndex, 505),
          turnId: makeAreaUuid(areaIndex, 605),
          prompt: fixture.cancelTurn.userPrompt,
          model: resolved.model,
          workflowClass: resolved.workflowClass,
        }),
      });
      await runStarted.promise;

      const receipt = await handler.handle({
        userId: USER_ID,
        threadId,
        body: { commandId: cancelCmdId, kind: 'cancel' },
        transport: 'socket',
      });
      expect(receipt).toMatchObject({
        commandId: cancelCmdId,
        kind: 'cancel',
        status: 'accepted',
        runId,
      });

      await ackHandled.promise;
      const outcome = await turnPromise;

      expect(outcome).toEqual({ status: 'cancelled' });
      expect(onCancel).toHaveBeenCalled();
      expect(posted.filter((b) => b.kind === 'cancel_ack')).toHaveLength(1);

      const updatedRow = await store.repo.findByCommandId(
        threadId,
        cancelCmdId,
      );
      expect(updatedRow?.status).toBe('applied');

      handler.dispose();
      await controlBus.shutdown();
    });

    it('Scenario 6 — dropped connection + replay: HTTP retry dedupes without double admit, reconnect replays with zero dupes, and snapshot stays within budget', async () => {
      const resolved = await resolveForArea();
      const threadId = makeAreaUuid(areaIndex, 106);
      const cmdId = makeAreaUuid(areaIndex, 206);
      const runId = makeAreaUuid(areaIndex, 306);
      const store = makeInMemoryCommandRepo();
      const thread = makeThread(area, threadId);
      const admitTurn = jest.fn(async () => ({
        runId,
        threadId,
        status: 'queued' as const,
        turnId: cmdId,
        interactiveClass: 'fast' as const,
      }));

      const handler = createChatHarnessCommandHandler({
        repository: store.repo,
        resolveThreadAccess: async () => ({ access: 'owner', thread }),
        canWriteThread: async () => true,
        getUserPermissions: async () => new Set([profile.permission]),
        resolveAreaProfile: async () => resolved,
        resolveToolGrant: async () => ({ ok: true, toolGrant: null }),
        admitTurn,
        trackEvent: jest.fn(),
      });

      // Socket drops before receipt frame is flushed
      const dropped = makeFakeSocket();
      await attachInteractiveThreadStream(
        dropped.socket,
        threadId,
        {},
        {
          loadThreadSnapshot: async () => ({
            messages: [],
            status: 'idle',
            eventDrivenTermination: true,
          }),
          loadThreadState: async () => ({
            threadStatus: 'idle',
            activeRunId: null,
            phase: 'idle',
            harnessArea: area,
            pendingCommands: [],
            latestSummary: null,
            canWrite: true,
          }),
          replayRunEvents: async () => [],
          subscribeDurableEvents: () => () => {},
          subscribeToThread: () => () => {},
          subscribeLiveEvents: () => () => {},
          subscribeThreadCommands: () => () => {},
          eventForRunEnvelope: (env) => env.event as never,
          onCommand: async (body: HarnessCommandBody) => {
            const r = await handler.handle({
              userId: USER_ID,
              threadId,
              body,
              transport: 'socket',
            });
            dropped.triggerClose();
            return r;
          },
        },
      );

      dropped.sendFromClient({
        type: 'command',
        commandId: cmdId,
        kind: 'send',
        text: fixture.normalTurn.userPrompt,
      });
      await flushAsync();
      expect(dropped.frames.filter((f) => f.type === 'receipt')).toHaveLength(
        0,
      );
      expect(admitTurn).toHaveBeenCalledTimes(1);

      // HTTP retry with exact same commandId returns original receipt without duplicate admit
      const latestSummary: HarnessSummaryMarker = {
        id: makeAreaUuid(areaIndex, 706),
        source: 'user',
        fallback: false,
        createdAt: '2026-11-19T00:10:00.000Z',
      };
      const app = express();
      app.use(express.json());
      app.use(
        '/api/harness',
        createChatHarnessRouter({
          commandHandler: handler,
          resolveThreadAccess: async () => ({ access: 'owner', thread }),
          getAdoTokenForUser: async () => null,
          listPendingCommands: (id) => store.repo.listPendingCommands(id),
          getLatestSummaryMarker: async () => latestSummary,
          canCommandThread: async () => true,
        }),
      );

      const retryStart = Date.now();
      const retryRes = await request(app)
        .post(`/api/harness/threads/${threadId}/commands`)
        .send({
          commandId: cmdId,
          kind: 'send',
          text: fixture.normalTurn.userPrompt,
        });
      expect(Date.now() - retryStart).toBeLessThan(500);
      expect(retryRes.status).toBe(200);
      expect(retryRes.body).toMatchObject({
        commandId: cmdId,
        kind: 'send',
        status: 'accepted',
        runId,
      });
      expect(admitTurn).toHaveBeenCalledTimes(1);

      // Reconnect socket with lastEventId: one initial state frame + zero duplicate events
      const reconnected = makeFakeSocket();
      let liveCb: (env: AgentRunEventEnvelope) => void = () => {};
      const mkEnv = (id: string, sequence: number): AgentRunEventEnvelope => ({
        eventId: id,
        threadId,
        runId,
        sourceInstance: 'actor-1',
        sequence,
        timestamp: `2026-11-19T01:00:0${sequence}.000Z`,
        type: 'token',
        phase: 'implementation',
        status: 'running',
        event: { type: 'token', text: `chunk-${id}` },
      });

      await attachInteractiveThreadStream(
        reconnected.socket,
        threadId,
        { lastEventId: 'ev-1' },
        {
          loadThreadSnapshot: async () => ({
            messages: [],
            status: 'running',
            eventDrivenTermination: true,
            activeRunId: runId,
          }),
          loadThreadState: async () => ({
            threadStatus: 'running',
            activeRunId: runId,
            phase: 'running',
            harnessArea: area,
            pendingCommands: await store.repo.listPendingCommands(threadId),
            latestSummary,
            canWrite: true,
          }),
          replayRunEvents: async () => [mkEnv('ev-2', 2), mkEnv('ev-3', 3)],
          subscribeDurableEvents: () => () => {},
          subscribeToThread: () => () => {},
          subscribeLiveEvents: (_tid, cb) => {
            liveCb = cb;
            return () => {};
          },
          subscribeThreadCommands: () => () => {},
          eventForRunEnvelope: (env) => env.event as never,
        },
      );

      // Overlapping live ev-3 + fresh ev-4
      liveCb(mkEnv('ev-3', 3));
      liveCb(mkEnv('ev-4', 4));

      expect(
        reconnected.frames.filter((f) => f.type === 'state'),
      ).toHaveLength(1);
      expect(
        reconnected.frames
          .filter((f) => f.type === 'event' && f.id)
          .map((f) => f.id),
      ).toEqual(['ev-2', 'ev-3', 'ev-4']);

      // Snapshot budget (<2000ms) and text-free summary marker
      const snapStart = Date.now();
      const snapRes = await request(app).get(
        `/api/harness/threads/${threadId}/snapshot`,
      );
      expect(Date.now() - snapStart).toBeLessThan(2000);
      expect(snapRes.status).toBe(200);
      expect(snapRes.body.state.harnessArea).toBe(area);
      expect(snapRes.body.latestSummary).toEqual(latestSummary);
      expect(snapRes.body.latestSummary.summaryText).toBeUndefined();

      handler.dispose();
    });

    it('Scenario 7 — resume: stored cursorAgentId resumes cleanly with preserved binding', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 107);
      const runId = makeAreaUuid(areaIndex, 307);
      const posted: AiRunIngestBody[] = [];
      const seenResumeIds: Array<string | null> = [];

      const actor = createInteractiveSessionActor({
        openWarmCheckout: jest.fn(),
        acquireAgent: jest.fn(),
        acquireDurableAgent: async (_b, checkout, opts) => {
          seenResumeIds.push(opts.resumeAgentId ?? null);
          return {
            mode: 'resumed' as const,
            handle: {
              agentId: fixture.resumeTurn.priorCursorAgentId,
              model: resolved.model,
              workspaceRef: checkout.workspacePath,
              send: async () =>
                createRecordedExecutionRun(fixture.resumeTurn.events),
              dispose: async () => {},
            },
          };
        },
        materializeWorkspace: async (_b, destination) => ({
          workspacePath: destination,
        }),
        uploadAttemptArtifacts: async () => undefined,
        postIngest: async (_p, _r, body) => {
          posted.push(body);
          return { ok: true, cancelRequested: false };
        },
        agentStoreSync: {
          restoreAgentStore: async () => 'local-present',
          backupAgentStore: async () => 1,
        },
      });

      const outcome = await actor.handleDurableTurn({
        threadId,
        bootstrap: makeDurableBootstrap({
          area,
          frozen,
          threadId,
          runId,
          attemptId: makeAreaUuid(areaIndex, 407),
          dispatchMessageId: makeAreaUuid(areaIndex, 507),
          turnId: makeAreaUuid(areaIndex, 607),
          prompt: fixture.resumeTurn.userPrompt,
          cursorAgentId: fixture.resumeTurn.priorCursorAgentId,
          model: resolved.model,
          workflowClass: resolved.workflowClass,
        }),
      });

      expect(outcome).toEqual({
        status: 'completed',
        cursorAgentId: fixture.resumeTurn.priorCursorAgentId,
      });
      expect(seenResumeIds).toEqual([fixture.resumeTurn.priorCursorAgentId]);

      const terminal = posted.find((b) => b.kind === 'terminal');
      expect(terminal).toMatchObject({
        kind: 'terminal',
        status: 'completed',
        cursorAgentId: fixture.resumeTurn.priorCursorAgentId,
        stageTimings: expect.objectContaining({ agentMode: 'resumed' }),
      });

      const finalMsg = posted.find(
        (b) => b.kind === 'progress' && b.event?.type === 'message',
      );
      expect(
        finalMsg?.kind === 'progress' && finalMsg.event?.type === 'message'
          ? finalMsg.event.message.text
          : '',
      ).toContain(fixture.resumeTurn.expectedReplySubstring);
    });

    it('Scenario 8 — recreate (VT-18 / PBI-007 AC-1 / TBI-011 DoD-3 / TBI-015 DoD-2): forced 1.0.37->1.4.0 agent_not_found falls back to recreated handoff and continues without asking to repeat context', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 108);
      const runId = makeAreaUuid(areaIndex, 308);
      const posted: AiRunIngestBody[] = [];
      const sentPrompts: string[] = [];

      // Build the bounded recreation prompt from prior full summary + post-summary turns
      const recreationPrompt = buildRecreationPrompt({
        header: `# Apex interactive turn\nProject: ${PROJECT_ID}\nArea: ${area}`,
        areaKeyContext: fixture.areaKeyContext,
        latestFullSummary: fixture.recreateTurn.priorFullSummary,
        messages: fixture.recreateTurn.priorMessages,
        currentTurnBlock: `User request:\n${fixture.recreateTurn.followUpPrompt}`,
        maxChars: resolved.recreationCapChars,
      });

      // The bounded handoff MUST carry the earlier anchor fact and exclude fallback text
      expect(recreationPrompt).toContain(fixture.recreateTurn.anchorFact);
      expect(recreationPrompt).not.toContain(
        fixture.recreateTurn.priorFallbackSummary.summaryText,
      );

      // Simulate SDK 1.0.37 stored agent returning agent_not_found on 1.4.0 resume
      const actor = createInteractiveSessionActor({
        openWarmCheckout: jest.fn(),
        acquireAgent: jest.fn(),
        acquireDurableAgent: async (_b, checkout, opts) => {
          const resumeErr = Object.assign(
            new Error('Agent store format incompatible with 1.4.0'),
            { code: 'agent_not_found' },
          );
          expect(opts.resumeAgentId).toBe(
            fixture.recreateTurn.priorLegacyCursorAgentId,
          );
          expect(isCursorAgentNotFound(resumeErr)).toBe(true);

          // Adapter catches agent_not_found and creates a fresh agent (mode: 'recreated')
          return {
            mode: 'recreated' as const,
            handle: {
              agentId: `agent-recreated-1-4-0-${area}`,
              model: resolved.model,
              workspaceRef: checkout.workspacePath,
              send: async (prompt: string) => {
                sentPrompts.push(prompt);
                return createRecordedExecutionRun(fixture.recreateTurn.events);
              },
              dispose: async () => {},
            },
          };
        },
        materializeWorkspace: async (_b, destination) => ({
          workspacePath: destination,
        }),
        uploadAttemptArtifacts: async () => undefined,
        postIngest: async (_p, _r, body) => {
          posted.push(body);
          return { ok: true, cancelRequested: false };
        },
        agentStoreSync: {
          restoreAgentStore: async () => 'restored',
          backupAgentStore: async () => 1,
        },
      });

      const outcome = await actor.handleDurableTurn({
        threadId,
        bootstrap: makeDurableBootstrap({
          area,
          frozen,
          threadId,
          runId,
          attemptId: makeAreaUuid(areaIndex, 408),
          dispatchMessageId: makeAreaUuid(areaIndex, 508),
          turnId: makeAreaUuid(areaIndex, 608),
          prompt: fixture.recreateTurn.followUpPrompt,
          recreationPrompt,
          cursorAgentId: fixture.recreateTurn.priorLegacyCursorAgentId,
          model: resolved.model,
          workflowClass: resolved.workflowClass,
        }),
      });

      expect(outcome).toEqual({
        status: 'completed',
        cursorAgentId: `agent-recreated-1-4-0-${area}`,
      });

      // Actor must send the bounded recreation prompt, not the bare current turn prompt
      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]).toBe(recreationPrompt);
      expect(sentPrompts[0]).toContain(fixture.recreateTurn.anchorFact);

      const terminal = posted.find((b) => b.kind === 'terminal');
      expect(terminal).toMatchObject({
        kind: 'terminal',
        status: 'completed',
        recreateReason: 'sdk-version',
        stageTimings: expect.objectContaining({
          agentMode: 'recreated',
          recreateReason: 'sdk-version',
        }),
      });

      const finalMsg = posted.find(
        (b) => b.kind === 'progress' && b.event?.type === 'message',
      );
      const replyText =
        finalMsg?.kind === 'progress' && finalMsg.event?.type === 'message'
          ? finalMsg.event.message.text
          : '';

      // Reply directly references prior context and NEVER asks user to repeat context
      expect(replyText).toContain(fixture.recreateTurn.anchorFact);
      for (const pattern of REPEAT_CONTEXT_PATTERNS) {
        expect(replyText).not.toMatch(pattern);
      }
    });

    it('Scenario 9 — usage & telemetry: terminal ingest carries inputTokens/outputTokens and emits area + acquisitionMode without leaking text', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const threadId = makeAreaUuid(areaIndex, 109);
      const runId = makeAreaUuid(areaIndex, 309);
      const attemptId = makeAreaUuid(areaIndex, 409);
      const dispatchMessageId = makeAreaUuid(areaIndex, 509);
      const turnId = makeAreaUuid(areaIndex, 609);

      const secretPrompt = `SECRET_PROMPT_SENTINEL_${area.toUpperCase()}_991`;
      const secretSummary = `SECRET_SUMMARY_SENTINEL_${area.toUpperCase()}_992`;
      const secretSteer = `SECRET_STEER_SENTINEL_${area.toUpperCase()}_993`;

      const bootstrap = makeDurableBootstrap({
        area,
        frozen,
        threadId,
        runId,
        attemptId,
        dispatchMessageId,
        turnId,
        prompt: secretPrompt,
        recreationPrompt: `${secretSummary}\n${secretPrompt}`,
        model: resolved.model,
        workflowClass: resolved.workflowClass,
      });

      const posted: AiRunIngestBody[] = [];
      const actor = createInteractiveSessionActor({
        openWarmCheckout: jest.fn(),
        acquireAgent: jest.fn(),
        acquireDurableAgent: async (_b, checkout) => ({
          mode: 'resumed' as const,
          handle: {
            agentId: `agent-usage-${area}`,
            model: resolved.model,
            workspaceRef: checkout.workspacePath,
            send: async () =>
              createRecordedExecutionRun(fixture.normalTurn.events, {
                usage: fixture.normalTurn.usage,
              }),
            dispose: async () => {},
          },
        }),
        materializeWorkspace: async (_b, destination) => ({
          workspacePath: destination,
        }),
        uploadAttemptArtifacts: async () => undefined,
        postIngest: async (_p, _r, body) => {
          posted.push(body);
          return { ok: true, cancelRequested: false };
        },
        agentStoreSync: {
          restoreAgentStore: async () => 'local-present',
          backupAgentStore: async () => 0,
        },
      });

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await actor.handleDurableTurn({ threadId, bootstrap });

        const terminal = posted.find(
          (b): b is Extract<AiRunIngestBody, { kind: 'terminal' }> =>
            b.kind === 'terminal',
        );
        expect(terminal).toBeDefined();
        expect(terminal?.inputTokens).toBe(
          fixture.normalTurn.usage.inputTokens,
        );
        expect(terminal?.outputTokens).toBe(
          fixture.normalTurn.usage.outputTokens,
        );
        expect(terminal?.cacheReadTokens).toBe(
          fixture.normalTurn.usage.cacheReadTokens,
        );
        expect(terminal?.cacheWriteTokens).toBe(
          fixture.normalTurn.usage.cacheWriteTokens,
        );

        // Drive real aiRunIngestService.ingest with the actor's terminal payload
        setupIngestMocksForTerminal({
          runId,
          threadId,
          attemptId,
          dispatchMessageId,
          specification: bootstrap.specification,
        });

        await ingest(PROJECT_ID, runId, terminal!, {
          recordCursorChatUsage: mockRecordCursorChatUsage,
        });

        expect(mockTrackEvent).toHaveBeenCalledWith(
          'InteractiveTurnStages',
          expect.objectContaining({
            area,
            agentMode: 'resumed',
            status: 'completed',
          }),
          expect.any(Object),
        );
        expect(mockWorkerInteractiveTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            area,
            acquisitionMode: 'resumed',
          }),
          expect.any(Number),
        );

        // Command handler telemetry is also text-free
        const store = makeInMemoryCommandRepo();
        const commandTelemetry: Array<Record<string, unknown>> = [];
        const handler = createChatHarnessCommandHandler({
          repository: store.repo,
          resolveThreadAccess: async () => ({
            access: 'owner',
            thread: makeThread(area, threadId, {
              status: 'running',
              activeRunId: runId,
            }),
          }),
          canWriteThread: async () => true,
          getUserPermissions: async () => new Set([profile.permission]),
          resolveAreaProfile: async () => resolved,
          getThreadRunState: async () => ({
            activeRunId: runId,
            hasQueuedTurn: false,
            activeRunStatus: 'running',
          }),
          controlBus: { publishControl: async () => {} },
          trackEvent: (name, props, measurements) => {
            commandTelemetry.push({ name, props, measurements });
          },
        });
        await handler.handle({
          userId: USER_ID,
          threadId,
          body: {
            commandId: makeAreaUuid(areaIndex, 809),
            kind: 'steer',
            text: secretSteer,
          },
          transport: 'socket',
        });
        handler.dispose();

        const serializedTelemetry = JSON.stringify({
          trackEvent: mockTrackEvent.mock.calls,
          workerTurn: mockWorkerInteractiveTurn.mock.calls,
          commandTelemetry,
          logs: logSpy.mock.calls,
        });
        expect(serializedTelemetry).not.toContain(secretPrompt);
        expect(serializedTelemetry).not.toContain(secretSummary);
        expect(serializedTelemetry).not.toContain(secretSteer);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('Scenario 10 — 3 safety rules: settingSources=[], shell=none (Shell disallowed), and repositoryCode=none for interview/build-intake', async () => {
      const resolved = await resolveForArea();
      const frozen = toFrozenHarnessSpec(resolved);
      const sdkOptions = buildSdkAgentOptions('test-api-key', {
        sessionKey: `session-${area}`,
        compatibilityKey: `compat-${area}`,
        model: { id: resolved.model },
        workspaceRef: `/tmp/apex-safe-${area}`,
        skillContent: null,
        toolAllowlist: resolved.toolAllowlist,
        disallowedTools: resolved.disallowedTools,
        settingSources: resolved.safety.settingSources,
        sandbox: { enabled: false },
        mcpServers: {},
        priorAgentBinding: null,
        requestId: `req-safe-${area}`,
      });

      // Rule 1: settingSources is empty everywhere
      expect(resolved.safety.settingSources).toEqual([]);
      expect(frozen.safety?.settingSources).toEqual([]);
      expect(sdkOptions.local?.settingSources).toEqual([]);

      // Rule 2: shell is 'none' and 'Shell' is disallowed
      expect(resolved.safety.shell).toBe('none');
      expect(frozen.safety?.shell).toBe('none');
      expect(resolved.disallowedTools).toContain('Shell');
      expect(resolved.toolAllowlist).not.toContain('Shell');
      expect(sdkOptions.disallowedTools).toContain('Shell');

      // Rule 3: interview & build-intake forbid repository code access completely
      if (area === 'interview' || area === 'build-intake') {
        expect(resolved.safety.repositoryCode).toBe('none');
        expect(frozen.safety?.repositoryCode).toBe('none');
        expect(resolved.toolAllowlist).toEqual([]);
        for (const repoTool of REPOSITORY_CODE_TOOLS) {
          expect(resolved.toolAllowlist).not.toContain(repoTool);
          expect(resolved.disallowedTools).toContain(repoTool);
          expect(sdkOptions.disallowedTools).toContain(repoTool);
        }
      } else {
        expect(resolved.safety.repositoryCode).toBe('read');
        expect(frozen.safety?.repositoryCode).toBe('read');
      }
    });
  });
});
