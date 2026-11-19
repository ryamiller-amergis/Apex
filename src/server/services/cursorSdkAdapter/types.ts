import type {
  AgentDefinition,
  AgentOptions,
  AgentUsage,
  InteractionUpdate,
  LocalAgentOptions,
  LocalSubagentInherit,
  McpServerConfig,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKCustomTool,
  SDKJsonValue,
  SDKMessage,
  SendOptions,
  SettingSource,
  SteerAckOutcome,
  TokenUsage,
  ToolName,
  UsageCost,
} from '@cursor/sdk';

export type {
  AgentDefinition,
  AgentOptions,
  AgentUsage,
  InteractionUpdate,
  LocalAgentOptions,
  LocalSubagentInherit,
  McpServerConfig,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKCustomTool,
  SDKJsonValue,
  SDKMessage,
  SendOptions,
  SettingSource,
  SteerAckOutcome,
  TokenUsage,
  ToolName,
  UsageCost,
};

export type AdapterModelSelection = ModelSelection;
export type AdapterMcpServer = McpServerConfig;
export type AdapterSubagentInherit = LocalSubagentInherit;

export type AdapterSandboxSpecification = Readonly<{
  enabled: boolean;
  /**
   * Preserves exact option parity with legacy interactive turns that did not
   * attach `sandboxOptions` when `interviewPhase` was null.
   */
  omitSandbox?: boolean;
}>;

export type AdapterSpecification = Readonly<{
  sessionKey: string;
  compatibilityKey: string;
  model: AdapterModelSelection;
  workspaceRef: string;
  skillContent: string | null;
  toolAllowlist: readonly string[] | null;
  disallowedTools: readonly string[];
  settingSources: readonly string[];
  sandbox: AdapterSandboxSpecification;
  mcpServers: Readonly<Record<string, AdapterMcpServer>>;
  priorAgentBinding: string | null;
  requestId: string;
  subagentInherit?: AdapterSubagentInherit;
  agents?: Readonly<Record<string, AgentDefinition>>;
}>;

export type AdapterAcquireInput = Readonly<{
  customTools?: Readonly<Record<string, SDKCustomTool>>;
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
}>;

export type AdapterSendOptions = Readonly<{
  onDelta?: (update: unknown) => Promise<void> | void;
  mcpServers?: Readonly<Record<string, AdapterMcpServer>>;
  requestId?: string;
}>;

export type AdapterUsage = Readonly<
  TokenUsage & {
    cost?: UsageCost;
  }
>;

export type AdapterRun = Run;

export interface AdapterAgent {
  readonly agentId: string | null;
  readonly mode: 'warm' | 'resumed' | 'recreated';
  readonly workspaceRef: string;
  readonly compatibilityKey: string;
  send(prompt: string, options?: AdapterSendOptions): Promise<AdapterRun>;
  steer(text: string): Promise<SteerAckOutcome | undefined>;
  summarize(): Promise<AdapterRun>;
  cancel(): Promise<void>;
  readUsage(): Promise<AdapterUsage | undefined>;
  dispose(): Promise<void>;
}

export interface CursorSdkAdapterOptions {
  cacheMax?: number;
}

export interface CursorSdkAdapter {
  acquire(
    spec: AdapterSpecification,
    input?: AdapterAcquireInput,
  ): Promise<AdapterAgent>;
  prewarm(spec: AdapterSpecification): Promise<void>;
  markUnresumable(agentId: string): void;
  isUnresumable(agentId: string): boolean;
  release(sessionKey: string): Promise<void>;
  evictIdle(idleCutoffMs: number, nowMs?: number): Promise<string[]>;
  disposeAll(): Promise<void>;
}

export class AdapterSpecificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterSpecificationError';
  }
}

export class AdapterResumeStalledError extends Error {
  readonly agentId: string;

  constructor(agentId: string, cause?: unknown) {
    super(`Cursor agent resume stalled for ${agentId}`);
    this.name = 'AdapterResumeStalledError';
    this.agentId = agentId;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}
