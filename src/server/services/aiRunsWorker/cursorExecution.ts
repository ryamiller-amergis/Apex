import { createHash } from 'node:crypto';
import { Agent } from '@cursor/sdk';
import type { LocalAgentOptions } from '@cursor/sdk/dist/cjs/options.js';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import { isPlaybookAgentRunPolicy } from '../../../shared/types/playbookExecutionCapability';
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
  const rawPolicy: unknown = snapshot.playbookAgentPolicy;
  if (rawPolicy !== undefined && !isPlaybookAgentRunPolicy(rawPolicy)) {
    throw new Error('Playbook agent run referenced an invalid frozen capability policy');
  }
  const policy = rawPolicy;
  // A recorded policy is audit data until enforcement is on. Observe mode keeps the
  // worker path that already shipped: project settings, no sandbox, and the prompt as given.
  const enforcing = policy?.enforcement === 'enforce';
  if (policy && enforcing) {
    if (!snapshot.skillContent || !snapshot.skillSha256) {
      throw new Error('Playbook agent run is missing its frozen Skill content');
    }
    const actualSkillSha = createHash('sha256')
      .update(snapshot.skillContent)
      .digest('hex');
    if (
      actualSkillSha !== snapshot.skillSha256.toLowerCase()
      || actualSkillSha !== policy.skill.sha256.toLowerCase()
    ) {
      throw new Error('Playbook agent run referenced Skill content with a mismatched hash');
    }
    if (
      policy.localAgent.cwdMode !== 'scratch'
      || policy.localAgent.allowBuiltinWrites
      || policy.capabilities.includes('repository-write')
      || policy.mcpServers.length > 0
    ) {
      throw new Error('Playbook agent policy is broader than the worker read-only execution lane');
    }
  }
  const nativeReadsAllowed =
    policy?.enforcement !== 'enforce'
    || policy.localAgent.customTools === 'native-read-only';

  const local = {
    cwd: snapshot.workspaceRef,
    settingSources: enforcing ? [] : ['project'],
    ...(enforcing ? { sandboxOptions: { enabled: true } } : {}),
    ...(checkout && nativeReadsAllowed ? { customTools: createNativeReadTools(checkout) } : {}),
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
    const prompt = enforcing && snapshot.skillContent && !snapshot.prompt.includes(snapshot.skillContent)
      ? `${snapshot.skillContent}\n\n---\n\n${snapshot.prompt}`
      : snapshot.prompt;
    const run = await raceCursorStartup(
      agent.send(prompt),
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
