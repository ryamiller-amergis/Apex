import type { InteractiveActorBootstrap } from '../../shared/types/aiRunIngest';
import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import type { AiRunsCallbackClient } from '../services/aiRunsWorker/callbackClient';
import {
  InteractiveSessionActorImpl,
  interactiveSessionActorClassFor,
  setInteractiveActorRuntime,
} from '../services/interactiveActorHost/interactiveSessionActorClass';
import type {
  InteractiveSessionActor,
  InteractiveTurnOutcome,
} from '../services/interactiveActorHost/interactiveSessionActor';
import { interactiveInFlightInvocations } from '../services/interactiveActorHost/shutdownDrain';

const TURN_ID = '10000000-0000-4000-8000-000000000001';
const THREAD_ID = '10000000-0000-4000-8000-000000000002';
const USER_ID = '10000000-0000-4000-8000-000000000003';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '20000000-0000-4000-8000-000000000003';
const DISPATCH_MESSAGE_ID = '20000000-0000-4000-8000-000000000002';

const durableSnapshot: DurableInteractiveTurnSpecification = {
  schemaVersion: 1,
  kind: 'interactive-turn',
  turnId: TURN_ID,
  threadId: THREAD_ID,
  userId: USER_ID,
  projectId: 'project-1',
  interactiveClass: 'fast',
  workflowClass: 'home-chat',
  model: 'model-a',
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
  recreationPrompt: 'Hello',
  deadlines: {
    absoluteTurnMs: 300_000,
    repositoryPreparationMs: null,
    firstEventMs: 30_000,
    toolCallMs: 60_000,
  },
};

function makeBootstrap(
  overrides: Partial<InteractiveActorBootstrap> = {},
): InteractiveActorBootstrap {
  return {
    kind: 'interactive-actor-v2',
    specification: durableSnapshot,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    attemptStatus: 'dispatched',
    dispatchMessageId: DISPATCH_MESSAGE_ID,
    absoluteDeadlineAt: '2099-01-01T00:00:00.000Z',
    effectiveDeadlines: {
      repositoryPreparationMs: null,
      firstEventMs: 30_000,
      toolCallMs: 60_000,
    },
    cursorAgentId: null,
    mcpServers: {},
    projectId: 'project-1',
    ...overrides,
  };
}

describe('interactive compatibility actor class', () => {
  it('acknowledges a durable dispatch before the detached turn settles', async () => {
    let settle!: (value: { status: 'completed'; cursorAgentId: string }) => void;
    const handleDurableTurn = jest.fn(
      () => new Promise<InteractiveTurnOutcome>((resolve) => { settle = resolve; }),
    );
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const handleTurn = jest.fn();
    const logic: InteractiveSessionActor = {
      handleTurn,
      handleDurableTurn,
      disposeAll: jest.fn(),
    };
    const callback: AiRunsCallbackClient = {
      getBootstrap: jest.fn().mockResolvedValue(makeBootstrap()),
      postIngest: jest.fn(),
    };
    setInteractiveActorRuntime({ logic, callback });

    const actor = Object.assign(
      Object.create(InteractiveSessionActorImpl.prototype),
      { getActorId: () => ({ getId: () => THREAD_ID }) },
    ) as InteractiveSessionActorImpl;

    await expect(
      InteractiveSessionActorImpl.prototype.handleTurn.call(actor, {
        runId: RUN_ID,
        dispatchMessageId: DISPATCH_MESSAGE_ID,
      }),
    ).resolves.toEqual({ status: 'accepted' });
    expect(handleDurableTurn).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      bootstrap: expect.objectContaining({ kind: 'interactive-actor-v2' }),
    });
    expect(handleTurn).not.toHaveBeenCalled();
    settle({ status: 'completed', cursorAgentId: 'agent-1' });
  });

  it('returns prior outcome for a terminal attempt without calling Cursor', async () => {
    const handleDurableTurn = jest.fn();
    const logic: InteractiveSessionActor = {
      handleTurn: jest.fn(),
      handleDurableTurn,
      disposeAll: jest.fn(),
    };
    const callback: AiRunsCallbackClient = {
      getBootstrap: jest
        .fn()
        .mockResolvedValue(makeBootstrap({ attemptStatus: 'completed' })),
      postIngest: jest.fn(),
    };
    setInteractiveActorRuntime({ logic, callback });

    const actor = Object.assign(
      Object.create(InteractiveSessionActorImpl.prototype),
      { getActorId: () => ({ getId: () => THREAD_ID }) },
    ) as InteractiveSessionActorImpl;

    await expect(
      InteractiveSessionActorImpl.prototype.handleTurn.call(actor, {
        runId: RUN_ID,
        dispatchMessageId: DISPATCH_MESSAGE_ID,
      }),
    ).resolves.toEqual({ status: 'completed', cursorAgentId: null });
    expect(handleDurableTurn).not.toHaveBeenCalled();
  });

  it('counts the call as in flight until the durable turn is queued', async () => {
    let releaseBootstrap!: (value: InteractiveActorBootstrap) => void;
    const handleDurableTurn = jest.fn(
      () => new Promise<InteractiveTurnOutcome>(() => {}),
    );
    jest.spyOn(console, 'log').mockImplementation(() => {});
    setInteractiveActorRuntime({
      logic: { handleTurn: jest.fn(), handleDurableTurn, disposeAll: jest.fn() },
      callback: {
        getBootstrap: jest.fn(
          () =>
            new Promise<InteractiveActorBootstrap>((resolve) => {
              releaseBootstrap = resolve;
            }),
        ),
        postIngest: jest.fn(),
      } as unknown as AiRunsCallbackClient,
    });
    const actor = Object.assign(
      Object.create(InteractiveSessionActorImpl.prototype),
      { getActorId: () => ({ getId: () => THREAD_ID }) },
    ) as InteractiveSessionActorImpl;
    const before = interactiveInFlightInvocations.count();

    const outcome = InteractiveSessionActorImpl.prototype.handleTurn.call(actor, {
      runId: RUN_ID,
      dispatchMessageId: DISPATCH_MESSAGE_ID,
    });
    expect(interactiveInFlightInvocations.count()).toBe(before + 1);

    releaseBootstrap(makeBootstrap());
    await expect(outcome).resolves.toEqual({ status: 'accepted' });
    expect(handleDurableTurn).toHaveBeenCalled();
    expect(interactiveInFlightInvocations.count()).toBe(before);
  });
});

describe('interactive actor type per Dapr app', () => {
  it('gives each warm class its own actor type and keeps the legacy name', () => {
    const fast = interactiveSessionActorClassFor('apex-ai-fast-interactive');
    const agentic = interactiveSessionActorClassFor('apex-ai-agentic');
    const legacy = interactiveSessionActorClassFor('apex-ai-interactive');

    expect(new Set([fast.name, agentic.name, legacy.name]).size).toBe(3);
    expect(legacy).toBe(InteractiveSessionActorImpl);
    expect(interactiveSessionActorClassFor(undefined)).toBe(InteractiveSessionActorImpl);
    expect(fast.prototype).toBeInstanceOf(InteractiveSessionActorImpl);
    expect(agentic.prototype).toBeInstanceOf(InteractiveSessionActorImpl);
  });
});
