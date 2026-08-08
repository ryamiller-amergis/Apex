/**
 * FEAT-007 / TBI-010 + TBI-011 — interactive session actor.
 *
 * Verifies the host-level invariants that are unit-testable without Dapr/Redis:
 *  - per-thread single-activation turn serialization (BR-015, VT-03 substitute)
 *  - warm grounded checkout reuse + Agent.resume across turns
 *  - LIVE token fan-out to Redis (ephemeral) + first-token/turn telemetry
 *  - DURABLE final assistant message via ingest, delivered live with same id
 *  - cooperative cancellation via a heartbeat's ingest `cancelRequested` (BR-018)
 *  - stale-fence abort before further writes (BR-018)
 *  - graceful completion when Redis (publishLive) is unconfigured
 */
import { AiRunFenceConflictError } from '../services/aiRunsWorker/callbackClient';
import type {
  WorkerCursorExecution,
  WorkerCursorExecutionRun,
} from '../services/aiRunsWorker/cursorExecution';
import type { CursorStreamEvent } from '../services/cursorExecutionCore';
import {
  createInteractiveSessionActor,
  type InteractiveActorDependencies,
  type InteractiveTurnRequest,
} from '../services/interactiveActorHost/interactiveSessionActor';
import type { WorkerTierTelemetry } from '../services/workerTierTelemetry';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { AiRunIngestBody, AiRunIngestResponse } from '../../shared/types/aiRunIngest';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';

function makeSnapshot(threadId = 't1'): ExecutionSnapshot {
  return {
    prompt: 'hello',
    model: 'auto',
    workspaceRef: '/warm/checkout',
    workflowClass: 'agent_home_chat',
    skillPath: 'skills/app-knowledge',
    projectId: 'proj-1',
    threadId,
  };
}

function makeRequest(overrides: Partial<InteractiveTurnRequest> = {}): InteractiveTurnRequest {
  return {
    runId: 'run-1',
    threadId: 't1',
    projectId: 'proj-1',
    dispatchMessageId: 'dispatch-1',
    snapshot: makeSnapshot(overrides.threadId),
    cursorAgentId: null,
    ...overrides,
  };
}

interface FakeExecutionOptions {
  tokens?: string[];
  toolCall?: boolean;
  agentId?: string | null;
  waitGate?: Promise<void>;
  onCancel?: () => void;
}

function makeExecution(
  options: FakeExecutionOptions = {},
): WorkerCursorExecution & { agentId?: string | null } {
  const run: WorkerCursorExecutionRun = {
    supports: (capability: string) => capability === 'stream',
    async *stream(): AsyncIterable<CursorStreamEvent> {
      if (options.toolCall) {
        yield { type: 'tool_call', name: 'ReadFile', status: 'running' };
      }
      for (const text of options.tokens ?? []) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      }
    },
    async wait() {
      if (options.waitGate) await options.waitGate;
      return { status: 'finished' };
    },
    cancel: async () => {
      options.onCancel?.();
    },
  };
  return { run, dispose: async () => {}, agentId: options.agentId ?? null };
}

