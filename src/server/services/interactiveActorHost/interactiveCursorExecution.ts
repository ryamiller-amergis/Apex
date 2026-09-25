/**
 * FEAT-007 / TBI-011 — resume-capable Cursor execution for the interactive
 * actor host.
 *
 * Agent acquisition/resume is separated from `agent.send` so the session actor
 * can keep one live Agent object per thread across serialized turns (warm
 * cache). On cold start we `Agent.create`; after process restart we
 * `Agent.resume` by the previously persisted agent id. The grounded checkout
 * is opened by the caller and reused; this module owns only the Agent handle.
 *
 * Model, effort, workspace, native tools, and MCP servers are supplied by the
 * caller from the frozen bootstrap. This module does not resolve model, effort,
 * deadline, skill, or MCP policy locally.
 */
import { Agent } from '@cursor/sdk';
import type {
  LocalAgentOptions,
  McpServerConfig,
} from '@cursor/sdk/dist/cjs/options.js';
import type { EffortLevel } from '../../../shared/types/effort';
import type { RepoReader } from '../../../shared/types/repoReader';
import type {
  WorkerCursorExecution,
  WorkerCursorExecutionRun,
} from '../aiRunsWorker/cursorExecution';
import { createNativeReadTools } from '../nativeReadToolAdapter';
import { buildCursorModelSelection } from '../agentEffortResolver';

/**
 * The remote agent is gone — reaped after an idle gap, or not visible under the
 * resolved `cwd`. Matched structurally rather than with `instanceof` because the
 * error crosses the actor-host transport boundary, where the class identity is
 * lost but the stable `agent_not_found` code survives.
 */
function isAgentNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 'agent_not_found' || name === 'AgentNotFoundError';
}

/** Live Cursor Agent handle that can serve multiple serialized `send` calls. */
export interface InteractiveCursorAgentHandle {
  agentId: string | null;
  model: string;
  workspaceRef: string;
  send(
    prompt: string,
    options?: { onDelta?(update: unknown): Promise<void> | void },
  ): Promise<WorkerCursorExecutionRun>;
  dispose(): Promise<void>;
}

/**
 * Acquisition outcome. The session actor owns `warm` for a compatible cache
 * hit; this module returns only `resumed` / `recreated`.
 */
export type InteractiveAgentAcquisition =
  | Readonly<{ mode: 'warm'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'resumed'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'recreated'; handle: InteractiveCursorAgentHandle }>;

export type InteractiveCursorAcquireInput = Readonly<{
  model: string;
  effort: EffortLevel | null;
  workspaceRef: string;
}>;

export type InteractiveCursorAcquireOptions = Readonly<{
  resumeAgentId?: string | null;
  mcpServers: Readonly<Record<string, McpServerConfig>>;
}>;

function wrapHandle(
  agent:
    | Awaited<ReturnType<typeof Agent.create>>
    | Awaited<ReturnType<typeof Agent.resume>>,
  input: InteractiveCursorAcquireInput,
  fallbackAgentId: string | null,
): InteractiveCursorAgentHandle {
  const agentId =
    (agent as unknown as { id?: string | null }).id ?? fallbackAgentId ?? null;

  let disposed = false;
  return {
    agentId,
    model: input.model,
    workspaceRef: input.workspaceRef,
    async send(
      prompt: string,
      options?: { onDelta?(update: unknown): Promise<void> | void },
    ): Promise<WorkerCursorExecutionRun> {
      if (disposed) throw new Error('Interactive Cursor agent is disposed');
      const onDelta = options?.onDelta;
      const run = onDelta
        ? await agent.send(prompt, {
            onDelta: ({ update }) => onDelta(update),
          })
        : await agent.send(prompt);
      return run as unknown as WorkerCursorExecutionRun;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await agent[Symbol.asyncDispose]().catch(() => {});
    },
  };
}

export async function acquireInteractiveCursorAgent(
  input: InteractiveCursorAcquireInput,
  checkout: RepoReader,
  options: InteractiveCursorAcquireOptions,
): Promise<InteractiveAgentAcquisition> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const resumeAgentId = options.resumeAgentId?.trim() || undefined;
  const local = {
    cwd: input.workspaceRef,
    settingSources: ['project'],
    customTools: createNativeReadTools(checkout),
  } satisfies LocalAgentOptions;
  const agentOptions = {
    apiKey,
    model: buildCursorModelSelection(input.model, input.effort ?? undefined),
    local,
    mcpServers: { ...options.mcpServers },
  };

  if (resumeAgentId) {
    try {
      const agent = await Agent.resume(resumeAgentId, agentOptions);
      return {
        mode: 'resumed',
        handle: wrapHandle(agent, input, resumeAgentId),
      };
    } catch (error) {
      if (!isAgentNotFound(error)) throw error;
      const agent = await Agent.create(agentOptions);
      return {
        mode: 'recreated',
        handle: wrapHandle(agent, input, null),
      };
    }
  }

  const agent = await Agent.create(agentOptions);
  return {
    mode: 'recreated',
    handle: wrapHandle(agent, input, null),
  };
}

/**
 * One-shot helper: acquire + send. Prefer {@link acquireInteractiveCursorAgent}
 * when the actor retains a live Agent across turns.
 */
export async function createInteractiveCursorExecution(
  input: InteractiveCursorAcquireInput & { prompt: string },
  checkout: RepoReader,
  options: InteractiveCursorAcquireOptions & {
    resumeAgentId?: string | null;
  },
): Promise<WorkerCursorExecution & { agentId?: string | null; mode: InteractiveAgentAcquisition['mode'] }> {
  const acquired = await acquireInteractiveCursorAgent(input, checkout, options);
  try {
    const run = await acquired.handle.send(input.prompt);
    return {
      run,
      agentId: acquired.handle.agentId,
      mode: acquired.mode,
      dispose: () => acquired.handle.dispose(),
    };
  } catch (error) {
    await acquired.handle.dispose().catch(() => {});
    throw error;
  }
}
