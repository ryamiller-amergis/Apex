import type {
  EditablePreviewSessionLifecycle,
  EditablePreviewSessionProvider,
  EditablePreviewSessionSnapshot,
  ProviderErrorCode,
  ProviderMutationResult,
} from './buildPreviewProviderContracts';
import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  evaluateEditablePreviewReadiness,
} from './buildPreviewProviderContracts';

interface SessionRecord {
  handle: string;
  snapshot: EditablePreviewSessionSnapshot;
}

interface MutationRecord {
  payload: string;
  result: ProviderMutationResult;
}

export interface InMemoryEditablePreviewSessionProviderOptions {
  now?: () => Date;
}

export interface InMemoryEditablePreviewSessionProvider extends EditablePreviewSessionProvider {
  readonly sessionCount: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function providerError(
  code: ProviderErrorCode,
  message: string
): ProviderMutationResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

function inspectPhase(
  lifecycle: EditablePreviewSessionLifecycle
): 'running' | 'succeeded' | 'failed' {
  if (lifecycle === 'failed') return 'failed';
  if (['ready', 'suspended', 'terminated', 'expired'].includes(lifecycle)) {
    return 'succeeded';
  }
  return 'running';
}

export function createInMemoryEditablePreviewSessionProvider(
  options: InMemoryEditablePreviewSessionProviderOptions = {}
): InMemoryEditablePreviewSessionProvider {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, SessionRecord>();
  const handlesBySessionId = new Map<string, string>();
  const mutations = new Map<string, MutationRecord>();
  let nextSession = 1;
  let nextOperation = 1;

  const accepted = (handle: string): ProviderMutationResult => ({
    ok: true,
    accepted: {
      operationId: `editable-preview-operation-${nextOperation++}`,
      phase: 'accepted',
      handle,
    },
  });

  const applyMutation = (
    operation: string,
    idempotencyKey: string,
    payload: unknown,
    apply: () => ProviderMutationResult
  ): ProviderMutationResult => {
    const key = `${operation}:${idempotencyKey}`;
    const serialized = JSON.stringify(payload);
    const previous = mutations.get(key);
    if (previous) {
      if (previous.payload !== serialized) {
        return providerError(
          'conflict',
          `Idempotency key ${idempotencyKey} was already used with different input.`
        );
      }
      return clone(previous.result);
    }
    const result = apply();
    mutations.set(key, { payload: serialized, result: clone(result) });
    return clone(result);
  };

  const transport = (handle: string) => ({
    upstreamRef: `studio-upstream:${handle}`,
    checks: {
      http: 'ready' as const,
      websocket: 'ready' as const,
      vite_hmr: 'ready' as const,
    },
  });

  const activeRecord = (
    handle: string,
    operation: string
  ): SessionRecord | ProviderMutationResult => {
    const record = sessions.get(handle);
    if (!record) {
      return providerError(
        'not_found',
        `Editable preview session ${handle} was not found.`
      );
    }
    if (
      ['terminated', 'failed', 'expired'].includes(record.snapshot.lifecycle)
    ) {
      return providerError(
        'invalid_argument',
        `Cannot ${operation} a session in ${record.snapshot.lifecycle}.`
      );
    }
    return record;
  };

  const mutateLifecycle = (
    operation: string,
    input: { idempotencyKey: string; handle: string },
    allowed: readonly EditablePreviewSessionLifecycle[],
    next: EditablePreviewSessionLifecycle
  ): ProviderMutationResult =>
    applyMutation(operation, input.idempotencyKey, input, () => {
      const candidate = activeRecord(input.handle, operation);
      if (!('snapshot' in candidate)) return candidate;
      if (!allowed.includes(candidate.snapshot.lifecycle)) {
        return providerError(
          'invalid_argument',
          `Cannot ${operation} a session in ${candidate.snapshot.lifecycle}.`
        );
      }
      candidate.snapshot.lifecycle = next;
      candidate.snapshot.transport =
        next === 'ready' ? transport(input.handle) : null;
      if (next === 'terminated') {
        candidate.snapshot.workspace.writable = false;
      }
      return accepted(input.handle);
    });

  const provider: InMemoryEditablePreviewSessionProvider = {
    get sessionCount() {
      return sessions.size;
    },

    async start(input) {
      return applyMutation('start', input.idempotencyKey, input, () => {
        const nowMs = now().getTime();
        const expiresAtMs = Date.parse(input.spec.expiresAt);
        const maxExpiresAtMs =
          nowMs + input.spec.policy.maxRuntimeSeconds * 1_000;
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= nowMs ||
          expiresAtMs > maxExpiresAtMs
        ) {
          return providerError(
            'invalid_argument',
            'Session expiry must be in the future and within maxRuntimeSeconds.'
          );
        }
        if (
          EDITABLE_PREVIEW_REQUIRED_TRANSPORTS.some(
            (required) => !input.spec.requiredTransports.includes(required)
          )
        ) {
          return providerError(
            'invalid_argument',
            'Editable sessions require HTTP, WebSocket, and Vite HMR transports.'
          );
        }
        if (handlesBySessionId.has(input.spec.correlation.sessionId)) {
          return providerError(
            'conflict',
            `Session ${input.spec.correlation.sessionId} already exists.`
          );
        }

        const handle = `editable-preview-session-${nextSession++}`;
        const snapshot: EditablePreviewSessionSnapshot = {
          spec: clone(input.spec),
          lifecycle: 'ready',
          workspace: {
            writable: true,
            version: 0,
            baseSnapshotDigest: input.spec.source.snapshotDigest,
            appliedChangeSets: [],
          },
          transport: transport(handle),
          expiresAt: input.spec.expiresAt,
          failureCode: null,
        };
        const readiness = evaluateEditablePreviewReadiness(snapshot);
        if (!readiness.ready) {
          return providerError(
            'invalid_argument',
            `Editable session is not portable: ${readiness.reason}.`
          );
        }
        sessions.set(handle, { handle, snapshot });
        handlesBySessionId.set(input.spec.correlation.sessionId, handle);
        return accepted(handle);
      });
    },

    async inspect(input) {
      const record = sessions.get(input.handle);
      if (!record) {
        return {
          handle: input.handle,
          phase: 'unknown',
          snapshot: null,
          error: {
            code: 'not_found',
            message: `Editable preview session ${input.handle} was not found.`,
            retryable: false,
          },
          observedAt: now().toISOString(),
        };
      }
      if (
        !['terminated', 'failed', 'expired'].includes(
          record.snapshot.lifecycle
        ) &&
        Date.parse(record.snapshot.expiresAt) <= now().getTime()
      ) {
        record.snapshot.lifecycle = 'expired';
        record.snapshot.workspace.writable = false;
        record.snapshot.transport = null;
      }
      const phase = inspectPhase(record.snapshot.lifecycle);
      return {
        handle: record.handle,
        phase,
        snapshot: clone(record.snapshot),
        error:
          phase === 'failed'
            ? {
                code: record.snapshot.failureCode ?? 'internal_error',
                message: 'Editable preview session failed.',
                retryable: false,
              }
            : null,
        observedAt: now().toISOString(),
      };
    },

    async applyChangeSet(input) {
      return applyMutation(
        'apply-change-set',
        input.idempotencyKey,
        input,
        () => {
          const candidate = activeRecord(input.handle, 'apply a change set to');
          if (!('snapshot' in candidate)) return candidate;
          if (candidate.snapshot.lifecycle !== 'ready') {
            return providerError(
              'not_ready',
              `Cannot apply a change set in ${candidate.snapshot.lifecycle}.`
            );
          }
          if (
            candidate.snapshot.workspace.version !==
            input.expectedWorkspaceVersion
          ) {
            return providerError(
              'conflict',
              `Expected workspace version ${input.expectedWorkspaceVersion}, but the current version is ${candidate.snapshot.workspace.version}.`
            );
          }
          candidate.snapshot.lifecycle = 'applying_change';
          candidate.snapshot.workspace.appliedChangeSets = [
            ...candidate.snapshot.workspace.appliedChangeSets,
            clone(input.changeSet),
          ];
          candidate.snapshot.workspace.version += 1;
          candidate.snapshot.lifecycle = 'ready';
          return accepted(input.handle);
        }
      );
    },

    async runTask(input) {
      return applyMutation('run-task', input.idempotencyKey, input, () => {
        const candidate = activeRecord(input.handle, 'run a task in');
        if (!('snapshot' in candidate)) return candidate;
        if (candidate.snapshot.lifecycle !== 'ready') {
          return providerError(
            'not_ready',
            `Cannot run a task in ${candidate.snapshot.lifecycle}.`
          );
        }
        if (
          candidate.snapshot.workspace.version !==
          input.expectedWorkspaceVersion
        ) {
          return providerError(
            'conflict',
            `Expected workspace version ${input.expectedWorkspaceVersion}, but the current version is ${candidate.snapshot.workspace.version}.`
          );
        }
        return accepted(input.handle);
      });
    },

    async renew(input) {
      return applyMutation('renew', input.idempotencyKey, input, () => {
        const candidate = activeRecord(input.handle, 'renew');
        if (!('snapshot' in candidate)) return candidate;
        const expiresAtMs = Date.parse(input.expiresAt);
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= now().getTime() ||
          expiresAtMs >
            now().getTime() +
              candidate.snapshot.spec.policy.maxRuntimeSeconds * 1_000
        ) {
          return providerError(
            'invalid_argument',
            'Session renewal must be in the future and within maxRuntimeSeconds.'
          );
        }
        candidate.snapshot.expiresAt = input.expiresAt;
        candidate.snapshot.spec.expiresAt = input.expiresAt;
        return accepted(input.handle);
      });
    },

    async suspend(input) {
      return mutateLifecycle('suspend', input, ['ready'], 'suspended');
    },

    async resume(input) {
      return mutateLifecycle('resume', input, ['suspended'], 'ready');
    },

    async destroy(input) {
      return mutateLifecycle(
        'destroy',
        input,
        [
          'requested',
          'materializing',
          'installing',
          'starting',
          'ready',
          'applying_change',
          'restarting',
          'suspended',
          'terminating',
        ],
        'terminated'
      );
    },
  };

  return provider;
}