function makeTelemetry(): WorkerTierTelemetry {
  return {
    interactiveFirstToken: jest.fn(),
    interactiveTurn: jest.fn(),
    interactiveInflight: jest.fn(),
    interactiveShed: jest.fn(),
    interactiveActorHealth: jest.fn(),
    interactiveReplay: jest.fn(),
  } as unknown as WorkerTierTelemetry;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface LiveCapture {
  publishLive: (
    threadId: string,
    envelope: AgentRunEventEnvelope,
  ) => Promise<void>;
  live: AgentRunEventEnvelope[];
}

function captureLive(): LiveCapture {
  const live: AgentRunEventEnvelope[] = [];
  return {
    live,
    publishLive: async (_threadId, envelope) => {
      live.push(envelope);
    },
  };
}

describe('interactiveSessionActor', () => {
  it('streams tokens live to Redis (ephemeral) and posts the durable final message + terminal', async () => {
    const posted: AiRunIngestBody[] = [];
    const telemetry = makeTelemetry();
    const { publishLive, live } = captureLive();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      createExecution: jest.fn(async () => makeExecution({ tokens: ['hi ', 'there'] })),
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        posted.push(body);
        return { ok: true, cancelRequested: false };
      }),
      publishLive,
      telemetry,
    };

    const actor = createInteractiveSessionActor(deps);
    const outcome = await actor.handleTurn(makeRequest());

    expect(outcome.status).toBe('completed');

    // Tokens ride Redis (ephemeral) — NOT durable ingest.
    expect(posted.some((b) => b.kind === 'progress' && b.event?.type === 'token')).toBe(
      false,
    );
    const liveTokens = live.filter((e) => e.event.type === 'token');
    expect(liveTokens.map((e) => (e.event as { text: string }).text).join('')).toBe(
      'hi there',
    );

    // Final assistant message is durable (ingest) AND delivered live with the
    // SAME message id so the client de-dupes the live copy vs replay.
    const durableMessage = posted.find(
      (b) => b.kind === 'progress' && b.event?.type === 'message',
    );
    const liveMessage = live.find((e) => e.event.type === 'message');
    expect(durableMessage).toBeDefined();
    expect(liveMessage).toBeDefined();
    const durableId = (durableMessage as { event: { message: { id: string; text: string } } })
      .event.message;
    const liveId = (liveMessage!.event as { message: { id: string } }).message;
    expect(durableId.text).toBe('hi there');
    expect(liveId.id).toBe(durableId.id);

    expect(posted.some((b) => b.kind === 'terminal' && b.status === 'completed')).toBe(
      true,
    );
    expect(telemetry.interactiveFirstToken).toHaveBeenCalledTimes(1);
    expect(telemetry.interactiveTurn).toHaveBeenCalledTimes(1);
  });

  it('completes durably when Redis (publishLive) is unconfigured', async () => {
    const posted: AiRunIngestBody[] = [];
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      createExecution: jest.fn(async () => makeExecution({ tokens: ['answer'] })),
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        posted.push(body);
        return { ok: true, cancelRequested: false };
      }),
      // no publishLive → default no-op fan-out
    };

    const actor = createInteractiveSessionActor(deps);
    const outcome = await actor.handleTurn(makeRequest());

    expect(outcome.status).toBe('completed');
    // The durable answer + terminal still land even with no live bus.
    expect(
      posted.some((b) => b.kind === 'progress' && b.event?.type === 'message'),
    ).toBe(true);
    expect(posted.some((b) => b.kind === 'terminal' && b.status === 'completed')).toBe(
      true,
    );
  });

  it('cooperatively cancels the turn when a heartbeat reports cancelRequested', async () => {
    const posted: AiRunIngestBody[] = [];
    const onCancel = jest.fn();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      createExecution: jest.fn(async () => makeExecution({ toolCall: true, onCancel })),
      // heartbeat on every sink event so cancellation is observed immediately.
      heartbeatMs: 0,
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        posted.push(body);
        // A progress heartbeat surfaces an operator/user stop.
        return { ok: true, cancelRequested: body.kind === 'progress' };
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    const outcome = await actor.handleTurn(makeRequest());

    expect(outcome.status).toBe('cancelled');
    expect(onCancel).toHaveBeenCalled();
    expect(posted.some((b) => b.kind === 'cancel_ack')).toBe(true);
    expect(posted.some((b) => b.kind === 'terminal' && b.status === 'completed')).toBe(
      false,
    );
  });

  it('aborts the turn on a stale dispatch fence before any further write', async () => {
    const posted: AiRunIngestBody[] = [];
    const onCancel = jest.fn();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      createExecution: jest.fn(async () => makeExecution({ toolCall: true, onCancel })),
      heartbeatMs: 0,
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        if (body.kind === 'progress') {
          throw new AiRunFenceConflictError('stale dispatch fence');
        }
        posted.push(body);
        return { ok: true, cancelRequested: false };
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    const outcome = await actor.handleTurn(makeRequest());

    expect(outcome.status).toBe('fence-conflict');
    expect(onCancel).toHaveBeenCalled();
    expect(posted.some((b) => b.kind === 'terminal' && b.status === 'completed')).toBe(
      false,
    );
  });

  it('serializes turns per thread, reuses the warm checkout, and resumes the agent', async () => {
    const gate = deferred();
    const startOrder: string[] = [];
    const openWarmCheckout = jest.fn(async () => ({ workspacePath: '/warm/checkout' }));
    const resumeAgentIds: Array<string | null | undefined> = [];
    let call = 0;
    const createExecution = jest.fn(
      async (
        _snapshot: Readonly<ExecutionSnapshot>,
        _checkout: { workspacePath: string },
        options: { resumeAgentId?: string | null },
      ) => {
        call += 1;
        resumeAgentIds.push(options.resumeAgentId);
        startOrder.push(`turn-${call}`);
        // Only the first turn blocks on the gate so we can observe serialization.
        return makeExecution({
          tokens: ['ok'],
          agentId: 'agent-1',
          waitGate: call === 1 ? gate.promise : undefined,
        });
      },
    );
    const deps: InteractiveActorDependencies = {
      openWarmCheckout,
      createExecution,
      postIngest: async (): Promise<AiRunIngestResponse> => ({
        ok: true,
        cancelRequested: false,
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    const first = actor.handleTurn(makeRequest({ runId: 'run-1' }));
    const second = actor.handleTurn(makeRequest({ runId: 'run-2' }));

    // Give the event loop a tick; the second turn must NOT start until the
    // first settles (single activation, BR-015).
    await Promise.resolve();
    await Promise.resolve();
    expect(createExecution).toHaveBeenCalledTimes(1);

    gate.resolve();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.status).toBe('completed');
    expect(secondOutcome.status).toBe('completed');
    expect(startOrder).toEqual(['turn-1', 'turn-2']);
    // Warm checkout opened once and reused across both turns.
    expect(openWarmCheckout).toHaveBeenCalledTimes(1);
    // First turn has no prior agent; second resumes the agent from the first.
    expect(resumeAgentIds[0]).toBeNull();
    expect(resumeAgentIds[1]).toBe('agent-1');
  });
});
