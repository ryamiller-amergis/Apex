import type {
  ProviderInspectResult,
  ProviderMutationResult,
  SandboxLifecyclePhase,
  SandboxProvider,
  SandboxSnapshot,
} from './buildPreviewProviderContracts';
import {
  acceptedMutation,
  bundleMount,
  clone,
  dockerLabels,
  dockerResourceLimits,
  dockerResourceName,
  DockerMutationLedger,
  isDockerResourceMissing,
  providerFailure,
  removeNetworkWhenUnused,
  withDockerEnvFile,
  type DockerApplicationResource,
  type DockerCommandRunner,
  type DockerPreviewResourceStore,
  type RuntimeBundleResolver,
} from './dockerPreviewRuntime';

interface DockerContainerState {
  Status?: string;
  Running?: boolean;
  Paused?: boolean;
  ExitCode?: number;
  Health?: {
    Status?: string;
  };
}

interface SandboxRecord {
  resource: DockerApplicationResource;
  snapshot: SandboxSnapshot;
}

export interface DockerSandboxProviderOptions {
  docker: DockerCommandRunner;
  resources: DockerPreviewResourceStore;
  previewRunnerImage: string;
  resolveRuntimeBundle: RuntimeBundleResolver;
  probe?: (url: string) => Promise<boolean>;
  now?: () => Date;
}

export interface DockerSandboxProvider extends SandboxProvider {
  readonly sandboxCount: number;
}

function parseContainerState(stdout: string): DockerContainerState {
  const value = JSON.parse(stdout.trim()) as unknown;
  if (!value || typeof value !== 'object') {
    throw new Error('Docker returned an invalid container state.');
  }
  return value as DockerContainerState;
}

function parsePublishedPort(stdout: string): {
  host: string;
  port: number;
} {
  const line = stdout.trim().split(/\r?\n/)[0] ?? '';
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(line);
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Docker did not return a loopback application port.');
  }
  return {
    host: match[1] === '[::1]' ? '::1' : match[1],
    port,
  };
}

function operationFailure(
  operation: string,
  error: unknown
): ProviderMutationResult {
  const message = error instanceof Error ? error.message : String(error);
  return providerFailure(
    'provider_unavailable',
    `Docker could not ${operation}.`,
    true,
    { reason: message.slice(0, 500) }
  );
}

