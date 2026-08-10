import { Agent } from '@cursor/sdk';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type { CursorExecutionRun } from '../cursorExecutionCore';
import type { LocalCheckoutReader } from '../localCheckoutReader';

export type WorkerCursorExecutionRun = CursorExecutionRun & {
  cancel?(): Promise<void>;
};

export type WorkerCursorExecution = {
  run: WorkerCursorExecutionRun;
  dispose(): Promise<void>;
};

/**
 * Construct the real local Cursor agent from only frozen bootstrap values.
 * `checkout` is intentionally required: callers cannot create execution until
 * LocalCheckoutReader has successfully opened the ready workspace.
 */
export async function createLocalCursorExecution(
  snapshot: Readonly<ExecutionSnapshot>,
  checkout: LocalCheckoutReader,
): Promise<WorkerCursorExecution> {
  void checkout;
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const agent = await Agent.create({
    apiKey,
    model: { id: snapshot.model },
    local: {
      cwd: snapshot.workspaceRef,
      settingSources: ['project'],
    },
    // The worker never resolves live repository MCP servers.
    mcpServers: {},
  });

  try {
    const run = await agent.send(snapshot.prompt);
    return {
      run: run as unknown as WorkerCursorExecutionRun,
      dispose: () => agent[Symbol.asyncDispose](),
    };
  } catch (error) {
    await agent[Symbol.asyncDispose]().catch(() => {});
    throw error;
  }
}
