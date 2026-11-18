/**
 * TBI-003 (DoD-0, DoD-1, DoD-2, NFR) & PBI-002 (AC-0, AC-1, AC-2, AC-3):
 * RED -> GREEN suite for `summary` normalization, grouped tool-request `groupId`,
 * `streamWithHeartbeat` (1.5 s quiet status), and terminal usage forwarding.
 */
import {
  createCursorRunEventEnvelope,
  executeCursorExecutionCore,
  HEARTBEAT_SILENCE_MS,
  HEARTBEAT_STATUS_DETAIL,
  streamWithHeartbeat,
  tokenFieldsForTerminalIngest,
  type CursorExecutionRun,
  type CursorStreamEvent,
} from '../services/cursorExecutionCore';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { AgentRunEventEnvelope, SseEvent } from '../../shared/types/chat';

const baseSnapshot: ExecutionSnapshot = {
  prompt: 'Inspect service',
  model: 'composer-2.5',
  workspaceRef: '/ws/core-test',
  workflowClass: 'agent_home_chat',
  skillPath: '',
  projectId: 'Apex',
  threadId: 'thread-core-1',
};

describe('cursorExecutionCore summary, tool groups, heartbeat, and usage (TBI-003 / PBI-002)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('TBI-003 DoD-0 / VT-19: normalizes summary running, completed, error, and fallback events without leaking summary text onto the event stream', async () => {
    const published: Array<{ event: SseEvent; envelope: AgentRunEventEnvelope }> = [];
    const completedSummaries: Array<{ text: string; fallback: boolean }> = [];

    const run: CursorExecutionRun = {
      supports: () => true,
      stream: async function* (): AsyncGenerator<CursorStreamEvent> {
        yield { type: 'summary', status: 'running' };
        yield {
          type: 'summary',
          status: 'completed',
          summary: 'Confidential summary text of 200 turns',
        };
        yield {
          type: 'summary',
          status: 'completed',
          fallback: true,
          summary: 'Trimmed fallback transcript',
        };
        yield { type: 'summary', status: 'error' };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Reply ready.' }] },
        };
      },
      wait: async () => ({ status: 'finished', result: 'Reply ready.' }),
    };

    let seq = 0;
    await executeCursorExecutionCore({
      snapshot: baseSnapshot,
      run,
      context: { runId: 'run-sum-1', sourceInstance: 'test' },
      sink: {
        publish: (event, envelope) => {
          published.push({ event, envelope });
        },
      },
      hooks: {
        onSummaryCompleted: (payload) => {
          completedSummaries.push(payload);
        },
      },
      nextSequence: () => ++seq,
    });

    const summaryEvents = published
      .map((entry) => entry.event)
      .filter((event) => event.type === 'summary');
    expect(summaryEvents).toEqual([
      { type: 'summary', status: 'running' },
      { type: 'summary', status: 'completed' },
      { type: 'summary', status: 'fallback' },
      { type: 'summary', status: 'error' },
    ]);
    expect(JSON.stringify(published)).not.toContain('Confidential summary text');
    expect(JSON.stringify(published)).not.toContain('Trimmed fallback transcript');
    expect(completedSummaries).toEqual([
      { text: 'Confidential summary text of 200 turns', fallback: false },
      { text: 'Trimmed fallback transcript', fallback: true },
    ]);

    const fallbackEnvelope = createCursorRunEventEnvelope({
      threadId: 'thread-core-1',
      runId: 'run-sum-1',
      sourceInstance: 'test',
      sequence: 99,
      event: { type: 'summary', status: 'fallback' },
    });
    expect(fallbackEnvelope.status).toBe('completed');
  });

  it('TBI-003 DoD-0 / VT-20: preserves groupId on grouped tool_call and tool_status events', async () => {
    const published: SseEvent[] = [];

    const run: CursorExecutionRun = {
      supports: () => true,
      stream: async function* (): AsyncGenerator<CursorStreamEvent> {
        yield {
          type: 'assistant',
          group_id: 'step-group-7',
          message: {
            content: [
              { type: 'tool_use', id: 'call-a', name: 'read', input: { path: 'a.ts' } },
              { type: 'tool_use', id: 'call-b', name: 'grep', input: { pattern: 'foo' } },
            ],
          },
        };
        yield {
          type: 'tool_call',
          call_id: 'call-a',
          group_id: 'step-group-7',
          name: 'read',
          status: 'completed',
          args: { path: 'a.ts' },
          result: 'contents',
        };
        yield {
          type: 'tool_call',
          call_id: 'call-b',
          group_id: 'step-group-7',
          name: 'grep',
          status: 'completed',
          args: { pattern: 'foo' },
          result: '1 match',
        };
      },
      wait: async () => ({ status: 'finished' }),
    };

    let seq = 0;
    await executeCursorExecutionCore({
      snapshot: baseSnapshot,
      run,
      context: { runId: 'run-grp-1', sourceInstance: 'test' },
      sink: {
        publish: (event) => {
          published.push(event);
        },
      },
      nextSequence: () => ++seq,
    });

    const toolCalls = published.filter((e) => e.type === 'tool_call');
    const toolStatuses = published.filter((e) => e.type === 'tool_status');
    expect(toolCalls).toHaveLength(2);
    expect(toolStatuses).toHaveLength(2);
    expect(toolCalls.map((e) => (e as { groupId?: string }).groupId)).toEqual([
      'step-group-7',
      'step-group-7',
    ]);
    expect(toolStatuses.map((e) => (e as { groupId?: string }).groupId)).toEqual([
      'step-group-7',
      'step-group-7',
    ]);
  });

  it('PBI-002 AC-0 / TBI-003 DoD-1 / VT-21 / VT-25: emits a Still working phase event at 1.5 s and 3.0 s of silence without calling hooks.onHeartbeat or leaking message text', async () => {
    jest.useFakeTimers();
    expect(HEARTBEAT_SILENCE_MS).toBe(1_500);

    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });

    const published: Array<{ event: SseEvent; envelope: AgentRunEventEnvelope }> = [];
    const onHeartbeat = jest.fn();

    const run: CursorExecutionRun = {
      supports: () => true,
      stream: async function* (): AsyncGenerator<CursorStreamEvent> {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Secret first token' }] },
        };
        await secondChunkGate;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: ' and final token' }] },
        };
      },
      wait: async () => ({ status: 'finished' }),
    };

    let seq = 0;
    const execution = executeCursorExecutionCore({
      snapshot: baseSnapshot,
      run,
      context: { runId: 'run-hb-1', sourceInstance: 'test' },
      sink: {
        publish: (event, envelope) => {
          published.push({ event, envelope });
        },
      },
      hooks: { onHeartbeat },
      nextSequence: () => ++seq,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_500);
    const after1500 = published.filter(
      (p) => p.event.type === 'phase' && p.event.detail === HEARTBEAT_STATUS_DETAIL,
    );
    expect(after1500).toHaveLength(1);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_500);
    const after3000 = published.filter(
      (p) => p.event.type === 'phase' && p.event.detail === HEARTBEAT_STATUS_DETAIL,
    );
    expect(after3000).toHaveLength(2);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    for (const hb of after3000) {
      expect(hb.event).toEqual({
        type: 'phase',
        phase: 'implementation',
        status: 'running',
        detail: 'Still working',
      });
      expect(hb.envelope.ephemeral).toBe(true);
      expect(JSON.stringify(hb)).not.toContain('Secret first token');
    }

    releaseSecondChunk();
    await execution;
  });

  it('PBI-002 AC-2 / VT-23: emits zero heartbeat events when tokens arrive every 500 ms', async () => {
    jest.useFakeTimers();
    const published: SseEvent[] = [];

    const run: CursorExecutionRun = {
      supports: () => true,
      stream: async function* (): AsyncGenerator<CursorStreamEvent> {
        for (let i = 0; i < 6; i += 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
          });
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: `chunk-${i} ` }] },
          };
        }
      },
      wait: async () => ({ status: 'finished' }),
    };

    let seq = 0;
    const execution = executeCursorExecutionCore({
      snapshot: baseSnapshot,
      run,
      context: { runId: 'run-hb-chatty', sourceInstance: 'test' },
      sink: { publish: (event) => { published.push(event); } },
      nextSequence: () => ++seq,
    });

    for (let i = 0; i < 6; i += 1) {
      await jest.advanceTimersByTimeAsync(500);
    }
    await execution;

    const heartbeats = published.filter(
      (event) => event.type === 'phase' && event.detail === HEARTBEAT_STATUS_DETAIL,
    );
    expect(heartbeats).toHaveLength(0);
  });

  it('PBI-002 AC-3 / VT-24: emits zero heartbeat events after the turn ends and leaves no pending timer', async () => {
    jest.useFakeTimers();
    const published: SseEvent[] = [];

    const stream = streamWithHeartbeat(
      (async function* (): AsyncGenerator<CursorStreamEvent> {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Complete.' }] },
        };
      })(),
      { silenceMs: 1_500 },
    );

    const collected: CursorStreamEvent[] = [];
    for await (const item of stream) {
      collected.push(item);
    }
    expect(collected).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(published).toHaveLength(0);
  });

  it('TBI-003 DoD-2 / VT-26: produces exact token fields for terminal ingest so AI Cost Analytics records usage', async () => {
    const run: CursorExecutionRun = {
      supports: () => true,
      stream: async function* (): AsyncGenerator<CursorStreamEvent> {
        yield {
          type: 'usage',
          usage: {
            inputTokens: 400,
            outputTokens: 125,
            cacheReadTokens: 50,
            cacheWriteTokens: 20,
          },
        };
      },
      wait: async () => ({ status: 'finished' }),
    };

    let seq = 0;
    const result = await executeCursorExecutionCore({
      snapshot: baseSnapshot,
      run,
      context: { runId: 'run-usage-1', sourceInstance: 'test' },
      sink: { publish: () => {} },
      nextSequence: () => ++seq,
    });

    expect(tokenFieldsForTerminalIngest(result.usage)).toEqual({
      inputTokens: 400,
      outputTokens: 125,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
    });
  });
});
