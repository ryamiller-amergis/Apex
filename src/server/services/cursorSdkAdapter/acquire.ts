import { Agent, createAgentPlatform } from '@cursor/sdk';
import { AdapterAgentCache } from './agentCache';
import { buildSdkAgentOptions, validateAdapterSpecification } from './options';
import {
  AdapterResumeStalledError,
  type AdapterAcquireInput,
  type AdapterAgent,
  type AdapterRun,
  type AdapterSendOptions,
  type AdapterSpecification,
  type AdapterUsage,
  type CursorSdkAdapter,
  type CursorSdkAdapterOptions,
  type SDKAgent,
  type SendOptions,
  type SteerAckOutcome,
} from './types';

function readCursorApiKey(): string {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY is required');
  }
  return apiKey;
}

export function isCursorAgentNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 'agent_not_found' || name === 'AgentNotFoundError';
}

function startupAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('Cursor agent acquisition aborted');
  error.name = 'AbortError';
  return error;
}

async function raceStartup<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onLateValue: (value: T) => Promise<void>,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.then((late) => onLateValue(late)).catch(() => {});
    throw startupAbortError(signal.reason);
  }
  let aborted = false;
  let rejectAbort!: (error: Error) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    aborted = true;
    rejectAbort(startupAbortError(signal.reason));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  void operation
    .then((value) => {
      if (aborted) {
        return onLateValue(value);
      }
      return undefined;
    })
    .catch(() => {});
  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

interface InternalWrappedHandle {
  readonly agentId: string | null;
  readonly workspaceRef: string;
  readonly compatibilityKey: string;
  toAdapterAgent(
    mode: 'warm' | 'resumed' | 'recreated',
    requestId: string,
  ): AdapterAgent;
  dispose(): Promise<void>;
}

function wrapSdkAgent(
  sdkAgent: SDKAgent,
  spec: AdapterSpecification,
  fallbackAgentId: string | null,
): InternalWrappedHandle {
  const resolvedId =
    (sdkAgent as unknown as { id?: string | null; agentId?: string | null }).id
    ?? sdkAgent.agentId
    ?? fallbackAgentId
    ?? null;

  let disposed = false;
  let activeRun: AdapterRun | null = null;
  let activeSummaryRun: AdapterRun | null = null;

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    activeRun = null;
    activeSummaryRun = null;
    await sdkAgent[Symbol.asyncDispose]().catch(() => {});
  };

  return {
    agentId: resolvedId,
    workspaceRef: spec.workspaceRef,
    compatibilityKey: spec.compatibilityKey,
    dispose,
    toAdapterAgent(
      mode: 'warm' | 'resumed' | 'recreated',
      requestId: string,
    ): AdapterAgent {
      return {
        agentId: resolvedId,
        mode,
        workspaceRef: spec.workspaceRef,
        compatibilityKey: spec.compatibilityKey,
        async send(
          prompt: string,
          options?: AdapterSendOptions,
        ): Promise<AdapterRun> {
          if (disposed) {
            throw new Error('Cursor SDK adapter agent handle is disposed');
          }
          const effectiveRequestId = options?.requestId?.trim() || requestId;
          const sendOptions: SendOptions = {
            idempotencyKey: effectiveRequestId,
            ...(options?.onDelta
              ? { onDelta: ({ update }) => options.onDelta!(update) }
              : {}),
            ...(options?.mcpServers
              ? { mcpServers: { ...options.mcpServers } }
              : {}),
          };
          const run = await sdkAgent.send(prompt, sendOptions);
          activeRun = run;
          return run;
        },
        async steer(text: string): Promise<SteerAckOutcome | undefined> {
          if (disposed) {
            throw new Error('Cursor SDK adapter agent handle is disposed');
          }
          if (!activeRun?.steer) return undefined;
          return activeRun.steer(text);
        },
        async summarize(): Promise<AdapterRun> {
          if (disposed) {
            throw new Error('Cursor SDK adapter agent handle is disposed');
          }
          const summaryRun = await sdkAgent.summarize();
          activeSummaryRun = summaryRun;
          return summaryRun;
        },
        async cancel(): Promise<void> {
          if (activeRun) {
            await activeRun.cancel();
            return;
          }
          if (activeSummaryRun) {
            await activeSummaryRun.cancel();
          }
        },
        async readUsage(): Promise<AdapterUsage | undefined> {
          if (typeof sdkAgent.getUsage === 'function') {
            try {
              const agentUsage = await sdkAgent.getUsage();
              if (agentUsage?.usage) {
                return {
                  ...agentUsage.usage,
                  ...(agentUsage.cost ? { cost: agentUsage.cost } : {}),
                };
              }
            } catch {
              // Fall back to the latest run's cumulative token usage when getUsage is unsupported.
            }
          }
          if (activeRun?.usage) {
            return { ...activeRun.usage };
          }
          return undefined;
        },
        dispose,
      };
    },
  };
}

