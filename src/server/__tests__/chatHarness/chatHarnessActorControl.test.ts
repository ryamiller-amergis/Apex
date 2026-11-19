/**
 * W2-C / S5 — Control channel, actor steer/cancel/summarize, and session memory.
 *
 * Covers:
 *  - VT-05 / PBI-004 AC-4: steer held during summarizing, applied once after summary (including on error)
 *  - VT-06 / BR-004: steer arriving during starting/resuming merged into prompt before SDK send
 *  - VT-08 / PBI-005 AC-0: cancel control message stops running turn immediately and posts cancel_ack
 *  - At-most-once dedupe across Redis control bus and ingestResponse.pendingControl
 *  - Stable per-thread workspace folder (no SHA segment)
 *  - Blob backup/restore of SDK agent store under agent-store/<threadId>/
 *  - recreateReason recording and clearCursorAgentId on AdapterResumeStalledError
 *  - createChatHarnessControlBus pub/sub round-trip and graceful no-op when unconfigured
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkerCursorExecutionRun } from '../../services/aiRunsWorker/cursorExecution';
import type { CursorStreamEvent } from '../../services/cursorExecutionCore';
import { AdapterResumeStalledError } from '../../services/cursorSdkAdapter/types';
import {
  createChatHarnessControlBus,
  type HarnessControlAck,
} from '../../services/chatHarness/chatHarnessControlBus';
import {
  createChatHarnessControlBus as createInteractiveControlBus,
} from '../../services/interactiveControlBus';
import type { RedisLike } from '../../services/interactiveLiveBus';
import {
  agentStoreBlobPrefix,
  backupAgentStore,
  restoreAgentStore,
  type AgentStoreBlobClient,
} from '../../services/interactiveActorHost/agentStoreSync';
import type {
  InteractiveCursorAgentHandle,
  InteractiveSendOptions,
} from '../../services/interactiveActorHost/interactiveCursorExecution';
import {
  createInteractiveSessionActor,
  resolveInteractiveThreadWorkspacePath,
} from '../../services/interactiveActorHost/interactiveSessionActor';
import {
  InteractiveSessionActorImpl,
  setInteractiveActorRuntime,
} from '../../services/interactiveActorHost/interactiveSessionActorClass';
import type { AiRunsCallbackClient } from '../../services/aiRunsWorker/callbackClient';
import type {
  AiRunIngestBody,
  AiRunIngestResponse,
  InteractiveActorBootstrap,
} from '../../../shared/types/aiRunIngest';
import type { HarnessControlMessage } from '../../../shared/types/chatHarness';

const TURN_ID = '10000000-0000-4000-8000-000000000101';
const THREAD_ID = '10000000-0000-4000-8000-000000000102';
const USER_ID = '10000000-0000-4000-8000-000000000103';
const CMD_ID_1 = '30000000-0000-4000-8000-000000000001';
const CMD_ID_2 = '30000000-0000-4000-8000-000000000002';

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

function makeFakeRedisPair(): {
  createClient: (role: 'pub' | 'sub') => RedisLike;
  published: Array<{ channel: string; message: string }>;
} {
  const listeners = new Map<string, Set<(channel: string, message: string) => void>>();
  const subscribedChannels = new Set<string>();
  const published: Array<{ channel: string; message: string }> = [];

  const makeClient = (): RedisLike => {
    const localListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
      async publish(channel: string, message: string): Promise<number> {
        published.push({ channel, message });
        if (subscribedChannels.has(channel)) {
          for (const cb of listeners.get('message') ?? []) {
            cb(channel, message);
          }
        }
        return 1;
      },
      async subscribe(...channels: string[]): Promise<number> {
        for (const ch of channels) subscribedChannels.add(ch);
        return subscribedChannels.size;
      },
      async unsubscribe(...channels: string[]): Promise<number> {
        for (const ch of channels) subscribedChannels.delete(ch);
        return subscribedChannels.size;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (!localListeners.has(event)) localListeners.set(event, new Set());
        localListeners.get(event)!.add(listener);
        if (event === 'message') {
          if (!listeners.has('message')) listeners.set('message', new Set());
          listeners.get('message')!.add(
            listener as (channel: string, message: string) => void,
          );
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

  return {
    createClient: () => makeClient(),
    published,
  };
}

function makeFakeBlobClient(): {
  client: AgentStoreBlobClient;
  blobs: Map<string, Buffer>;
} {
  const blobs = new Map<string, Buffer>();
  const client: AgentStoreBlobClient = {
    async listBlobs(prefix: string): Promise<readonly string[]> {
      return [...blobs.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    async downloadBlob(key: string): Promise<Buffer> {
      const content = blobs.get(key);
      if (!content) {
        throw Object.assign(new Error('Blob not found'), { statusCode: 404 });
      }
      return Buffer.from(content);
    },
    async uploadBlob(key: string, content: Buffer): Promise<void> {
      blobs.set(key, Buffer.from(content));
    },
  };
  return { client, blobs };
}

function makeDurableBootstrap(
  overrides: Partial<InteractiveActorBootstrap> = {},
): InteractiveActorBootstrap {
  const attemptId =
    overrides.attemptId ?? '20000000-0000-4000-8000-000000000103';
  return {
    kind: 'interactive-actor-v2',
    specification: {
      schemaVersion: 1,
      kind: 'interactive-turn',
      turnId: TURN_ID,
      threadId: THREAD_ID,
      userId: USER_ID,
      projectId: 'proj-1',
      interactiveClass: 'fast',
      workflowClass: 'home-chat',
      model: 'auto',
      effort: 'low',
      skill: null,
      currentMessage: {
        id: TURN_ID,
        text: 'Hello',
        hidden: false,
        attachments: [],
      },
      transcript: [],
      grounding: null,
      mcpServers: [],
      toolGrant: null,
      currentPrompt: 'Hello',
      recreationPrompt: 'Hello (recreated)',
      deadlines: {
        absoluteTurnMs: 300_000,
        repositoryPreparationMs: null,
        firstEventMs: 30_000,
        toolCallMs: 60_000,
      },
      ...overrides.specification,
    },
    runId: 'run-control-1',
    attemptId,
    attemptNumber: 1,
    attemptStatus: 'dispatched',
    dispatchMessageId: 'dispatch-control-1',
    absoluteDeadlineAt: '2099-01-01T00:00:00.000Z',
    effectiveDeadlines: {
      repositoryPreparationMs: null,
      firstEventMs: 30_000,
      toolCallMs: 60_000,
    },
    cursorAgentId: null,
    mcpServers: {},
    projectId: 'proj-1',
    ...overrides,
  };
}

function makeControllableAgent(options: {
  agentId?: string | null;
  workspaceRef?: string;
  tokens?: string[];
  waitGate?: Promise<void>;
  onSend?: (prompt: string, sendOptions?: InteractiveSendOptions) => void;
  onSteer?: (text: string) => void;
  onCancel?: () => void;
  summarize?: () => Promise<WorkerCursorExecutionRun>;
} = {}): InteractiveCursorAgentHandle {
  const run: WorkerCursorExecutionRun = {
    supports: (capability: string) =>
      capability === 'stream' || capability === 'cancel',
    async *stream(): AsyncIterable<CursorStreamEvent> {
      for (const text of options.tokens ?? ['done']) {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        };
      }
      if (options.waitGate) {
        await options.waitGate;
      }
      yield { type: 'apex_turn_end' };
    },
    async wait() {
      if (options.waitGate) await options.waitGate;
      return { status: 'finished' };
    },
    cancel: async () => {
      options.onCancel?.();
    },
  };

  return {
    agentId: options.agentId === undefined ? 'agent-1' : options.agentId,
    model: 'auto',
    workspaceRef: options.workspaceRef ?? '/tmp/ws',
    send: async (prompt, sendOptions) => {
      options.onSend?.(prompt, sendOptions);
      return run;
    },
    steer: async (text) => {
      options.onSteer?.(text);
      return { accepted: true };
    },
    summarize: options.summarize,
    cancel: async () => {
      options.onCancel?.();
    },
    dispose: async () => {},
  };
}

describe('chatHarnessControlBus', () => {
  it('re-exports the interactiveControlBus factory from chatHarness/chatHarnessControlBus', () => {
    expect(createChatHarnessControlBus).toBe(createInteractiveControlBus);
  });

  it('round-trips control messages and acks over fake Redis without logging steer text', async () => {
    const fake = makeFakeRedisPair();
    const logs: Array<Record<string, unknown>> = [];
    const bus = createChatHarnessControlBus({
      config: { url: 'redis://localhost:6379', tls: false },
      createClient: (role) => fake.createClient(role),
      logger: (event) => logs.push(event),
      keepAliveMs: 0,
    });

    expect(bus.isEnabled()).toBe(true);
    await bus.init();

    const receivedControls: HarnessControlMessage[] = [];
    const receivedAcks: HarnessControlAck[] = [];
    const unsubControl = bus.subscribeControl(THREAD_ID, (msg) =>
      receivedControls.push(msg),
    );
    const unsubAck = bus.subscribeAck(THREAD_ID, (ack) =>
      receivedAcks.push(ack),
    );

    const secretSteer = 'SUPER-SECRET-STEER-TEXT-42';
    await bus.publishControl({
      kind: 'steer',
      threadId: THREAD_ID,
      runId: 'run-1',
      commandId: CMD_ID_1,
      text: secretSteer,
      sentAt: '2026-11-19T00:00:00.000Z',
    });

    await bus.publishAck({
      threadId: THREAD_ID,
      runId: 'run-1',
      commandId: CMD_ID_1,
      kind: 'steer',
      disposition: 'steered',
      timestamp: '2026-11-19T00:00:01.000Z',
    });

    expect(receivedControls).toHaveLength(1);
    expect(receivedControls[0]).toMatchObject({
      kind: 'steer',
      commandId: CMD_ID_1,
      text: secretSteer,
    });
    expect(receivedAcks).toHaveLength(1);
    expect(receivedAcks[0]).toMatchObject({
      commandId: CMD_ID_1,
      disposition: 'steered',
    });

    expect(JSON.stringify(logs)).not.toContain(secretSteer);

    unsubControl();
    unsubAck();
    await bus.shutdown();
  });

  it('acts as a graceful no-op when Redis is unconfigured', async () => {
    const createClient = jest.fn();
    const bus = createChatHarnessControlBus({
      config: null,
      createClient,
    });

    expect(bus.isEnabled()).toBe(false);
    await bus.init();
    const unsubControl = bus.subscribeControl(THREAD_ID, jest.fn());
    const unsubAck = bus.subscribeAck(THREAD_ID, jest.fn());
    await bus.publishControl({
      kind: 'cancel',
      threadId: THREAD_ID,
      runId: 'run-1',
      commandId: CMD_ID_1,
      sentAt: '2026-11-19T00:00:00.000Z',
    });
    await bus.publishAck({
      threadId: THREAD_ID,
      runId: 'run-1',
      commandId: CMD_ID_1,
      kind: 'cancel',
      disposition: 'cancelled',
      timestamp: '2026-11-19T00:00:00.000Z',
    });
    unsubControl();
    unsubAck();
    await bus.shutdown();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('resolveInteractiveThreadWorkspacePath', () => {
  it('drops the SHA segment to give one stable folder per thread', () => {
    const root = path.join(os.tmpdir(), 'custom-actor-root');
    const env = { AI_RUNS_INTERACTIVE_ATTEMPT_ROOT: root };
    const expected = path.join(root, 'apex-interactive-thread', THREAD_ID);

    expect(
      resolveInteractiveThreadWorkspacePath(THREAD_ID, 'a'.repeat(40), env),
    ).toBe(expected);
    expect(
      resolveInteractiveThreadWorkspacePath(THREAD_ID, 'b'.repeat(40), env),
    ).toBe(expected);
    expect(resolveInteractiveThreadWorkspacePath(THREAD_ID, null, env)).toBe(
      expected,
    );
  });
});

describe('agentStoreSync', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-store-sync-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('backs up SDK agent store files to Blob and restores them when local store is missing', async () => {
    const { client, blobs } = makeFakeBlobClient();
    const wsA = path.join(tempRoot, 'replica-a');
    const wsB = path.join(tempRoot, 'replica-b');
    const storeFile = path.join(
      wsA,
      '.cursor',
      'projects',
      'thread-1',
      'sdk-agent-store',
      'abc',
      'index.db',
    );
    await mkdir(path.dirname(storeFile), { recursive: true });
    await writeFile(storeFile, Buffer.from('sqlite-bytes-v1'));

    const uploaded = await backupAgentStore(THREAD_ID, wsA, client);
    expect(uploaded).toBe(1);
    expect([...blobs.keys()]).toEqual([
      `${agentStoreBlobPrefix(THREAD_ID)}.cursor/projects/thread-1/sdk-agent-store/abc/index.db`,
    ]);

    // Local already present on replica A -> skips Blob download
    await expect(restoreAgentStore(THREAD_ID, wsA, client)).resolves.toBe(
      'local-present',
    );

    // Replica B is empty -> restores from Blob
    await mkdir(wsB, { recursive: true });
    await expect(restoreAgentStore(THREAD_ID, wsB, client)).resolves.toBe(
      'restored',
    );
    const restoredFile = path.join(
      wsB,
      '.cursor',
      'projects',
      'thread-1',
      'sdk-agent-store',
      'abc',
      'index.db',
    );
    await expect(readFile(restoredFile, 'utf8')).resolves.toBe('sqlite-bytes-v1');

    // Unknown thread with empty dir -> missing
    const wsC = path.join(tempRoot, 'replica-c');
    await mkdir(wsC, { recursive: true });
    await expect(restoreAgentStore('unknown-thread', wsC, client)).resolves.toBe(
      'missing',
    );
  });

  it('is a safe no-op when Blob storage is not configured', async () => {
    const prev = process.env.AI_PLATFORM_V2_BLOB_ACCOUNT_NAME;
    delete process.env.AI_PLATFORM_V2_BLOB_ACCOUNT_NAME;
    try {
      const ws = path.join(tempRoot, 'local-only');
      await mkdir(path.join(ws, '.cursor'), { recursive: true });
      await writeFile(path.join(ws, '.cursor', 'index.db'), 'data');
      await expect(backupAgentStore(THREAD_ID, ws)).resolves.toBe(0);
    } finally {
      if (prev !== undefined) {
        process.env.AI_PLATFORM_V2_BLOB_ACCOUNT_NAME = prev;
      }
    }
  });
});

describe('interactiveSessionActor control channel, steer inbox, summarize, and session memory', () => {
  it('VT-05 / PBI-004 AC-4: holds a steer while summarizing and applies ONE SDK steer after summary completes', async () => {
    const summaryGate = deferred<void>();
    const summaryStarted = deferred<void>();
    const sdkSteers: string[] = [];
    const posted: AiRunIngestBody[] = [];

    const summaryRun: WorkerCursorExecutionRun = {
      supports: (cap) => cap === 'stream' || cap === 'cancel',
      async *stream(): AsyncIterable<CursorStreamEvent> {
        summaryStarted.resolve();
        yield { type: 'summary', status: 'running' };
        await summaryGate.promise;
        yield {
          type: 'summary',
          status: 'completed',
          summary: 'Condensed conversation summary',
        };
      },
      wait: async () => ({ status: 'finished' }),
      cancel: async () => {},
    };

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'resumed' as const,
        handle: makeControllableAgent({
          workspaceRef: checkout.workspacePath,
          onSteer: (text) => sdkSteers.push(text),
          summarize: async () => summaryRun,
        }),
      })),
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

    const bootstrap = makeDurableBootstrap({
      cursorAgentId: 'agent-1',
      specification: {
        ...makeDurableBootstrap().specification,
        harness: {
          area: 'agent-home',
          version: 1,
          operation: 'summarize',
          toolAllowlist: [],
          customTools: [],
          writeConfirmation: [],
        },
      },
    });

    const turnPromise = actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap,
    });
    await summaryStarted.promise;

    const disposition = await actor.steer({
      threadId: THREAD_ID,
      runId: bootstrap.runId,
      commandId: CMD_ID_1,
      text: 'Focus on security risks next',
    });

    expect(disposition).toBe('held');
    expect(sdkSteers).toEqual([]);

    summaryGate.resolve();
    const outcome = await turnPromise;

    expect(outcome.status).toBe('completed');
    expect(sdkSteers).toEqual(['Focus on security risks next']);
    expect(
      posted
        .filter((b): b is Extract<AiRunIngestBody, { kind: 'summary' }> => b.kind === 'summary')
        .map((b) => b.status),
    ).toEqual(expect.arrayContaining(['running', 'completed']));
  });

  it('VT-05 / PBI-004 AC-4: applies held steer ONCE even when summary errors', async () => {
    const summaryGate = deferred<void>();
    const summaryStarted = deferred<void>();
    const sdkSteers: string[] = [];
    const posted: AiRunIngestBody[] = [];

    const failingSummaryRun: WorkerCursorExecutionRun = {
      supports: (cap) => cap === 'stream' || cap === 'cancel',
      async *stream(): AsyncIterable<CursorStreamEvent> {
        summaryStarted.resolve();
        yield { type: 'summary', status: 'running' };
        await summaryGate.promise;
        throw new Error('Summary model unavailable');
      },
      wait: async () => ({ status: 'error' }),
      cancel: async () => {},
    };

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'resumed' as const,
        handle: makeControllableAgent({
          workspaceRef: checkout.workspacePath,
          onSteer: (text) => sdkSteers.push(text),
          summarize: async () => failingSummaryRun,
        }),
      })),
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

    const bootstrap = makeDurableBootstrap({
      cursorAgentId: 'agent-1',
      specification: {
        ...makeDurableBootstrap().specification,
        harness: {
          area: 'agent-home',
          version: 1,
          operation: 'summarize',
          toolAllowlist: [],
          customTools: [],
          writeConfirmation: [],
        },
      },
    });

    jest.spyOn(console, 'error').mockImplementation(() => {});
    const turnPromise = actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap,
    });
    await summaryStarted.promise;

    const disposition = await actor.steer({
      threadId: THREAD_ID,
      runId: bootstrap.runId,
      commandId: CMD_ID_1,
      text: 'Still apply this steer after summary error',
    });

    expect(disposition).toBe('held');
    expect(sdkSteers).toEqual([]);

    summaryGate.resolve();
    await turnPromise;

    expect(sdkSteers).toEqual(['Still apply this steer after summary error']);
    expect(
      posted.some((b) => b.kind === 'summary' && b.status === 'error'),
    ).toBe(true);
  });

  it('VT-06 / BR-004: merges steer arriving during starting/resuming into prompt before SDK send', async () => {
    const acquireStarted = deferred<void>();
    const acquireGate = deferred<void>();
    const sentPrompts: string[] = [];
    const sdkSteers: string[] = [];

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => {
        acquireStarted.resolve();
        await acquireGate.promise;
        return {
          mode: 'resumed' as const,
          handle: makeControllableAgent({
            workspaceRef: checkout.workspacePath,
            onSend: (prompt) => sentPrompts.push(prompt),
            onSteer: (text) => sdkSteers.push(text),
          }),
        };
      }),
      materializeWorkspace: async (_b, destination) => ({
        workspacePath: destination,
      }),
      uploadAttemptArtifacts: async () => undefined,
      postIngest: async () => ({ ok: true, cancelRequested: false }),
      agentStoreSync: {
        restoreAgentStore: async () => 'local-present',
        backupAgentStore: async () => 0,
      },
    });

    const bootstrap = makeDurableBootstrap({ cursorAgentId: 'agent-1' });
    const turnPromise = actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap,
    });
    await acquireStarted.promise;

    const disposition = await actor.steer({
      threadId: THREAD_ID,
      runId: bootstrap.runId,
      commandId: CMD_ID_1,
      text: 'Also include migration rollback steps',
    });

    expect(disposition).toBe('merged');

    acquireGate.resolve();
    const outcome = await turnPromise;

    expect(outcome.status).toBe('completed');
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain('Hello');
    expect(sentPrompts[0]).toContain('Also include migration rollback steps');
    expect(sdkSteers).toEqual([]);
  });

  it('VT-08 / PBI-005 AC-0: cancel control message stops running turn immediately and posts cancel_ack', async () => {
    const runStarted = deferred<void>();
    const neverEnds = new Promise<void>(() => {});
    const onCancel = jest.fn();
    const posted: AiRunIngestBody[] = [];
    const fakeRedis = makeFakeRedisPair();
    const controlBus = createChatHarnessControlBus({
      config: { url: 'redis://localhost:6379', tls: false },
      createClient: (role) => fakeRedis.createClient(role),
      logger: () => {},
      keepAliveMs: 0,
    });
    const acks: HarnessControlAck[] = [];
    controlBus.subscribeAck(THREAD_ID, (ack) => acks.push(ack));

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'recreated' as const,
        handle: makeControllableAgent({
          workspaceRef: checkout.workspacePath,
          waitGate: neverEnds,
          onSend: () => runStarted.resolve(),
          onCancel,
        }),
      })),
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

    const bootstrap = makeDurableBootstrap();
    const turnPromise = actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap,
    });
    await runStarted.promise;

    await controlBus.publishControl({
      kind: 'cancel',
      threadId: THREAD_ID,
      runId: bootstrap.runId,
      commandId: CMD_ID_1,
      sentAt: '2026-11-19T00:00:00.000Z',
    });

    const outcome = await turnPromise;
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(onCancel).toHaveBeenCalled();
    expect(posted.filter((b) => b.kind === 'cancel_ack')).toHaveLength(1);
    expect(acks).toContainEqual(
      expect.objectContaining({
        commandId: CMD_ID_1,
        kind: 'cancel',
        disposition: 'cancelled',
      }),
    );

    // After turn ended, further steer/cancel returns turn-ended
    await expect(
      actor.steer({
        threadId: THREAD_ID,
        runId: bootstrap.runId,
        commandId: CMD_ID_2,
        text: 'Too late',
      }),
    ).resolves.toBe('turn-ended');
    await controlBus.shutdown();
  });

  it('dedupes duplicate commandId arriving via both Redis control bus and ingestResponse.pendingControl', async () => {
    const runStarted = deferred<void>();
    const runGate = deferred<void>();
    const sdkSteers: string[] = [];
    const fakeRedis = makeFakeRedisPair();
    const controlBus = createChatHarnessControlBus({
      config: { url: 'redis://localhost:6379', tls: false },
      createClient: (role) => fakeRedis.createClient(role),
      logger: () => {},
      keepAliveMs: 0,
    });
    let deliveredSlowPath = false;

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'recreated' as const,
        handle: makeControllableAgent({
          workspaceRef: checkout.workspacePath,
          waitGate: runGate.promise,
          onSend: () => runStarted.resolve(),
          onSteer: (text) => sdkSteers.push(text),
        }),
      })),
      materializeWorkspace: async (_b, destination) => ({
        workspacePath: destination,
      }),
      uploadAttemptArtifacts: async () => undefined,
      postIngest: async (_p, _r, body): Promise<AiRunIngestResponse> => {
        if (body.kind === 'heartbeat' && !deliveredSlowPath && sdkSteers.length > 0) {
          deliveredSlowPath = true;
          return {
            ok: true,
            cancelRequested: false,
            pendingControl: [
              {
                commandId: CMD_ID_1,
                kind: 'steer',
                text: 'Deliver once only',
              },
            ],
          };
        }
        return { ok: true, cancelRequested: false };
      },
      controlBus,
      durableHeartbeatMs: 15,
      agentStoreSync: {
        restoreAgentStore: async () => 'missing',
        backupAgentStore: async () => 0,
      },
    });

    const bootstrap = makeDurableBootstrap();
    const turnPromise = actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap,
    });
    await runStarted.promise;

    // Fast path delivers CMD_ID_1
    await controlBus.publishControl({
      kind: 'steer',
      threadId: THREAD_ID,
      runId: bootstrap.runId,
      commandId: CMD_ID_1,
      text: 'Deliver once only',
      sentAt: '2026-11-19T00:00:00.000Z',
    });

    // Wait for slow-path heartbeat to also deliver CMD_ID_1
    for (let i = 0; i < 100 && !deliveredSlowPath; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(deliveredSlowPath).toBe(true);

    runGate.resolve();
    const outcome = await turnPromise;
    expect(outcome.status).toBe('completed');
    expect(sdkSteers).toEqual(['Deliver once only']);

    await controlBus.shutdown();
  });

  it('records recreateReason on terminal ingest and backs up agent store after turn', async () => {
    const posted: AiRunIngestBody[] = [];
    const backupAgentStoreSpy = jest.fn(async () => 2);
    const restoreAgentStoreSpy = jest.fn(async () => 'missing' as const);

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'recreated' as const,
        handle: makeControllableAgent({
          workspaceRef: checkout.workspacePath,
        }),
      })),
      materializeWorkspace: async (_b, destination) => ({
        workspacePath: destination,
      }),
      uploadAttemptArtifacts: async () => undefined,
      postIngest: async (_p, _r, body) => {
        posted.push(body);
        return { ok: true, cancelRequested: false };
      },
      agentStoreSync: {
        restoreAgentStore: restoreAgentStoreSpy,
        backupAgentStore: backupAgentStoreSpy,
      },
    });

    const outcome = await actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({
        cursorAgentId: 'agent-from-other-replica',
      }),
    });

    expect(outcome.status).toBe('completed');
    expect(restoreAgentStoreSpy).toHaveBeenCalledTimes(1);
    expect(backupAgentStoreSpy).toHaveBeenCalledTimes(1);

    const terminal = posted.find((b) => b.kind === 'terminal');
    expect(terminal).toMatchObject({
      kind: 'terminal',
      status: 'completed',
      recreateReason: 'replica-move',
      stageTimings: expect.objectContaining({
        agentMode: 'recreated',
        recreateReason: 'replica-move',
      }),
    });
  });

  it('classifies sdk-version, idle-eviction, and deploy recreateReason values accurately', async () => {
    // 1. sdk-version: prior binding + Blob restore succeeded, yet acquire recreated
    const sdkPosted: AiRunIngestBody[] = [];
    const sdkActor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'recreated' as const,
        handle: makeControllableAgent({ workspaceRef: checkout.workspacePath }),
      })),
      materializeWorkspace: async (_b, destination) => ({
        workspacePath: destination,
      }),
      uploadAttemptArtifacts: async () => undefined,
      postIngest: async (_p, _r, body) => {
        sdkPosted.push(body);
        return { ok: true, cancelRequested: false };
      },
      agentStoreSync: {
        restoreAgentStore: async () => 'restored',
        backupAgentStore: async () => 0,
      },
    });
    await sdkActor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({ cursorAgentId: 'agent-old-sdk' }),
    });
    expect(sdkPosted.find((b) => b.kind === 'terminal')).toMatchObject({
      recreateReason: 'sdk-version',
      stageTimings: expect.objectContaining({ recreateReason: 'sdk-version' }),
    });

    // 2. idle-eviction: cached agent evicted past TTL (by another thread's tick) and recreated with no prior binding
    let clock = 1_000_000;
    const OTHER_THREAD_ID = '10000000-0000-4000-8000-000000000199';
    const idlePosted: AiRunIngestBody[] = [];
    const idleActor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'recreated' as const,
        handle: makeControllableAgent({
          agentId: null,
          workspaceRef: checkout.workspacePath,
        }),
      })),
      materializeWorkspace: async (_b, destination) => ({
        workspacePath: destination,
      }),
      uploadAttemptArtifacts: async () => undefined,
      postIngest: async (_p, _r, body) => {
        idlePosted.push(body);
        return { ok: true, cancelRequested: false };
      },
      now: () => clock,
      agentStoreSync: {
        restoreAgentStore: async () => 'missing',
        backupAgentStore: async () => 0,
      },
    });
    await idleActor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({
        attemptId: '20000000-0000-4000-8000-000000000201',
        cursorAgentId: null,
      }),
    });
    clock += 11 * 60_000;
    // Another thread's turn sweeps and evicts idle THREAD_ID from the warm cache.
    await idleActor.handleDurableTurn({
      threadId: OTHER_THREAD_ID,
      bootstrap: makeDurableBootstrap({
        attemptId: '20000000-0000-4000-8000-000000000299',
        dispatchMessageId: 'dispatch-other',
        runId: 'run-other',
        cursorAgentId: null,
      }),
    });
    idlePosted.length = 0;
    await idleActor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({
        attemptId: '20000000-0000-4000-8000-000000000202',
        dispatchMessageId: 'dispatch-idle-2',
        runId: 'run-idle-2',
        cursorAgentId: null,
      }),
    });
    expect(idlePosted.find((b) => b.kind === 'terminal')).toMatchObject({
      recreateReason: 'idle-eviction',
      stageTimings: expect.objectContaining({ recreateReason: 'idle-eviction' }),
    });

    // 3. deploy: host revision changed between turns
    let revision = 'rev-1';
    const deployPosted: AiRunIngestBody[] = [];
    const deployActor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async (_b, checkout) => ({
        mode: 'recreated' as const,
        handle: makeControllableAgent({
          agentId: 'agent-rev',
          workspaceRef: checkout.workspacePath,
        }),
      })),
      materializeWorkspace: async (_b, destination) => ({
        workspacePath: destination,
      }),
      uploadAttemptArtifacts: async () => undefined,
      postIngest: async (_p, _r, body) => {
        deployPosted.push(body);
        return { ok: true, cancelRequested: false };
      },
      hostRevision: () => revision,
      agentStoreSync: {
        restoreAgentStore: async () => 'restored',
        backupAgentStore: async () => 0,
      },
    });
    await deployActor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({
        attemptId: '20000000-0000-4000-8000-000000000301',
      }),
    });
    deployPosted.length = 0;
    revision = 'rev-2';
    // Force cache miss via model change on next turn after revision bump
    await deployActor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({
        attemptId: '20000000-0000-4000-8000-000000000302',
        dispatchMessageId: 'dispatch-deploy-2',
        runId: 'run-deploy-2',
        specification: {
          ...makeDurableBootstrap().specification,
          model: 'claude-4-sonnet',
        },
      }),
    });
    expect(deployPosted.find((b) => b.kind === 'terminal')).toMatchObject({
      recreateReason: 'deploy',
      stageTimings: expect.objectContaining({ recreateReason: 'deploy' }),
    });
  });

  it('emits clearCursorAgentId: true on terminal ingest when AdapterResumeStalledError is thrown', async () => {
    const posted: AiRunIngestBody[] = [];

    const actor = createInteractiveSessionActor({
      openWarmCheckout: jest.fn(),
      acquireAgent: jest.fn(),
      acquireDurableAgent: jest.fn(async () => {
        throw new AdapterResumeStalledError('agent-stalled-1');
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
        restoreAgentStore: async () => 'restored',
        backupAgentStore: async () => 0,
      },
    });

    jest.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await actor.handleDurableTurn({
      threadId: THREAD_ID,
      bootstrap: makeDurableBootstrap({
        cursorAgentId: 'agent-stalled-1',
      }),
    });

    expect(outcome.status).toBe('failed');
    const terminal = posted.find((b) => b.kind === 'terminal');
    expect(terminal).toMatchObject({
      kind: 'terminal',
      status: 'failed',
      clearCursorAgentId: true,
    });
  });

  it('delegates InteractiveSessionActorImpl.steer and .cancel to the logic core', async () => {
    const steer = jest.fn(async () => 'steered' as const);
    const cancel = jest.fn(async () => 'cancelled' as const);
    const callback: AiRunsCallbackClient = {
      getBootstrap: jest.fn(),
      postIngest: jest.fn(),
    };
    setInteractiveActorRuntime({
      logic: {
        handleTurn: jest.fn(),
        handleDurableTurn: jest.fn(),
        steer,
        cancel,
        disposeAll: jest.fn(),
      },
      callback,
    });

    const actor = Object.assign(
      Object.create(InteractiveSessionActorImpl.prototype),
      { getActorId: () => ({ getId: () => THREAD_ID }) },
    ) as InteractiveSessionActorImpl;

    await expect(
      InteractiveSessionActorImpl.prototype.steer.call(actor, {
        runId: 'run-1',
        commandId: CMD_ID_1,
        text: 'pivot',
      }),
    ).resolves.toBe('steered');
    expect(steer).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      runId: 'run-1',
      commandId: CMD_ID_1,
      text: 'pivot',
    });

    await expect(
      InteractiveSessionActorImpl.prototype.cancel.call(actor, {
        runId: 'run-1',
        commandId: CMD_ID_2,
      }),
    ).resolves.toBe('cancelled');
    expect(cancel).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      runId: 'run-1',
      commandId: CMD_ID_2,
    });
  });
});