export function createDockerSandboxProvider(
  options: DockerSandboxProviderOptions
): DockerSandboxProvider {
  const now = options.now ?? (() => new Date());
  const probe =
    options.probe ??
    (async (url: string) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    });
  const records = new Map<string, SandboxRecord>();
  const mutations = new DockerMutationLedger();
  let nextOperation = 1;

  const accepted = (handle: string): ProviderMutationResult =>
    acceptedMutation(`docker-sandbox-operation-${nextOperation++}`, handle);

  const mutateLifecycle = async (
    operation: 'suspend' | 'resume',
    input: { idempotencyKey: string; handle: string },
    allowed: readonly SandboxLifecyclePhase[],
    next: SandboxLifecyclePhase,
    dockerCommand: 'pause' | 'unpause'
  ): Promise<ProviderMutationResult> =>
    mutations.apply(operation, input.idempotencyKey, input, async () => {
      const record = records.get(input.handle);
      if (!record) {
        return providerFailure(
          'not_found',
          `Sandbox ${input.handle} was not found.`,
          false
        );
      }
      if (!allowed.includes(record.snapshot.lifecycle)) {
        return providerFailure(
          'invalid_argument',
          `Cannot ${operation} a sandbox in ${record.snapshot.lifecycle}.`,
          false
        );
      }
      try {
        await options.docker.run([
          dockerCommand,
          record.resource.containerName,
          record.resource.proxyContainerName,
        ]);
      } catch (error) {
        return operationFailure(`${operation} the preview application`, error);
      }
      record.snapshot.lifecycle = next;
      return accepted(input.handle);
    });

  const stopExpired = async (record: SandboxRecord): Promise<void> => {
    try {
      await options.docker.run([
        'rm',
        '--force',
        record.resource.proxyContainerName,
        record.resource.containerName,
      ]);
    } catch (error) {
      if (!isDockerResourceMissing(error)) {
        record.snapshot.lifecycle = 'failed';
        record.snapshot.failureCode = 'provider_unavailable';
        return;
      }
    }
    options.resources.deleteApplication(record.resource.previewInstanceId);
    try {
      await removeNetworkWhenUnused(
        options.docker,
        options.resources,
        record.resource.previewInstanceId,
        record.resource.networkName
      );
    } catch {
      record.snapshot.lifecycle = 'failed';
      record.snapshot.failureCode = 'provider_unavailable';
      return;
    }
    record.snapshot.lifecycle = 'expired';
    record.snapshot.applicationTarget = null;
    record.snapshot.bootstrapChannelRef = null;
  };

  const provider: DockerSandboxProvider = {
    get sandboxCount() {
      return records.size;
    },

    async provision(input) {
      return mutations.apply(
        'provision',
        input.idempotencyKey,
        input,
        async () => {
          if (input.spec.policy.egress !== 'denied') {
            return providerFailure(
              'policy_denied',
              'The local Docker provider supports denied egress only.',
              false
            );
          }
          const expiresAtMs = Date.parse(input.spec.expiresAt);
          const maxExpiresAtMs =
            now().getTime() + input.spec.policy.maxRuntimeSeconds * 1_000;
          if (
            !Number.isFinite(expiresAtMs) ||
            expiresAtMs <= now().getTime() ||
            expiresAtMs > maxExpiresAtMs
          ) {
            return providerFailure(
              'invalid_argument',
              'Sandbox expiry must be in the future and within maxRuntimeSeconds.',
              false
            );
          }
          const database = options.resources.getDatabase(
            input.spec.correlation.previewInstanceId
          );
          if (!database?.ready) {
            return providerFailure(
              'not_ready',
              'The preview database must be migrated and seeded before app provisioning.',
              true
            );
          }
          if (
            options.resources.getApplication(
              input.spec.correlation.previewInstanceId
            )
          ) {
            return providerFailure(
              'conflict',
              `Preview ${input.spec.correlation.previewInstanceId} already has an application.`,
              false
            );
          }

          const handle = `docker-sandbox:${input.spec.correlation.previewInstanceId}`;
          const containerName = dockerResourceName(
            'app',
            input.spec.correlation.previewInstanceId
          );
          const proxyContainerName = dockerResourceName(
            'proxy',
            input.spec.correlation.previewInstanceId
          );
          try {
            const source = await options.resolveRuntimeBundle(
              input.spec.runtimeBundleDigest
            );
            if (source.digest !== input.spec.runtimeBundleDigest) {
              return providerFailure(
                'invalid_argument',
                'Resolved runtime bundle digest does not match the request.',
                false
              );
            }
            await withDockerEnvFile(
              {
                APEX_PREVIEW_BUNDLE_DIGEST: source.digest,
                DATABASE_URL: database.databaseUrl,
                NODE_ENV: 'development',
                AUTH_MODE: 'development',
                CLIENT_DIST_DIR: '/session/web',
                OTEL_SDK_DISABLED: 'true',
                PORT: '3000',
              },
              (envFilePath) =>
                options.docker.run([
                  'run',
                  '--detach',
                  '--name',
                  containerName,
                  '--network',
                  database.networkName,
                  '--network-alias',
                  'preview-app',
                  ...dockerLabels(input.spec.correlation),
                  ...dockerResourceLimits('application'),
                  '--read-only',
                  '--cap-drop',
                  'ALL',
                  '--security-opt',
                  'no-new-privileges',
                  '--tmpfs',
                  '/session:rw,nosuid,size=536870912,uid=10001,gid=10001,mode=0750',
                  '--tmpfs',
                  '/tmp:rw,noexec,nosuid,size=67108864',
                  '--mount',
                  bundleMount(source.path),
                  '--env-file',
                  envFilePath,
                  '--health-cmd',
                  'node -e "fetch(\'http://127.0.0.1:3000/health/ready\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
                  '--health-interval',
                  '1s',
                  '--health-timeout',
                  '3s',
                  '--health-retries',
                  '60',
                  options.previewRunnerImage,
                  'start',
                ])
            );
            await withDockerEnvFile(
              {
                APEX_PREVIEW_UPSTREAM_HOST: 'preview-app',
                APEX_PREVIEW_UPSTREAM_PORT: '3000',
              },
              (envFilePath) =>
                options.docker.run([
                  'run',
                  '--detach',
                  '--name',
                  proxyContainerName,
                  ...dockerLabels(input.spec.correlation),
                  ...dockerResourceLimits('proxy'),
                  '--publish',
                  '127.0.0.1:0:3000',
                  '--read-only',
                  '--cap-drop',
                  'ALL',
                  '--security-opt',
                  'no-new-privileges',
                  '--tmpfs',
                  '/tmp:rw,noexec,nosuid,size=16777216',
                  '--env-file',
                  envFilePath,
                  options.previewRunnerImage,
                  'proxy',
                ])
            );
            await options.docker.run([
              'network',
              'connect',
              database.networkName,
              proxyContainerName,
            ]);

            const resource: DockerApplicationResource = {
              handle,
              previewInstanceId: input.spec.correlation.previewInstanceId,
              networkName: database.networkName,
              containerName,
              proxyContainerName,
            };
            const snapshot: SandboxSnapshot = {
              spec: clone(input.spec),
              lifecycle: 'starting',
              applicationTarget: null,
              bootstrapChannelRef: `docker-bootstrap:${handle}`,
              expiresAt: input.spec.expiresAt,
              failureCode: null,
            };
            records.set(handle, { resource, snapshot });
            options.resources.setApplication(resource);
            return accepted(handle);
          } catch (error) {
            await options.docker
              .run(['rm', '--force', proxyContainerName, containerName])
              .catch(() => undefined);
            return operationFailure('provision the preview application', error);
          }
        }
      );
    },

    async inspect(input): Promise<ProviderInspectResult<SandboxSnapshot>> {
      const record = records.get(input.handle);
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
        !['terminated', 'failed', 'expired'].includes(
          record.snapshot.lifecycle
        ) &&
        Date.parse(record.snapshot.expiresAt) <= now().getTime()
      ) {
        await stopExpired(record);
      }

      if (
        !['terminated', 'failed', 'expired'].includes(record.snapshot.lifecycle)
      ) {
        try {
          const result = await options.docker.run([
            'inspect',
            '--format',
            '{{json .State}}',
            record.resource.containerName,
          ]);
          const state = parseContainerState(result.stdout);
          if (state.Paused) {
            record.snapshot.lifecycle = 'suspended';
            record.snapshot.applicationTarget = null;
          } else if (
            state.Status === 'exited' ||
            state.Status === 'dead' ||
            state.Health?.Status === 'unhealthy'
          ) {
            record.snapshot.lifecycle = 'failed';
            record.snapshot.failureCode = 'internal_error';
            record.snapshot.applicationTarget = null;
          } else if (state.Running && state.Health?.Status === 'healthy') {
            const proxyResult = await options.docker.run([
              'inspect',
              '--format',
              '{{json .State}}',
              record.resource.proxyContainerName,
            ]);
            const proxyState = parseContainerState(proxyResult.stdout);
            if (
              !proxyState.Running ||
              proxyState.Paused ||
              proxyState.Status === 'exited' ||
              proxyState.Status === 'dead'
            ) {
              record.snapshot.lifecycle = 'failed';
              record.snapshot.failureCode = 'internal_error';
              record.snapshot.applicationTarget = null;
            } else {
              const portResult = await options.docker.run([
                'port',
                record.resource.proxyContainerName,
                '3000/tcp',
              ]);
              const published = parsePublishedPort(portResult.stdout);
              const probeHost =
                published.host === '::1' ? '[::1]' : published.host;
              const reachable = await probe(
                `http://${probeHost}:${published.port}/health/ready`
              );
              if (reachable) {
                record.snapshot.lifecycle = 'running';
                record.snapshot.applicationTarget = {
                  upstreamRef: `docker-loopback:${published.host}:${published.port}`,
                  health: {
                    livenessPath: '/health/live',
                    readinessPath: '/health/ready',
                    applicationPort: 3000,
                  },
                };
              } else {
                record.snapshot.lifecycle = 'starting';
                record.snapshot.applicationTarget = null;
              }
            }
          } else {
            record.snapshot.lifecycle = 'starting';
            record.snapshot.applicationTarget = null;
          }
        } catch (error) {
          return {
            handle: input.handle,
            phase: 'unknown',
            snapshot: clone(record.snapshot),
            error: {
              code: 'provider_unavailable',
              message: 'Docker could not inspect the preview application.',
              retryable: true,
              details: {
                reason:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : String(error).slice(0, 500),
              },
            },
            observedAt: now().toISOString(),
          };
        }
      }

      const phase =
        record.snapshot.lifecycle === 'failed'
          ? 'failed'
          : ['provisioning', 'starting', 'terminating'].includes(
                record.snapshot.lifecycle
              )
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
                message: 'The preview application failed.',
                retryable: false,
              }
            : null,
        observedAt: now().toISOString(),
      };
    },

    async renew(input) {
      return mutations.apply('renew', input.idempotencyKey, input, async () => {
        const record = records.get(input.handle);
        if (!record) {
          return providerFailure(
            'not_found',
            `Sandbox ${input.handle} was not found.`,
            false
          );
        }
        if (
          ['terminated', 'failed', 'expired'].includes(
            record.snapshot.lifecycle
          )
        ) {
          return providerFailure(
            'invalid_argument',
            `Cannot renew a sandbox in ${record.snapshot.lifecycle}.`,
            false
          );
        }
        const expiresAtMs = Date.parse(input.expiresAt);
        const maxExpiresAtMs =
          now().getTime() +
          record.snapshot.spec.policy.maxRuntimeSeconds * 1_000;
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= now().getTime() ||
          expiresAtMs > maxExpiresAtMs
        ) {
          return providerFailure(
            'invalid_argument',
            'Renewed expiry must be in the future and within maxRuntimeSeconds.',
            false
          );
        }
        record.snapshot.expiresAt = input.expiresAt;
        record.snapshot.spec.expiresAt = input.expiresAt;
        return accepted(input.handle);
      });
    },

    async suspend(input) {
      return mutateLifecycle(
        'suspend',
        input,
        ['running', 'starting'],
        'suspended',
        'pause'
      );
    },

    async resume(input) {
      return mutateLifecycle(
        'resume',
        input,
        ['suspended'],
        'starting',
        'unpause'
      );
    },

    async destroy(input) {
      return mutations.apply(
        'destroy',
        input.idempotencyKey,
        input,
        async () => {
          const record = records.get(input.handle);
          if (!record) {
            const prefix = 'docker-sandbox:';
            const previewInstanceId = input.handle.startsWith(prefix)
              ? input.handle.slice(prefix.length)
              : '';
            if (!previewInstanceId) {
              return providerFailure(
                'not_found',
                `Sandbox ${input.handle} was not found.`,
                false
              );
            }
            try {
              await options.docker.run([
                'rm',
                '--force',
                dockerResourceName('proxy', previewInstanceId),
                dockerResourceName('app', previewInstanceId),
              ]);
            } catch (error) {
              if (!isDockerResourceMissing(error)) {
                return operationFailure(
                  'destroy the recovered preview application',
                  error
                );
              }
            }
            return accepted(input.handle);
          }
          if (record.snapshot.lifecycle === 'terminated') {
            return accepted(input.handle);
          }
          record.snapshot.lifecycle = 'terminating';
          try {
            await options.docker.run([
              'rm',
              '--force',
              record.resource.proxyContainerName,
              record.resource.containerName,
            ]);
          } catch (error) {
            if (!isDockerResourceMissing(error)) {
              record.snapshot.lifecycle = 'failed';
              record.snapshot.failureCode = 'provider_unavailable';
              return operationFailure('destroy the preview application', error);
            }
          }
          options.resources.deleteApplication(
            record.resource.previewInstanceId
          );
          try {
            await removeNetworkWhenUnused(
              options.docker,
              options.resources,
              record.resource.previewInstanceId,
              record.resource.networkName
            );
          } catch (error) {
            record.snapshot.lifecycle = 'failed';
            record.snapshot.failureCode = 'provider_unavailable';
            return operationFailure(
              'remove the preview application network',
              error
            );
          }
          record.snapshot.lifecycle = 'terminated';
          record.snapshot.applicationTarget = null;
          record.snapshot.bootstrapChannelRef = null;
          return accepted(input.handle);
        }
      );
    },
  };

  return provider;
}
