import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import {
  createCursorTurnEndMonitor,
  CursorExecutionWaitError,
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

  it('aborts an exact repeated tool-call loop with actionable guidance', async () => {
    const loopingRun: CursorExecutionRun = {
      supports: (capability) => capability === 'stream',
      stream: async function* () {
        for (let index = 0; index < 4; index++) {
          yield {
            type: 'assistant',
            message: {
              content: [{
                type: 'tool_use',
                id: `call-${index}`,
                name: 'list_projects',
                input: {},
              }],
            },
          };
        }
      },
      wait: jest.fn().mockResolvedValue({ status: 'completed' }),
    };

    await expect(executeCursorExecutionCore({
      snapshot,
      run: loopingRun,
      context: { runId: 'run-loop', sourceInstance: 'loop-test' },
      sink: { publish: () => {} },
      nextSequence: () => 1,
      maxIdenticalToolCalls: 3,
    })).rejects.toThrow(
      'The agent repeated list_projects with the same input too many times',
    );
  });

  it('collects all text fragments and completes on the SDK terminal status', async () => {
    const wait = jest.fn().mockResolvedValue({ status: 'finished' });
    const run: CursorExecutionRun = {
      supports: (capability) => capability === 'stream',
      stream: async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '## Home' }] },
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: ' page' }] },
        };
        yield { type: 'status', status: 'FINISHED' };
        await new Promise<never>(() => {});
      },
      wait,
    };

    const result = await executeCursorExecutionCore({
      snapshot,
      run,
      context: { runId: 'run-status', sourceInstance: 'status-test' },
      sink: { publish: () => {} },
      nextSequence: () => 1,
    });

    expect(result.text).toBe('## Home page');
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('completes from the authoritative turn-ended delta with full text', async () => {
    const monitor = createCursorTurnEndMonitor();
    monitor.observe({ type: 'text-delta', text: '## Home' });
    monitor.observe({ type: 'text-delta', text: ' page' });
    monitor.observe({ type: 'turn-ended' });

    const cancel = jest.fn().mockResolvedValue(undefined);
    const wait = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const run: CursorExecutionRun = {
      supports: (capability) =>
        capability === 'stream' || capability === 'cancel',
      stream: async function* () {
        await new Promise<never>(() => {});
        yield { type: 'status', status: 'RUNNING' };
      },
      wait,
      cancel,
    };

    const result = await executeCursorExecutionCore({
      snapshot,
      run,
      context: { runId: 'run-turn-end', sourceInstance: 'turn-end-test' },
      sink: { publish: () => {} },
      nextSequence: () => 1,
      turnEnd: monitor.completion,
    });

    expect(result.text).toBe('## Home page');
    expect(result.completedOnTurnEnd).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});

describe('cursor execution core token usage', () => {
  async function execute(run: CursorExecutionRun) {
    let sequence = 0;
    return executeCursorExecutionCore({
      snapshot,
      run,
      context: { runId: 'run-1', sourceInstance: 'usage-test' },
      sink: { publish: () => {} },
      nextSequence: () => ++sequence,
      createEventId: () => `event-${sequence}`,
      now: () => '2026-08-06T12:00:00.000Z',
    });
  }

  function runWith(opts: {
    streamUsage?: unknown[];
    waitUsage?: unknown;
  }): CursorExecutionRun {
    return {
      supports: (capability) => capability === 'stream',
      stream: async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        };
        for (const usage of opts.streamUsage ?? []) {
          yield { type: 'usage', agent_id: 'a', run_id: 'run-1', usage };
        }
      },
      wait: jest.fn().mockResolvedValue({
        status: 'completed',
        result: 'ok',
        ...(opts.waitUsage !== undefined ? { usage: opts.waitUsage } : {}),
      }),
    };
  }

  it('prefers the cumulative usage reported by wait()', async () => {
    const result = await execute(
      runWith({
        waitUsage: {
          inputTokens: 42_000,
          outputTokens: 900,
          cacheReadTokens: 118_000,
          cacheWriteTokens: 3_000,
          totalTokens: 163_900,
        },
        streamUsage: [
          { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ],
      }),
    );

    expect(result.usage).toEqual({
      inputTokens: 42_000,
      outputTokens: 900,
      cacheReadTokens: 118_000,
      cacheWriteTokens: 3_000,
    });
  });

  it('sums per-turn usage events when wait() carries none', async () => {
    const result = await execute(
      runWith({
        streamUsage: [
          { inputTokens: 20_000, outputTokens: 400, cacheReadTokens: 5_000, cacheWriteTokens: 100 },
          { inputTokens: 22_000, outputTokens: 500, cacheReadTokens: 6_000, cacheWriteTokens: 200 },
        ],
      }),
    );

    expect(result.usage).toEqual({
      inputTokens: 42_000,
      outputTokens: 900,
      cacheReadTokens: 11_000,
      cacheWriteTokens: 300,
    });
  });

  it('reports no usage when the runtime never sends any', async () => {
    const result = await execute(runWith({}));
    expect(result.usage).toBeUndefined();
  });

  it('treats an all-zero usage payload as no usage', async () => {
    const result = await execute(
      runWith({
        waitUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    );
    expect(result.usage).toBeUndefined();
  });

  it('keeps streamed usage on the wait() error so failed runs can still record tokens', async () => {
    const run: CursorExecutionRun = {
      supports: (capability) => capability === 'stream',
      stream: async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 42_000,
            outputTokens: 900,
            cacheReadTokens: 118_000,
            cacheWriteTokens: 3_000,
          },
        };
      },
      wait: jest.fn().mockRejectedValue(new Error('run wait failed')),
    };

    try {
      await execute(run);
      throw new Error('expected wait() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CursorExecutionWaitError);
      expect((error as CursorExecutionWaitError).usage).toEqual({
        inputTokens: 42_000,
        outputTokens: 900,
        cacheReadTokens: 118_000,
        cacheWriteTokens: 3_000,
      });
    }
  });
});
