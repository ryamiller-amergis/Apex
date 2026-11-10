import type {
  ProviderMutationResult,
  SandboxLifecyclePhase,
  SandboxProvider,
  SandboxProvisionSpec,
  SandboxSnapshot,
} from './buildPreviewProviderContracts';

export interface InMemorySandboxProviderOptions {
  now?: () => Date;
  stallProvisioning?: boolean;
  provisioningTimeoutMs?: number;
}

interface SandboxRecord {
  handle: string;
  acceptedAtMs: number;
  snapshot: SandboxSnapshot;
}

interface MutationRecord {
  payload: string;
  result: ProviderMutationResult;
}

export interface InMemorySandboxProvider extends SandboxProvider {
  readonly sandboxCount: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function providerError(
  code: 'conflict' | 'invalid_argument' | 'not_found',
  message: string,
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

export function createInMemorySandboxProvider(
  options: InMemorySandboxProviderOptions = {},
): InMemorySandboxProvider {
  const now = options.now ?? (() => new Date());
  const provisioningTimeoutMs = options.provisioningTimeoutMs ?? 180_000;
  const sandboxes = new Map<string, SandboxRecord>();
  const mutations = new Map<string, MutationRecord>();
  let nextSandbox = 1;
  let nextOperation = 1;

  const applyMutation = (
    operation: string,
    idempotencyKey: string,
    payload: unknown,
    apply: () => ProviderMutationResult,
  ): ProviderMutationResult => {
    const key = `${operation}:${idempotencyKey}`;
    const serialized = JSON.stringify(payload);
    const previous = mutations.get(key);
    if (previous) {
      if (previous.payload !== serialized) {
        return providerError(
          'conflict',
          `Idempotency key ${idempotencyKey} was already used with different input.`,
        );
      }
      return clone(previous.result);
    }
    const result = apply();
    mutations.set(key, { payload: serialized, result: clone(result) });
    return clone(result);
  };

  const accepted = (handle: string): ProviderMutationResult => ({
    ok: true,
    accepted: {
      operationId: `operation_${nextOperation++}`,
      phase: 'accepted',
      handle,
    },
  });

  const mutateLifecycle = (
    operation: string,
    input: { idempotencyKey: string; handle: string },
    allowed: readonly SandboxLifecyclePhase[],
    next: SandboxLifecyclePhase,
  ): ProviderMutationResult =>
    applyMutation(operation, input.idempotencyKey, input, () => {
      const record = sandboxes.get(input.handle);
      if (!record) {
        return providerError('not_found', `Sandbox ${input.handle} was not found.`);
      }
      if (!allowed.includes(record.snapshot.lifecycle)) {
        return providerError(
          'invalid_argument',
          `Cannot ${operation} a sandbox in ${record.snapshot.lifecycle}.`,
        );
      }
      record.snapshot.lifecycle = next;
      if (next === 'terminated') {
        record.snapshot.applicationTarget = null;
        record.snapshot.bootstrapChannelRef = null;
      }
      return accepted(input.handle);
    });

  const provider: InMemorySandboxProvider = {
    get sandboxCount() {
      return sandboxes.size;
    },

    async provision(input) {
      return applyMutation(
        'provision',
        input.idempotencyKey,
        input,
        () => {
          const handle = `sandbox_${nextSandbox++}`;
          const lifecycle: SandboxLifecyclePhase = options.stallProvisioning
            ? 'provisioning'
            : 'running';
          sandboxes.set(handle, {
            handle,
            acceptedAtMs: now().getTime(),
            snapshot: {
              spec: clone(input.spec),
              lifecycle,
              applicationTarget:
                lifecycle === 'running'
                  ? {
                      upstreamRef: `sandbox-upstream:${handle}`,
                      health: {
                        livenessPath: '/health/live',
                        readinessPath: '/health/ready',
                        applicationPort: 3000,
                      },
                    }
                  : null,
              bootstrapChannelRef: `sandbox-bootstrap:${handle}`,
              expiresAt: input.spec.expiresAt,
              failureCode: null,
            },
          });
          return accepted(handle);
        },
      );
    },

    async inspect(input) {
      const record = sandboxes.get(input.handle);
      if (!record) {
        return {
          handle: input.handle,
          phase: 'unknown',
          snapshot: null,
          error: {
            code: 'not_found',
            message: `Sandbox ${input.handle} was not found.`,
            retryable: false,
          },
          observedAt: now().toISOString(),
        };
      }

      if (
        record.snapshot.lifecycle === 'provisioning'
        && now().getTime() - record.acceptedAtMs > provisioningTimeoutMs
      ) {
        record.snapshot.lifecycle = 'failed';
        record.snapshot.failureCode = 'timeout';
      }

      const phase =
        record.snapshot.lifecycle === 'failed'
          ? 'failed'
          : record.snapshot.lifecycle === 'provisioning'
            ? 'running'
            : 'succeeded';
      return {
        handle: input.handle,
        phase,
        snapshot: clone(record.snapshot),
        error:
          phase === 'failed'
            ? {
                code: record.snapshot.failureCode ?? 'internal_error',
                message: 'Sandbox provisioning failed.',
                retryable: false,
              }
            : null,
        observedAt: now().toISOString(),
      };
    },

    async renew(input) {
      return applyMutation('renew', input.idempotencyKey, input, () => {
        const record = sandboxes.get(input.handle);
        if (!record) {
          return providerError('not_found', `Sandbox ${input.handle} was not found.`);
        }
        if (['terminated', 'failed', 'expired'].includes(record.snapshot.lifecycle)) {
          return providerError(
            'invalid_argument',
            `Cannot renew a sandbox in ${record.snapshot.lifecycle}.`,
          );
        }
        record.snapshot.expiresAt = input.expiresAt;
        record.snapshot.spec = {
          ...record.snapshot.spec,
          expiresAt: input.expiresAt,
        };
        return accepted(input.handle);
      });
    },

    async suspend(input) {
      return mutateLifecycle('suspend', input, ['running'], 'suspended');
    },

    async resume(input) {
      return mutateLifecycle('resume', input, ['suspended'], 'running');
    },

    async destroy(input) {
      return mutateLifecycle(
        'destroy',
        input,
        ['provisioning', 'starting', 'running', 'suspended', 'terminating'],
        'terminated',
      );
    },
  };

  return provider;
}

export type { SandboxProvisionSpec };
