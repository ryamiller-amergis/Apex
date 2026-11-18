/**
 * FEAT-001 / TBI-002 — Interactive actor host caller over `cursorSdkAdapter`.
 *
 * Imports zero symbols from `@cursor/sdk` directly; all SDK creation, resume,
 * and execution go through `src/server/services/cursorSdkAdapter/`.
 */
import type { EffortLevel } from '../../../shared/types/effort';
import type { InterviewRepositoryPhase } from '../../../shared/types/interview';
import type { RepoReader } from '../../../shared/types/repoReader';
import type { WorkerCursorExecutionRun } from '../aiRunsWorker/cursorExecution';
import { createNativeReadTools } from '../nativeReadToolAdapter';
import { guidedInterviewRepositoryTools } from '../interviewGroundingPolicy';
import { buildCursorModelSelection } from '../agentEffortResolver';
import {
  createCursorSdkAdapter,
  deriveInteractiveCursorExecutionFields,
  type AdapterSandboxSpecification,
  type McpServerConfig,
} from '../cursorSdkAdapter';

/** Live Cursor Agent handle that can serve multiple serialized `send` calls. */
export interface InteractiveCursorAgentHandle {
  agentId: string | null;
  model: string;
  workspaceRef: string;
  /** Guided interview phase the agent's repository tools were built for. */
  interviewPhase?: InterviewRepositoryPhase | null;
  send(
    prompt: string,
    options?: InteractiveSendOptions,
  ): Promise<WorkerCursorExecutionRun>;
  steer?(text: string): Promise<unknown>;
  summarize?(): Promise<unknown>;
  cancel?(): Promise<void>;
  readUsage?(): Promise<unknown>;
  dispose(): Promise<void>;
}

export type InteractiveSendOptions = {
  onDelta?(update: unknown): Promise<void> | void;
  /** Tool proxy URLs carry a per-attempt token, so a reused agent needs this turn's set. */
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** Per-turn request id so warm cached handles forward the current run's id on every send. */
  requestId?: string;
};

export type InteractiveAgentAcquisition =
  | Readonly<{ mode: 'warm'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'resumed'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'recreated'; handle: InteractiveCursorAgentHandle }>;

export type InteractiveCursorAcquireInput = Readonly<{
  model: string;
  effort: EffortLevel | null;
  workspaceRef: string;
  /** Null outside guided interviews; selects the phase's repository tools. */
  interviewPhase: InterviewRepositoryPhase | null;
  sessionKey?: string;
  compatibilityKey?: string;
  requestId?: string;
  toolAllowlist?: readonly string[] | null;
  disallowedTools?: readonly string[];
  settingSources?: readonly string[];
  sandbox?: AdapterSandboxSpecification;
}>;

export type InteractiveCursorAcquireOptions = Readonly<{
  resumeAgentId?: string | null;
  mcpServers: Readonly<Record<string, McpServerConfig>>;
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
}>;

export async function acquireInteractiveCursorAgent(
  input: InteractiveCursorAcquireInput,
  checkout: RepoReader,
  options: InteractiveCursorAcquireOptions,
): Promise<InteractiveAgentAcquisition> {
  // Stateless single-turn adapter instance (cacheMax: 0) when called directly;
  // the session actor holds its own warm cache lifecycle.
  const adapter = createCursorSdkAdapter({ cacheMax: 0 });
  const mcpServerNames = Object.keys(options.mcpServers);
  const derived = deriveInteractiveCursorExecutionFields({
    mcpServerNames,
    interviewPhase: input.interviewPhase,
  });
  const toolAllowlist =
    input.toolAllowlist !== undefined ? input.toolAllowlist : derived.toolAllowlist;
  const disallowedTools =
    input.disallowedTools !== undefined ? input.disallowedTools : derived.disallowedTools;
  const settingSources =
    input.settingSources !== undefined ? input.settingSources : derived.settingSources;
  const sandbox = input.sandbox ?? derived.sandbox;

  const mcpOnly =
    toolAllowlist !== null && toolAllowlist.length === 1 && toolAllowlist[0] === 'mcp';
  const customTools = mcpOnly
    ? undefined
    : input.interviewPhase
      ? guidedInterviewRepositoryTools(input.interviewPhase, checkout)
      : createNativeReadTools(checkout);

  const sessionKey = input.sessionKey?.trim() || input.workspaceRef || 'interactive';
  const compatibilityKey =
    input.compatibilityKey?.trim()
    || `${input.model}|${input.workspaceRef}|${input.interviewPhase ?? 'none'}`;
  const requestId = input.requestId?.trim() || sessionKey;

  const acquired = await adapter.acquire(
    {
      sessionKey,
      compatibilityKey,
      model: buildCursorModelSelection(input.model, input.effort ?? undefined),
      workspaceRef: input.workspaceRef,
      skillContent: null,
      toolAllowlist,
      disallowedTools,
      settingSources,
      sandbox,
      mcpServers: options.mcpServers,
      priorAgentBinding: options.resumeAgentId?.trim() || null,
      requestId,
    },
    {
      ...(customTools ? { customTools } : {}),
      signal: options.signal,
      onProgress: options.onProgress,
    },
  );

  const handle: InteractiveCursorAgentHandle = {
    agentId: acquired.agentId,
    model: input.model,
    workspaceRef: input.workspaceRef,
    interviewPhase: input.interviewPhase,
    send: async (prompt, sendOpts) =>
      (await acquired.send(prompt, {
        onDelta: sendOpts?.onDelta,
        mcpServers: sendOpts?.mcpServers,
        requestId: sendOpts?.requestId,
      })) as unknown as WorkerCursorExecutionRun,
    steer: (text) => acquired.steer(text),
    summarize: () => acquired.summarize(),
    cancel: () => acquired.cancel(),
    readUsage: () => acquired.readUsage(),
    dispose: () => acquired.dispose(),
  };

  return {
    mode: acquired.mode,
    handle,
  };
}
