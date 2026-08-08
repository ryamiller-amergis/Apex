/**
 * FEAT-007 / TBI-011 — resume-capable Cursor execution for the interactive
 * actor host.
 *
 * Mirrors {@link createLocalCursorExecution} (the background worker), but the
 * interactive session actor reuses one Cursor session per `threadId` across
 * turns. On the thread's first turn we `Agent.create`; on every subsequent turn
 * we `Agent.resume` by the previously observed agent id so conversation state
 * persists inside the warm single-activation actor. The grounded checkout is
 * opened once by the caller and reused; this factory only owns the per-turn
 * agent lifecycle (created here, disposed by the caller after each turn).
 */
import { Agent } from '@cursor/sdk';
import type { LocalAgentOptions } from '@cursor/sdk/dist/cjs/options.js';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type {
  WorkerCursorExecution,
  WorkerCursorExecutionRun,
} from '../aiRunsWorker/cursorExecution';
import type { LocalCheckoutReader } from '../localCheckoutReader';
import { createNativeReadTools } from '../nativeReadToolAdapter';

export async function createInteractiveCursorExecution(
  snapshot: Readonly<ExecutionSnapshot>,
  checkout: LocalCheckoutReader,
  options: { resumeAgentId?: string | null } = {},
): Promise<WorkerCursorExecution & { agentId?: string | null }> {
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
  // The interactive host uses only checkout-backed read tools and never
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

  try {
    const run = await agent.send(snapshot.prompt);
    return {
      run: run as unknown as WorkerCursorExecutionRun,
      agentId,
      dispose: () => agent[Symbol.asyncDispose](),
    };
  } catch (error) {
    await agent[Symbol.asyncDispose]().catch(() => {});
    throw error;
  }
}
