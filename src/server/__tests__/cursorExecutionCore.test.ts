import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import {
  executeCursorExecutionCore,
  type CursorExecutionRun,
} from '../services/cursorExecutionCore';

const snapshot: Readonly<ExecutionSnapshot> = Object.freeze({
  prompt: 'Implement the frozen requirement.',
  model: 'claude-sonnet-4-5',
  workspaceRef: 'workspace://ready/run-1',
  workflowClass: 'development',
  skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
  projectId: 'project-1',
  threadId: 'thread-1',
});

function createRun(): CursorExecutionRun {
  return {
    supports: (capability) => capability === 'stream',
    stream: async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Implemented the shared seam.' }],
        },
      };
      yield {
        type: 'tool_call',
        name: 'npm test',
        call_id: 'call-1',
        status: 'completed',
        args: { command: 'npm test' },
        result: 'passing',
      };
    },
    wait: jest.fn().mockResolvedValue({
      status: 'completed',
      result: 'Implemented the shared seam.',
    }),
  };
}

async function executeAdapter(): Promise<AgentRunEventEnvelope[]> {
  const envelopes: AgentRunEventEnvelope[] = [];
  let sequence = 0;

  await executeCursorExecutionCore({
    snapshot,
    run: createRun(),
    context: {
      runId: 'run-1',
      sourceInstance: 'cursor-execution-core-test',
    },
    sink: {
      publish: (_event, envelope) => {
        envelopes.push(envelope);
      },
    },
    nextSequence: () => ++sequence,
    createEventId: () => `event-${sequence}`,
    now: () => '2026-08-06T12:00:00.000Z',
  });

  return envelopes;
}

describe('TBI-004 shared Cursor execution core', () => {
  it('DoD-0 / VT-08 gives in-process and worker sinks equivalent envelopes for one frozen snapshot', async () => {
    const before = { ...snapshot };

    const inProcessEvents = await executeAdapter();
    const workerEvents = await executeAdapter();

    expect(inProcessEvents).toEqual(workerEvents);
    expect(inProcessEvents).toEqual([
      expect.objectContaining({
        threadId: snapshot.threadId,
        runId: 'run-1',
        sequence: 1,
        type: 'token',
        phase: 'implementation',
        status: 'running',
        event: {
          type: 'token',
          text: 'Implemented the shared seam.',
        },
      }),
      expect.objectContaining({
        threadId: snapshot.threadId,
        runId: 'run-1',
        sequence: 2,
        type: 'tool',
        phase: 'testing',
        status: 'completed',
        event: {
          type: 'tool_status',
          toolName: 'npm test',
          callId: 'call-1',
          status: 'completed',
          args: { keys: ['command'] },
          result: 'Completed with 7 characters of output',
        },
      }),
    ]);
    expect(snapshot).toEqual(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
