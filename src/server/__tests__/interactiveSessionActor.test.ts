/**
 * FEAT-007 / TBI-010 + TBI-011 — interactive session actor.
 *
 * Verifies the host-level invariants that are unit-testable without Dapr/Redis:
 *  - per-thread single-activation turn serialization (BR-015, VT-03 substitute)
 *  - warm grounded checkout reuse + live Agent cache across turns
 *  - immediate live "Starting agent…" phase before checkout/SDK
 *  - LIVE token fan-out to Redis (ephemeral) + first-token/turn telemetry
 *  - DURABLE final assistant message via ingest, delivered live with same id
 *  - cooperative cancellation via a heartbeat's ingest `cancelRequested` (BR-018)
 *  - stale-fence abort before further writes (BR-018)
 *  - graceful completion when Redis (publishLive) is unconfigured
 */
import { AiRunCallbackError, AiRunFenceConflictError } from '../services/aiRunsWorker/callbackClient';
import type { WorkerCursorExecutionRun } from '../services/aiRunsWorker/cursorExecution';
import type { CursorStreamEvent } from '../services/cursorExecutionCore';
import type { InteractiveCursorAgentHandle } from '../services/interactiveActorHost/interactiveCursorExecution';
import {
  createInteractiveSessionActor,
  INTERACTIVE_STARTING_DETAIL,
  type InteractiveActorDependencies,
  type InteractiveTurnRequest,
} from '../services/interactiveActorHost/interactiveSessionActor';
import type { WorkerTierTelemetry } from '../services/workerTierTelemetry';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { AiRunIngestBody, AiRunIngestResponse } from '../../shared/types/aiRunIngest';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';

