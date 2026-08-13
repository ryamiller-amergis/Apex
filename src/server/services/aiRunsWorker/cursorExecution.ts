import { Agent } from '@cursor/sdk';
import type { LocalAgentOptions } from '@cursor/sdk/dist/cjs/options.js';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type { RepoReader } from '../../../shared/types/repoReader';
import type { CursorExecutionRun } from '../cursorExecutionCore';
import { createNativeReadTools } from '../nativeReadToolAdapter';

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
 * a RepoReader has successfully opened the pinned snapshot.
 *
 * cwd is the thin writable scratch (`workspaceRef`); repo reads go through
 * native tools backed by a bare mirror, HTTP, or a working-tree checkout.
 */
export async function createLocalCursorExecution(
  snapshot: Readonly<ExecutionSnapshot>,
  checkout: RepoReader,
): Promise<WorkerCursorExecution> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const local = {
    cwd: snapshot.workspaceRef,
    settingSources: ['project'],
    customTools: createNativeReadTools(checkout),
  } satisfies LocalAgentOptions;

  const agent = await Agent.create({
    apiKey,
    model: { id: snapshot.model },
    local,
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
