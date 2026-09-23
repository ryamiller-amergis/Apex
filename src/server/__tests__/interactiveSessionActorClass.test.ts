import type { InteractiveActorBootstrap } from '../../shared/types/aiRunIngest';
import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import type { AiRunsCallbackClient } from '../services/aiRunsWorker/callbackClient';
import {
  InteractiveSessionActorImpl,
  setInteractiveActorRuntime,
} from '../services/interactiveActorHost/interactiveSessionActorClass';
import type { InteractiveSessionActor } from '../services/interactiveActorHost/interactiveSessionActor';

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
  it('routes InteractiveActorBootstrap to handleDurableTurn', async () => {
    const handleDurableTurn = jest.fn().mockResolvedValue({
      status: 'completed',
      cursorAgentId: 'agent-1',
    });
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

    const actor = {
      getActorId: () => ({ getId: () => THREAD_ID }),
    } as unknown as InteractiveSessionActorImpl;

    await expect(
      InteractiveSessionActorImpl.prototype.handleTurn.call(actor, {
        runId: RUN_ID,
        dispatchMessageId: DISPATCH_MESSAGE_ID,
      }),
    ).resolves.toEqual({ status: 'completed', cursorAgentId: 'agent-1' });
    expect(handleDurableTurn).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      bootstrap: expect.objectContaining({ kind: 'interactive-actor-v2' }),
    });
    expect(handleTurn).not.toHaveBeenCalled();
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

    const actor = {
      getActorId: () => ({ getId: () => THREAD_ID }),
    } as unknown as InteractiveSessionActorImpl;

    await expect(
      InteractiveSessionActorImpl.prototype.handleTurn.call(actor, {
        runId: RUN_ID,
        dispatchMessageId: DISPATCH_MESSAGE_ID,
      }),
    ).resolves.toEqual({ status: 'completed', cursorAgentId: null });
    expect(handleDurableTurn).not.toHaveBeenCalled();
  });
});
