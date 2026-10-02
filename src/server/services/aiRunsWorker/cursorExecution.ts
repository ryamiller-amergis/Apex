import { Agent } from '@cursor/sdk';
import type { LocalAgentOptions } from '@cursor/sdk/dist/cjs/options.js';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type { RepoReader } from '../../../shared/types/repoReader';
import type { CursorExecutionRun } from '../cursorExecutionCore';
import { createNativeReadTools } from '../nativeReadToolAdapter';
import { buildCursorModelSelection } from '../agentEffortResolver';

export type WorkerCursorExecutionRun = CursorExecutionRun & {
  cancel?(): Promise<void>;
};

export type WorkerCursorExecution = {
  run: WorkerCursorExecutionRun;
  dispose(): Promise<void>;
};

function cursorStartupAbortError(): Error {
  const error = new Error('Cursor execution startup aborted');
  error.name = 'AbortError';
  return error;
}

async function raceCursorStartup<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void>,
  onLateValue?: (value: T) => Promise<void>,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw cursorStartupAbortError();
  let aborted = false;
  let rejectAbort!: (error: Error) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = (): void => {
    aborted = true;
    void onAbort().catch(() => undefined);
    rejectAbort(cursorStartupAbortError());
  };
  signal.addEventListener('abort', handleAbort, { once: true });
  void operation.then((value) => {
    if (aborted) void onLateValue?.(value).catch(() => undefined);
  }).catch(() => undefined);
  try {
    return await Promise.race([operation, abort]);
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

/**
 * Construct the real local Cursor agent from only frozen bootstrap values.
 * Repository-grounded callers pass `checkout` only after opening the pinned
 * snapshot. Scratch-only document workflows omit it and receive no repo tools.
 *
 * cwd is the thin writable scratch (`workspaceRef`); repo reads go through
 * native tools backed by a bare mirror, HTTP, or a working-tree checkout.
 */
export async function createLocalCursorExecution(
  snapshot: Readonly<ExecutionSnapshot>,
  checkout?: RepoReader,
  signal?: AbortSignal,
): Promise<WorkerCursorExecution> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) throw new Error('CURSOR_API_KEY is required');

  const local = {
    cwd: snapshot.workspaceRef,
    settingSources: ['project'],
    ...(checkout ? { customTools: createNativeReadTools(checkout) } : {}),
  } satisfies LocalAgentOptions;

  const createAgent = Agent.create({
      apiKey,
      model: buildCursorModelSelection(snapshot.model, snapshot.effort),
      local,
      // The worker never resolves live repository MCP servers.
      mcpServers: {},
    });
  const agent = await raceCursorStartup(
    createAgent,
    signal,
    async () => undefined,
    (lateAgent) => lateAgent[Symbol.asyncDispose](),
  );

  try {
    const run = await raceCursorStartup(
      agent.send(snapshot.prompt),
      signal,
      () => agent[Symbol.asyncDispose](),
    );
    return {
      run: run as unknown as WorkerCursorExecutionRun,
      dispose: () => agent[Symbol.asyncDispose](),
    };
  } catch (error) {
    await agent[Symbol.asyncDispose]().catch(() => {});
    throw error;
  }
}
