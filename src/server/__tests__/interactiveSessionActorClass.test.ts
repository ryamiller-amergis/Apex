import type { DurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';
import type { AiRunsCallbackClient } from '../services/aiRunsWorker/callbackClient';
import {
  InteractiveSessionActorImpl,
  setInteractiveActorRuntime,
} from '../services/interactiveActorHost/interactiveSessionActorClass';
import type { InteractiveSessionActor } from '../services/interactiveActorHost/interactiveSessionActor';

const durableSnapshot: DurableInteractiveTurnSpecification = {
  schemaVersion: 1,
  kind: 'interactive-turn',
  turnId: 'turn-1',
  threadId: 'thread-1',
  userId: 'user-1',
  projectId: 'project-1',
  interactiveClass: 'fast',
  workflowClass: 'home-chat',
  model: 'model-a',
  effort: 'low',
  skill: null,
  currentMessage: {
    id: 'turn-1',
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
          id: 'run-1',
          threadId: 'thread-1',
          status: 'dispatched',
          projectId: 'project-1',
          lane: 'ai-runs-interactive',
          queuedAt: '2026-09-23T15:00:00.000Z',
          dispatchedAt: '2026-09-23T15:00:01.000Z',
          dispatchMessageId: 'dispatch-1',
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
      getActorId: () => ({ getId: () => 'thread-1' }),
    } as unknown as InteractiveSessionActorImpl;

    await expect(
      InteractiveSessionActorImpl.prototype.handleTurn.call(actor, {
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      })
    ).rejects.toThrow(
      'Durable interactive turns require the direct actor V2 executor'
    );
    expect(handleTurn).not.toHaveBeenCalled();
  });
});
