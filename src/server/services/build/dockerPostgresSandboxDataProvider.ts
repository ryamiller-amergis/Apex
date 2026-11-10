import { randomBytes } from 'node:crypto';
import type {
  ProviderInspectResult,
  ProviderMutationResult,
  SandboxDataProvider,
  SandboxDataSnapshot,
} from './buildPreviewProviderContracts';
import {
  acceptedMutation,
  bundleMount,
  clone,
  databaseUrl,
  dockerLabels,
  dockerResourceLimits,
  dockerResourceName,
  DockerMutationLedger,
  isDockerResourceMissing,
  providerFailure,
  removeNetworkWhenUnused,
  withDockerEnvFile,
  type DockerCommandRunner,
  type DockerDatabaseResource,
  type DockerPreviewResourceStore,
  type RuntimeBundleResolver,
  type RuntimeBundleSource,
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

interface DataRecord {
  resource: DockerDatabaseResource;
  snapshot: SandboxDataSnapshot;
  migrationBundle: RuntimeBundleSource | null;
}

export interface DockerPostgresSandboxDataProviderOptions {
  docker: DockerCommandRunner;
  resources: DockerPreviewResourceStore;
  postgresImage: string;
  previewRunnerImage: string;
  resolveRuntimeBundle: RuntimeBundleResolver;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

export interface DockerPostgresSandboxDataProvider extends SandboxDataProvider {
  readonly databaseCount: number;
}

function parseContainerState(stdout: string): DockerContainerState {
  const value = JSON.parse(stdout.trim()) as unknown;
  if (!value || typeof value !== 'object') {
    throw new Error('Docker returned an invalid container state.');
  }
  return value as DockerContainerState;
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

export function createDockerPostgresSandboxDataProvider(
  options: DockerPostgresSandboxDataProviderOptions
): DockerPostgresSandboxDataProvider {
  const now = options.now ?? (() => new Date());
  const randomHex =
    options.randomHex ??
    ((bytes: number) => randomBytes(bytes).toString('hex'));
  const records = new Map<string, DataRecord>();
  const mutations = new DockerMutationLedger();
  let nextOperation = 1;

  const accepted = (handle: string): ProviderMutationResult =>
    acceptedMutation(`docker-data-operation-${nextOperation++}`, handle);

  const runBundleCommand = async (
    record: DataRecord,
    source: RuntimeBundleSource,
    mode: 'migrate' | 'seed'
  ): Promise<void> => {
    await withDockerEnvFile(
      {
        APEX_PREVIEW_BUNDLE_DIGEST: source.digest,
        DATABASE_URL: record.resource.databaseUrl,
        NODE_ENV: 'development',
        OTEL_SDK_DISABLED: 'true',
      },
      (envFilePath) =>
        options.docker.run([
          'run',
          '--rm',
          '--network',
          record.resource.networkName,
          ...dockerResourceLimits('job'),
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--tmpfs',
          '/session:rw,nosuid,size=536870912,uid=10001,gid=10001,mode=0750',
          '--mount',
          bundleMount(source.path),
          '--env-file',
          envFilePath,
          options.previewRunnerImage,
          mode,
        ])
    );
  };

  const provider: DockerPostgresSandboxDataProvider = {
    get databaseCount() {
      return records.size;
    },

    async create(input) {
      return mutations.apply(
        'create',
        input.idempotencyKey,
        input,
        async () => {
          const existing = options.resources.getDatabase(
            input.correlation.previewInstanceId
          );
          if (existing) {
            return providerFailure(
              'conflict',
              `Preview ${input.correlation.previewInstanceId} already has a database.`,
              false
            );
          }
          const expiresAtMs = Date.parse(input.expiresAt);
          if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
            return providerFailure(
              'invalid_argument',
              'Database expiry must be in the future.',
              false
            );
          }

          const token = randomHex(16).toLowerCase();
          const handle = `docker-db:${input.correlation.previewInstanceId}`;
          const networkName = dockerResourceName(
            'network',
            input.correlation.previewInstanceId
          );
          const containerName = dockerResourceName(
            'db',
            input.correlation.previewInstanceId
          );
          const resource: DockerDatabaseResource = {
            handle,
            correlation: clone(input.correlation),
            networkName,
            containerName,
            databaseName: `apex_${token.slice(0, 12)}`,
            username: `apex_${token.slice(12, 24)}`,
            password: token,
            databaseUrl: '',
            expiresAt: input.expiresAt,
            ready: false,
          };
          resource.databaseUrl = databaseUrl(resource);

          try {
            await options.docker.run([
              'network',
              'create',
              '--internal',
              ...dockerLabels(input.correlation),
              networkName,
            ]);
            await withDockerEnvFile(
              {
                POSTGRES_DB: resource.databaseName,
                POSTGRES_USER: resource.username,
                POSTGRES_PASSWORD: resource.password,
              },
              (envFilePath) =>
                options.docker.run([
                  'run',
                  '--detach',
                  '--name',
                  containerName,
                  '--network',
                  networkName,
                  '--network-alias',
                  'postgres',
                  ...dockerLabels(input.correlation),
                  ...dockerResourceLimits('database'),
                  '--security-opt',
                  'no-new-privileges',
                  '--tmpfs',
                  '/var/lib/postgresql/data:rw,noexec,nosuid,size=536870912',
                  '--tmpfs',
                  '/var/run/postgresql:rw,noexec,nosuid,size=16777216',
                  '--tmpfs',
                  '/tmp:rw,noexec,nosuid,size=67108864',
                  '--env-file',
                  envFilePath,
                  '--health-cmd',
                  `pg_isready -U ${resource.username} -d ${resource.databaseName}`,
                  '--health-interval',
                  '1s',
                  '--health-timeout',
                  '3s',
                  '--health-retries',
                  '30',
                  options.postgresImage,
                ])
            );
          } catch (error) {
            try {
              await options.docker.run(['network', 'rm', networkName]);
            } catch {
              // Preserve the original provisioning error.
            }
            return operationFailure('create the preview database', error);
          }

          const snapshot: SandboxDataSnapshot = {
            phase: 'creating',
            databaseHandle: handle,
            migrationDigest: null,
            seedChecksum: null,
            failureCode: null,
          };
          records.set(handle, {
            resource,
            snapshot,
            migrationBundle: null,
          });
          options.resources.setDatabase(resource);
          return accepted(handle);
        }
      );
    },

    async migrate(input) {
      return mutations.apply(
        'migrate',
        input.idempotencyKey,
        input,
        async () => {
          const record = records.get(input.databaseHandle);
          if (!record) {
            return providerFailure(
              'not_found',
              `Database ${input.databaseHandle} was not found.`,
              false
            );
          }
          if (record.snapshot.phase !== 'migrating') {
            return providerFailure(
              'not_ready',
              `Database ${input.databaseHandle} is not ready for migration.`,
              true
            );
          }
          try {
            const source = await options.resolveRuntimeBundle(
              input.migrationArtifactDigest
            );
            if (source.digest !== input.migrationArtifactDigest) {
              return providerFailure(
                'invalid_argument',
                'Resolved migration bundle digest does not match the request.',
                false
              );
            }
            await runBundleCommand(record, source, 'migrate');
            record.migrationBundle = source;
            record.snapshot.migrationDigest = input.migrationArtifactDigest;
            return accepted(input.databaseHandle);
          } catch (error) {
            record.snapshot.phase = 'failed';
            record.snapshot.failureCode = 'internal_error';
            return operationFailure('run preview migrations', error);
          }
        }
      );
    },

    async seed(input) {
      return mutations.apply('seed', input.idempotencyKey, input, async () => {
        const record = records.get(input.databaseHandle);
        if (!record) {
          return providerFailure(
            'not_found',
            `Database ${input.databaseHandle} was not found.`,
            false
          );
        }
        if (
          record.snapshot.phase !== 'migrating' ||
          !record.snapshot.migrationDigest
        ) {
          return providerFailure(
            'not_ready',
            `Database ${input.databaseHandle} must be migrated before seeding.`,
            true
          );
        }
        try {
          const source = await options.resolveRuntimeBundle(
            input.seedRecipeDigest
          );
          if (source.digest !== input.seedRecipeDigest) {
            return providerFailure(
              'invalid_argument',
              'Resolved seed bundle digest does not match the request.',
              false
            );
          }
          await runBundleCommand(record, source, 'seed');
          record.snapshot.phase = 'ready';
          record.snapshot.seedChecksum = input.seedRecipeDigest;
          record.resource.ready = true;
          return accepted(input.databaseHandle);
        } catch (error) {
          record.snapshot.phase = 'failed';
          record.snapshot.failureCode = 'internal_error';
          return operationFailure('seed the preview database', error);
        }
      });
    },

    async destroy(input) {
      return mutations.apply(
        'destroy',
        input.idempotencyKey,
        input,
        async () => {
          const record = records.get(input.databaseHandle);
          if (!record) {
            const prefix = 'docker-db:';
            const previewInstanceId = input.databaseHandle.startsWith(prefix)
              ? input.databaseHandle.slice(prefix.length)
              : '';
            if (!previewInstanceId) {
              return providerFailure(
                'not_found',
                `Database ${input.databaseHandle} was not found.`,
                false
              );
            }
            try {
              await options.docker.run([
                'rm',
                '--force',
                dockerResourceName('db', previewInstanceId),
              ]);
            } catch (error) {
              if (!isDockerResourceMissing(error)) {
                return operationFailure(
                  'destroy the recovered preview database',
                  error
                );
              }
            }
            try {
              await options.docker.run([
                'network',
                'rm',
                dockerResourceName('network', previewInstanceId),
              ]);
            } catch (error) {
              if (!isDockerResourceMissing(error)) {
                return operationFailure(
                  'remove the recovered preview network',
                  error
                );
              }
            }
            return accepted(input.databaseHandle);
          }
          if (record.snapshot.phase === 'destroyed') {
            return accepted(input.databaseHandle);
          }
          record.snapshot.phase = 'destroying';
          try {
            await options.docker.run([
              'rm',
              '--force',
              record.resource.containerName,
            ]);
          } catch (error) {
            if (!isDockerResourceMissing(error)) {
              record.snapshot.phase = 'failed';
              record.snapshot.failureCode = 'provider_unavailable';
              return operationFailure('destroy the preview database', error);
            }
          }
          record.resource.ready = false;
          options.resources.deleteDatabase(
            record.resource.correlation.previewInstanceId
          );
          try {
            await removeNetworkWhenUnused(
              options.docker,
              options.resources,
              record.resource.correlation.previewInstanceId,
              record.resource.networkName
            );
          } catch (error) {
            record.snapshot.phase = 'failed';
            record.snapshot.failureCode = 'provider_unavailable';
            return operationFailure(
              'remove the preview database network',
              error
            );
          }
          record.snapshot.phase = 'destroyed';
          return accepted(input.databaseHandle);
        }
      );
    },

    async inspect(input): Promise<ProviderInspectResult<SandboxDataSnapshot>> {
      const record = records.get(input.databaseHandle);
      if (!record) {
        return {
          handle: input.databaseHandle,
          phase: 'unknown',
          snapshot: null,
          error: {
            code: 'not_found',
            message: `Database ${input.databaseHandle} was not found.`,
            retryable: false,
          },
          observedAt: now().toISOString(),
        };
      }

      if (
        !['destroyed', 'destroying', 'failed'].includes(record.snapshot.phase)
      ) {
        try {
          const result = await options.docker.run([
            'inspect',
            '--format',
            '{{json .State}}',
            record.resource.containerName,
          ]);
          const state = parseContainerState(result.stdout);
          if (
            state.Running &&
            state.Health?.Status === 'healthy' &&
            record.snapshot.phase === 'creating'
          ) {
            record.snapshot.phase = 'migrating';
          } else if (
            state.Status === 'exited' ||
            state.Status === 'dead' ||
            state.Health?.Status === 'unhealthy'
          ) {
            record.snapshot.phase = 'failed';
            record.snapshot.failureCode = 'internal_error';
            record.resource.ready = false;
          }
        } catch (error) {
          return {
            handle: input.databaseHandle,
            phase: 'unknown',
            snapshot: clone(record.snapshot),
            error: {
              code: 'provider_unavailable',
              message: 'Docker could not inspect the preview database.',
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
        record.snapshot.phase === 'failed'
          ? 'failed'
          : ['creating', 'migrating', 'seeding', 'destroying'].includes(
                record.snapshot.phase
              )
            ? 'running'
            : 'succeeded';
      return {
        handle: input.databaseHandle,
        phase,
        snapshot: clone(record.snapshot),
        error:
          phase === 'failed'
            ? {
                code: record.snapshot.failureCode ?? 'internal_error',
                message: 'The preview database operation failed.',
                retryable: false,
              }
            : null,
        observedAt: now().toISOString(),
      };
    },
  };

  return provider;
}
