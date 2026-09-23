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

describe('interactive compatibility actor class', () => {
  it('rejects durable snapshots before invoking legacy actor logic', async () => {
    const handleTurn = jest.fn();
    const logic: InteractiveSessionActor = {
      handleTurn,
      disposeAll: jest.fn(),
    };
    const callback: AiRunsCallbackClient = {
      getBootstrap: jest.fn().mockResolvedValue({
        projectId: 'project-1',
        run: {
          id: RUN_ID,
          threadId: THREAD_ID,
          status: 'dispatched',
          projectId: 'project-1',
          lane: 'ai-runs-interactive',
          queuedAt: '2026-09-23T15:00:00.000Z',
          dispatchedAt: '2026-09-23T15:00:01.000Z',
          dispatchMessageId: DISPATCH_MESSAGE_ID,
          executionSnapshot: durableSnapshot,
          cancelRequested: false,
          cancelState: null,
          terminalReason: null,
          timeoutAt: '2026-09-23T15:05:00.000Z',
          ownerInstance: null,
          updatedAt: '2026-09-23T15:00:01.000Z',
        },
      }),
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
      })
    ).rejects.toThrow(
      'Durable interactive turns require the direct actor V2 executor'
    );
    expect(handleTurn).not.toHaveBeenCalled();
  });
});