function makeSnapshot(
  threadId = 't1',
  overrides: Partial<ExecutionSnapshot> = {},
): ExecutionSnapshot {
  return {
    prompt: 'hello',
    model: 'auto',
    workspaceRef: '/warm/checkout',
    workflowClass: 'agent_home_chat',
    skillPath: 'skills/app-knowledge',
    projectId: 'proj-1',
    threadId,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<InteractiveTurnRequest> = {}): InteractiveTurnRequest {
  const threadId = overrides.threadId ?? 't1';
  return {
    runId: 'run-1',
    threadId,
    projectId: 'proj-1',
    dispatchMessageId: 'dispatch-1',
    snapshot: makeSnapshot(threadId, overrides.snapshot),
    cursorAgentId: null,
    ...overrides,
  };
}

interface FakeAgentOptions {
  tokens?: string[];
  toolCall?: boolean;
  agentId?: string | null;
  waitGate?: Promise<void>;
  onCancel?: () => void;
  onSend?: () => void;
  model?: string;
  workspaceRef?: string;
}

function makeAgentHandle(options: FakeAgentOptions = {}): InteractiveCursorAgentHandle {
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
  return {
    agentId: options.agentId ?? null,
    model: options.model ?? 'auto',
    workspaceRef: options.workspaceRef ?? '/warm/checkout',
    send: async () => {
      options.onSend?.();
      return run;
    },
    dispose: async () => {},
  };
}

function makeTelemetry(): WorkerTierTelemetry {
  return {
    interactiveFirstToken: jest.fn(),
    interactiveTurn: jest.fn(),
    interactiveInflight: jest.fn(),
    interactiveShed: jest.fn(),
    interactiveActorHealth: jest.fn(),
    interactiveReplay: jest.fn(),
    interactiveStage: jest.fn(),
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
  it('publishes Starting agent… before checkout / agent acquisition', async () => {
    const order: string[] = [];
    const { publishLive, live } = captureLive();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => {
        order.push('checkout');
        return { workspacePath: '/warm/checkout' };
      }),
      acquireAgent: jest.fn(async () => {
        order.push('acquire');
        return makeAgentHandle({ tokens: ['ok'] });
      }),
      postIngest: async (): Promise<AiRunIngestResponse> => ({
        ok: true,
        cancelRequested: false,
      }),
      publishLive: async (threadId, envelope) => {
        if (envelope.event.type === 'phase') order.push('phase');
        await publishLive(threadId, envelope);
      },
    };

    await createInteractiveSessionActor(deps).handleTurn(makeRequest());

    expect(order[0]).toBe('phase');
    expect(order.indexOf('phase')).toBeLessThan(order.indexOf('checkout'));
    expect(order.indexOf('checkout')).toBeLessThan(order.indexOf('acquire'));
    const starting = live.find(
      (e) =>
        e.event.type === 'phase'
        && e.event.detail === INTERACTIVE_STARTING_DETAIL,
    );
    expect(starting).toBeDefined();
  });

  it('streams tokens live to Redis (ephemeral) and posts the durable final message + terminal', async () => {
    const posted: AiRunIngestBody[] = [];
    const telemetry = makeTelemetry();
    const { publishLive, live } = captureLive();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      acquireAgent: jest.fn(async () => makeAgentHandle({ tokens: ['hi ', 'there'], agentId: 'agent-1' })),
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
    if (outcome.status === 'completed') {
      expect(outcome.cursorAgentId).toBe('agent-1');
    }

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

    const terminal = posted.find((b) => b.kind === 'terminal' && b.status === 'completed');
    expect(terminal).toEqual(
      expect.objectContaining({
        kind: 'terminal',
        status: 'completed',
        cursorAgentId: 'agent-1',
      }),
    );
    expect(telemetry.interactiveFirstToken).toHaveBeenCalledTimes(1);
    expect(telemetry.interactiveTurn).toHaveBeenCalledTimes(1);
    expect(telemetry.interactiveStage).toHaveBeenCalled();
  });

  it('completes durably when Redis (publishLive) is unconfigured', async () => {
    const posted: AiRunIngestBody[] = [];
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      acquireAgent: jest.fn(async () => makeAgentHandle({ tokens: ['answer'] })),
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
      acquireAgent: jest.fn(async () => makeAgentHandle({ toolCall: true, onCancel })),
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

  it('does not surface Interactive turn failed when Stop races ahead of the heartbeat', async () => {
    const posted: AiRunIngestBody[] = [];
    const { publishLive, live } = captureLive();
    const onCancel = jest.fn();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      acquireAgent: jest.fn(async () => makeAgentHandle({ toolCall: true, onCancel })),
      heartbeatMs: 0,
      publishLive,
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        posted.push(body);
        if (body.kind === 'progress') {
          // Mimic cancelRun terminalizing before the actor observes cancelRequested.
          throw new AiRunCallbackError(
            'Cannot apply progress to cancelled run',
            409,
            'AI_RUN_ILLEGAL_TRANSITION',
          );
        }
        return { ok: true, cancelRequested: false };
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    const outcome = await actor.handleTurn(makeRequest());

    expect(outcome.status).toBe('cancelled');
    expect(onCancel).toHaveBeenCalled();
    expect(posted.some((b) => b.kind === 'cancel_ack')).toBe(true);
    expect(live.some((e) => e.event.type === 'error')).toBe(false);
    expect(live.some((e) => e.event.type === 'done')).toBe(true);
  });

  it('aborts the turn on a stale dispatch fence before any further write', async () => {
    const posted: AiRunIngestBody[] = [];
    const onCancel = jest.fn();
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      acquireAgent: jest.fn(async () => makeAgentHandle({ toolCall: true, onCancel })),
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

  it('surfaces a specific, redacted failure reason on a fatal turn error', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const posted: AiRunIngestBody[] = [];
    const { publishLive, live } = captureLive();
    const fatal = Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' });
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      acquireAgent: jest.fn(async () => {
        throw fatal;
      }),
      publishLive,
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        posted.push(body);
        return { ok: true, cancelRequested: false };
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    await expect(actor.handleTurn(makeRequest())).rejects.toThrow();

    const liveError = live.find((e) => e.event.type === 'error');
    expect(liveError?.event).toMatchObject({ type: 'error', errorCode: 'fatal' });
    const surfaced = (liveError?.event as { error: string }).error;
    expect(surfaced).toContain('Interactive turn failed');
    expect(surfaced).toContain('ENOENT');

    const terminal = posted.find(
      (b) => b.kind === 'terminal' && b.status === 'failed',
    );
    expect(terminal).toBeDefined();
    expect((terminal as { detail?: string }).detail).toContain('ENOENT');

    errorSpy.mockRestore();
  });

  it('redacts secret-bearing fatal error messages to the error class only', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const posted: AiRunIngestBody[] = [];
    const { publishLive } = captureLive();
    const secret = new Error('Authorization: Bearer sk-supersecrettoken12345');
    const deps: InteractiveActorDependencies = {
      openWarmCheckout: jest.fn(async () => ({ workspacePath: '/warm/checkout' })),
      acquireAgent: jest.fn(async () => {
        throw secret;
      }),
      publishLive,
      postIngest: jest.fn(async (_p, _r, body): Promise<AiRunIngestResponse> => {
        posted.push(body);
        return { ok: true, cancelRequested: false };
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    await expect(actor.handleTurn(makeRequest())).rejects.toThrow();

    const terminal = posted.find(
      (b) => b.kind === 'terminal' && b.status === 'failed',
    );
    const detail = (terminal as { detail?: string }).detail ?? '';
    expect(detail).toContain('Interactive turn failed');
    expect(detail).not.toContain('Bearer');
    expect(detail).not.toContain('supersecrettoken');

    errorSpy.mockRestore();
  });

  it('serializes turns per thread, reuses checkout, and reuses the live Agent cache', async () => {
    const gate = deferred();
    const startOrder: string[] = [];
    const openWarmCheckout = jest.fn(async () => ({ workspacePath: '/warm/checkout' }));
    const sendCounts: number[] = [];
    let call = 0;
    const sharedHandle = makeAgentHandle({
      tokens: ['ok'],
      agentId: 'agent-1',
      onSend: () => {
        call += 1;
        startOrder.push(`turn-${call}`);
        sendCounts.push(call);
      },
    });
    // First send blocks until the gate resolves so we can observe serialization.
    const originalSend = sharedHandle.send;
    sharedHandle.send = async (prompt) => {
      const run = await originalSend(prompt);
      if (call === 1) {
        const gatedWait = run.wait.bind(run);
        run.wait = async () => {
          await gate.promise;
          return gatedWait();
        };
      }
      return run;
    };

    const acquireAgent = jest.fn(async () => sharedHandle);
    const deps: InteractiveActorDependencies = {
      openWarmCheckout,
      acquireAgent,
      postIngest: async (): Promise<AiRunIngestResponse> => ({
        ok: true,
        cancelRequested: false,
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    const first = actor.handleTurn(makeRequest({ runId: 'run-1' }));
    const second = actor.handleTurn(makeRequest({ runId: 'run-2' }));

    // Wait until the first turn has acquired + sent (blocked on wait gate).
    for (let i = 0; i < 50 && sendCounts.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(acquireAgent).toHaveBeenCalledTimes(1);
    // Second turn must still be queued behind the first (BR-015).
    expect(sendCounts).toEqual([1]);

    gate.resolve();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(firstOutcome.status).toBe('completed');
    expect(secondOutcome.status).toBe('completed');
    expect(startOrder).toEqual(['turn-1', 'turn-2']);
    // Warm checkout opened once and reused across both turns.
    expect(openWarmCheckout).toHaveBeenCalledTimes(1);
    // Live Agent acquired once; second turn is a cache hit (send only).
    expect(acquireAgent).toHaveBeenCalledTimes(1);
    expect(sendCounts).toEqual([1, 2]);
  });

  it('invalidates the live Agent and checkout when workspaceRef changes', async () => {
    const disposeCheckout = jest.fn(async () => {});
    const disposeAgent = jest.fn(async () => {});
    const openWarmCheckout = jest.fn(async (_threadId, snapshot) => ({
      workspacePath: snapshot.workspaceRef,
      dispose: disposeCheckout,
    }));
    const acquireAgent = jest.fn(
      async (snapshot: Readonly<ExecutionSnapshot>) =>
        makeAgentHandle({
          tokens: ['ok'],
          agentId: 'agent-1',
          model: snapshot.model,
          workspaceRef: snapshot.workspaceRef,
          onSend: () => {},
        }),
    );
    // Override dispose on returned handles.
    acquireAgent.mockImplementation(async (snapshot: Readonly<ExecutionSnapshot>) => {
      const handle = makeAgentHandle({
        tokens: ['ok'],
        agentId: 'agent-x',
        model: snapshot.model,
        workspaceRef: snapshot.workspaceRef,
      });
      handle.dispose = disposeAgent;
      return handle;
    });

    const deps: InteractiveActorDependencies = {
      openWarmCheckout,
      acquireAgent,
      postIngest: async (): Promise<AiRunIngestResponse> => ({
        ok: true,
        cancelRequested: false,
      }),
    };

    const actor = createInteractiveSessionActor(deps);
    await actor.handleTurn(
      makeRequest({
        runId: 'run-1',
        snapshot: makeSnapshot('t1', { workspaceRef: '/warm/a' }),
      }),
    );
    await actor.handleTurn(
      makeRequest({
        runId: 'run-2',
        snapshot: makeSnapshot('t1', { workspaceRef: '/warm/b' }),
      }),
    );

    expect(openWarmCheckout).toHaveBeenCalledTimes(2);
    expect(acquireAgent).toHaveBeenCalledTimes(2);
    expect(disposeAgent).toHaveBeenCalled();
    expect(disposeCheckout).toHaveBeenCalled();
  });
});
