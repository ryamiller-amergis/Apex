/**
 * FEAT-007 / TBI-011 — resume-capable Cursor execution for the interactive
 * actor host.
 *
 * Agent acquisition/resume is separated from `agent.send` so the session actor
 * can keep one live Agent object per thread across serialized turns (warm
 * cache). On cold start we `Agent.create`; after process restart we
 * `Agent.resume` by the previously persisted agent id. The grounded checkout
 * is opened by the caller and reused; this module owns only the Agent handle.
 */
import { Agent } from '@cursor/sdk';
import type { LocalAgentOptions } from '@cursor/sdk/dist/cjs/options.js';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type {
  WorkerCursorExecution,
  WorkerCursorExecutionRun,
} from '../aiRunsWorker/cursorExecution';
import type { RepoReader } from '../../../shared/types/repoReader';
import { createNativeReadTools } from '../nativeReadToolAdapter';

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
  send(prompt: string): Promise<WorkerCursorExecutionRun>;
  dispose(): Promise<void>;
}

export async function acquireInteractiveCursorAgent(
  snapshot: Readonly<ExecutionSnapshot>,
  checkout: RepoReader,
  options: { resumeAgentId?: string | null } = {},
): Promise<InteractiveCursorAgentHandle> {
  // The checkout must already be open; execution cannot begin otherwise.
  void checkout;
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const resumeAgentId = options.resumeAgentId?.trim() || undefined;
  const local = {
    cwd: snapshot.workspaceRef,
    settingSources: ['project'],
    customTools: createNativeReadTools(checkout),
  } satisfies LocalAgentOptions;
  // The interactive host uses only RepoReader-backed read tools and never
  // resolves live repository MCP servers.
  const agentOptions = {
    apiKey,
    model: { id: snapshot.model },
    local,
    mcpServers: {},
  };

  // Tracks the id worth persisting. Cleared when a resume target turns out to be
  // dead so the thread never pins itself to an agent that can no longer be run.
  let resumedFrom = resumeAgentId;
  let agent:
    | Awaited<ReturnType<typeof Agent.create>>
    | Awaited<ReturnType<typeof Agent.resume>>;
  if (resumeAgentId) {
    try {
      agent = await Agent.resume(resumeAgentId, agentOptions);
    } catch (error) {
      if (!isAgentNotFound(error)) throw error;
      // Cursor reaped the agent between turns, which a slow cold start makes
      // likely. Starting fresh keeps the thread usable; resuming again never
      // could, so every retry would fail identically.
      resumedFrom = undefined;
      agent = await Agent.create(agentOptions);
    }
  } else {
    agent = await Agent.create(agentOptions);
  }

  // Prefer the SDK-reported id (create returns a fresh id); fall back to the
  // resume id so the caller can persist it for the thread's next turn.
  const agentId =
    (agent as unknown as { id?: string | null }).id ?? resumedFrom ?? null;

  let disposed = false;
  return {
    agentId,
    model: snapshot.model,
    workspaceRef: snapshot.workspaceRef,
    async send(prompt: string): Promise<WorkerCursorExecutionRun> {
      if (disposed) throw new Error('Interactive Cursor agent is disposed');
      const run = await agent.send(prompt);
      return run as unknown as WorkerCursorExecutionRun;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await agent[Symbol.asyncDispose]().catch(() => {});
    },
  };
}

/**
 * One-shot helper: acquire + send. Prefer {@link acquireInteractiveCursorAgent}
 * when the actor retains a live Agent across turns.
 */
export async function createInteractiveCursorExecution(
  snapshot: Readonly<ExecutionSnapshot>,
  checkout: RepoReader,
  options: { resumeAgentId?: string | null } = {},
): Promise<WorkerCursorExecution & { agentId?: string | null }> {
  const handle = await acquireInteractiveCursorAgent(snapshot, checkout, options);
  try {
    const run = await handle.send(snapshot.prompt);
    return {
      run,
      agentId: handle.agentId,
      dispose: () => handle.dispose(),
    };
  } catch (error) {
    await handle.dispose().catch(() => {});
    throw error;
  }
}
