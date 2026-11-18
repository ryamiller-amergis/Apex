import { createHash } from 'node:crypto';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import { isPlaybookAgentRunPolicy } from '../../../shared/types/playbookExecutionCapability';
import type { RepoReader } from '../../../shared/types/repoReader';
import type { CursorExecutionRun } from '../cursorExecutionCore';
import { createNativeReadTools } from '../nativeReadToolAdapter';
import { buildCursorModelSelection } from '../agentEffortResolver';
import {
  createCursorSdkAdapter,
  deriveWorkerCursorExecutionFields,
  playbookStepNeedsAzureCli,
} from '../cursorSdkAdapter';

export type WorkerCursorExecutionRun = CursorExecutionRun & {
  cancel?(): Promise<void>;
};

export type WorkerCursorExecution = {
  run: WorkerCursorExecutionRun;
  dispose(): Promise<void>;
};

/** True when this step is expected to run Azure CLI, so the worker must sign the CLI in first. */
export function playbookAgentNeedsAzureCli(snapshot: Readonly<ExecutionSnapshot>): boolean {
  return playbookStepNeedsAzureCli(snapshot);
}

function cursorStartupAbortError(): Error {
  const error = new Error('Cursor execution startup aborted');
  error.name = 'AbortError';
  return error;
}

async function raceSendStartup<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void>,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw cursorStartupAbortError();
  let rejectAbort!: (error: Error) => void;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = (): void => {
    void onAbort().catch(() => undefined);
    rejectAbort(cursorStartupAbortError());
  };
  signal.addEventListener('abort', handleAbort, { once: true });
  try {
    return await Promise.race([operation, abort]);
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

/**
 * Construct the local Cursor agent from frozen bootstrap values by delegating
 * to `cursorSdkAdapter` (the sole V2-host module that imports `@cursor/sdk`).
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
  const derived = deriveWorkerCursorExecutionFields(snapshot);

  const adapter = createCursorSdkAdapter({ cacheMax: 0 });
  const sessionKey = snapshot.threadId?.trim() || 'worker-session';
  const requestId = snapshot.requestId?.trim() || sessionKey;
  const acquired = await adapter.acquire(
    {
      sessionKey,
      compatibilityKey: `${snapshot.model}|${snapshot.workspaceRef}|${snapshot.workflowClass}`,
      model: buildCursorModelSelection(snapshot.model, snapshot.effort),
      workspaceRef: snapshot.workspaceRef,
      skillContent: snapshot.skillContent ?? null,
      toolAllowlist:
        snapshot.toolAllowlist !== undefined ? snapshot.toolAllowlist : derived.toolAllowlist,
      disallowedTools:
        snapshot.disallowedTools !== undefined ? snapshot.disallowedTools : derived.disallowedTools,
      settingSources:
        snapshot.settingSources !== undefined ? snapshot.settingSources : derived.settingSources,
      sandbox: snapshot.sandbox ?? derived.sandbox,
      mcpServers: {},
      priorAgentBinding: null,
      requestId,
    },
    {
      ...(checkout && nativeReadsAllowed
        ? { customTools: createNativeReadTools(checkout) }
        : {}),
      signal,
    },
  );

  try {
    const prompt =
      enforcing && snapshot.skillContent && !snapshot.prompt.includes(snapshot.skillContent)
        ? `${snapshot.skillContent}\n\n---\n\n${snapshot.prompt}`
        : snapshot.prompt;
    const run = await raceSendStartup(
      acquired.send(prompt),
      signal,
      () => acquired.dispose(),
    );
    return {
      run: run as unknown as WorkerCursorExecutionRun,
      dispose: () => acquired.dispose(),
    };
  } catch (error) {
    await acquired.dispose().catch(() => {});
    throw error;
  }
}