export function createCursorSdkAdapter(
  options: CursorSdkAdapterOptions = {},
): CursorSdkAdapter {
  const cache = new AdapterAgentCache<InternalWrappedHandle>(
    options.cacheMax ?? 32,
  );
  const prewarmReleases: Array<() => Promise<void>> = [];

  return {
    async acquire(
      spec: AdapterSpecification,
      input: AdapterAcquireInput = {},
    ): Promise<AdapterAgent> {
      validateAdapterSpecification(spec);

      const warm = cache.getCompatible(spec.sessionKey, spec.compatibilityKey);
      if (warm) {
        return warm.toAdapterAgent('warm', spec.requestId);
      }

      const stale = cache.peek(spec.sessionKey);
      if (stale) {
        await cache.release(spec.sessionKey);
      }

      const apiKey = readCursorApiKey();
      const agentOptions = buildSdkAgentOptions(apiKey, spec, input);
      const candidateResumeId = spec.priorAgentBinding?.trim() || null;
      const resumeId =
        candidateResumeId && !cache.isUnresumable(candidateResumeId)
          ? candidateResumeId
          : null;

      if (resumeId) {
        input.onProgress?.('Resuming agent…');
        try {
          const resumed = await raceStartup(
            Agent.resume(resumeId, agentOptions),
            input.signal,
            (lateAgent) => lateAgent[Symbol.asyncDispose]().catch(() => {}),
          );
          const wrapped = wrapSdkAgent(resumed, spec, resumeId);
          await cache.put(spec.sessionKey, spec.compatibilityKey, wrapped);
          return wrapped.toAdapterAgent('resumed', spec.requestId);
        } catch (error) {
          if (input.signal?.aborted) {
            cache.markUnresumable(resumeId);
            throw new AdapterResumeStalledError(resumeId, error);
          }
          if (!isCursorAgentNotFound(error)) {
            throw error;
          }
          cache.markUnresumable(resumeId);
        }
      }

      input.onProgress?.('Starting agent…');
      const created = await raceStartup(
        Agent.create(agentOptions),
        input.signal,
        (lateAgent) => lateAgent[Symbol.asyncDispose]().catch(() => {}),
      );
      const wrapped = wrapSdkAgent(created, spec, null);
      await cache.put(spec.sessionKey, spec.compatibilityKey, wrapped);
      return wrapped.toAdapterAgent('recreated', spec.requestId);
    },

    async prewarm(spec: AdapterSpecification): Promise<void> {
      validateAdapterSpecification(spec);
      const apiKey = readCursorApiKey();
      const agentOptions = buildSdkAgentOptions(apiKey, spec);
      const platform = await createAgentPlatform();
      const release = await platform.prewarmLocalWorkspace(agentOptions);
      prewarmReleases.push(release);
    },

    markUnresumable(agentId: string): void {
      cache.markUnresumable(agentId);
    },

    isUnresumable(agentId: string): boolean {
      return cache.isUnresumable(agentId);
    },

    async release(sessionKey: string): Promise<void> {
      await cache.release(sessionKey);
    },

    async evictIdle(idleCutoffMs: number): Promise<string[]> {
      return cache.evictIdle(idleCutoffMs);
    },

    async disposeAll(): Promise<void> {
      const releases = prewarmReleases.splice(0, prewarmReleases.length);
      await Promise.all([
        cache.clear(),
        ...releases.map((release) => release().catch(() => {})),
      ]);
    },
  };
}
