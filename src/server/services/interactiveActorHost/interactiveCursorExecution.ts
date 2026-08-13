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
  const agent = resumeAgentId
    ? await Agent.resume(resumeAgentId, {
        apiKey,
        model: { id: snapshot.model },
        local,
        mcpServers: {},
      })
    : await Agent.create({
        apiKey,
        model: { id: snapshot.model },
        local,
        mcpServers: {},
      });

  // Prefer the SDK-reported id (create returns a fresh id); fall back to the
  // resume id so the caller can persist it for the thread's next turn.
  const agentId =
    (agent as unknown as { id?: string | null }).id ?? resumeAgentId ?? null;

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
