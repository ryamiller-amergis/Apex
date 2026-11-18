import { createHash } from 'node:crypto';
import { Agent, type ToolName } from '@cursor/sdk';
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

/** True when this step is expected to run Azure CLI, so the worker must sign the CLI in first. */
export function playbookAgentNeedsAzureCli(snapshot: Readonly<ExecutionSnapshot>): boolean {
  const rawPolicy: unknown = snapshot.playbookAgentPolicy;
  const policy = rawPolicy && isPlaybookAgentRunPolicy(rawPolicy) ? rawPolicy : undefined;
  const investigationSkill = [snapshot.skillPath, policy?.skill.path].some((skillPath) =>
    (skillPath ?? '').replace(/\\/g, '/').includes('maxview-incident-investigation'),
  );
  return Boolean(policy?.capabilities.includes('azure-cli')) || investigationSkill;
}

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
  // The worker container has no local sandbox. enabled: false also overrides
  // ~/.cursor/sandbox.json, which otherwise requests sandboxing and fails the turn.
  // A Skill that declared azure-cli, and the MaxView investigation skill, need the
  // shell for `az`. Every other enforced Skill has the shell tool removed.
  const shellAllowed = !enforcing || playbookAgentNeedsAzureCli(snapshot);

  const local = {
    cwd: snapshot.workspaceRef,
    settingSources: enforcing ? [] : ['project'],
    sandboxOptions: { enabled: false },
    ...(checkout && nativeReadsAllowed ? { customTools: createNativeReadTools(checkout) } : {}),
  } satisfies LocalAgentOptions;

  const createAgent = Agent.create({
      apiKey,
      model: buildCursorModelSelection(snapshot.model, snapshot.effort),
      local,
      // The worker never resolves live repository MCP servers.
      mcpServers: {},
      ...(shellAllowed ? {} : { disallowedTools: ['shell' as ToolName] }),
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
