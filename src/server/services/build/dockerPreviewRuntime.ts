import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  ApexPreviewCorrelation,
  ContentDigest,
  ProviderErrorCode,
  ProviderMutationResult,
} from './buildPreviewProviderContracts';

const execFileAsync = promisify(execFile);

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
}

export interface DockerCommandRunner {
  run(args: readonly string[]): Promise<DockerCommandResult>;
}

export interface RuntimeBundleSource {
  path: string;
  digest: ContentDigest;
}

export type RuntimeBundleResolver = (
  digest: ContentDigest
) => Promise<RuntimeBundleSource>;

export interface DockerDatabaseResource {
  handle: string;
  correlation: ApexPreviewCorrelation;
  networkName: string;
  containerName: string;
  databaseName: string;
  username: string;
  password: string;
  databaseUrl: string;
  expiresAt: string;
  ready: boolean;
}

export interface DockerApplicationResource {
  handle: string;
  previewInstanceId: string;
  networkName: string;
  containerName: string;
  proxyContainerName: string;
}

export interface DockerPreviewResourceStore {
  getDatabase(previewInstanceId: string): DockerDatabaseResource | undefined;
  setDatabase(resource: DockerDatabaseResource): void;
  deleteDatabase(previewInstanceId: string): void;
  getApplication(
    previewInstanceId: string
  ): DockerApplicationResource | undefined;
  setApplication(resource: DockerApplicationResource): void;
  deleteApplication(previewInstanceId: string): void;
}

export interface DockerMutationRecord {
  payload: string;
  result: Promise<ProviderMutationResult>;
}

export class DockerMutationLedger {
  private readonly records = new Map<string, DockerMutationRecord>();

  async apply(
    operation: string,
    idempotencyKey: string,
    payload: unknown,
    mutation: () => Promise<ProviderMutationResult>
  ): Promise<ProviderMutationResult> {
    const key = `${operation}:${idempotencyKey}`;
    const serialized = JSON.stringify(payload);
    const previous = this.records.get(key);
    if (previous) {
      if (previous.payload !== serialized) {
        return providerFailure(
          'conflict',
          `Idempotency key ${idempotencyKey} was already used with different input.`,
          false
        );
      }
      return clone(await previous.result);
    }
    const result = mutation()
      .then((value) => {
        if (!value.ok && value.error.retryable) {
          const current = this.records.get(key);
          if (current?.result === result) this.records.delete(key);
        }
        return clone(value);
      })
      .catch((error: unknown) => {
        const current = this.records.get(key);
        if (current?.result === result) this.records.delete(key);
        throw error;
      });
    this.records.set(key, {
      payload: serialized,
      result,
    });
    return clone(await result);
  }
}

export function createDockerPreviewResourceStore(): DockerPreviewResourceStore {
  const databases = new Map<string, DockerDatabaseResource>();
  const applications = new Map<string, DockerApplicationResource>();
  return {
    getDatabase: (previewInstanceId) => databases.get(previewInstanceId),
    setDatabase: (resource) => {
      databases.set(resource.correlation.previewInstanceId, resource);
    },
    deleteDatabase: (previewInstanceId) => {
      databases.delete(previewInstanceId);
    },
    getApplication: (previewInstanceId) => applications.get(previewInstanceId),
    setApplication: (resource) => {
      applications.set(resource.previewInstanceId, resource);
    },
    deleteApplication: (previewInstanceId) => {
      applications.delete(previewInstanceId);
    },
  };
}

export function createDockerCommandRunner(options?: {
  command?: string;
  timeoutMs?: number;
}): DockerCommandRunner {
  const command = options?.command ?? 'docker';
  const timeoutMs = options?.timeoutMs ?? 120_000;
  return {
    async run(args) {
      const { stdout, stderr } = await execFileAsync(command, [...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr };
    },
  };
}

export function providerFailure(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, string>
): ProviderMutationResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
  };
}

export function acceptedMutation(
  operationId: string,
  handle: string
): ProviderMutationResult {
  return {
    ok: true,
    accepted: {
      operationId,
      phase: 'accepted',
      handle,
    },
  };
}

export function dockerResourceName(
  kind: 'app' | 'db' | 'network' | 'proxy',
  previewInstanceId: string
): string {
  const suffix = createHash('sha256')
    .update(previewInstanceId)
    .digest('hex')
    .slice(0, 16);
  return `apex-preview-${kind}-${suffix}`;
}

export function dockerLabels(
  correlation: ApexPreviewCorrelation
): readonly string[] {
  return [
    '--label',
    'com.amergis.apex.preview=true',
    '--label',
    `com.amergis.apex.preview-instance=${correlation.previewInstanceId}`,
    '--label',
    `com.amergis.apex.build-run=${correlation.buildRunId}`,
    '--label',
    `com.amergis.apex.revision=${correlation.revisionId}`,
    '--label',
    `com.amergis.apex.template-version=${correlation.templateVersion}`,
  ];
}

export function bundleMount(sourcePath: string): string {
  return `type=bind,src=${sourcePath},dst=/input/runtime.tar,readonly`;
}

export function dockerResourceLimits(
  profile:
    | 'application'
    | 'studio'
    | 'studio-task'
    | 'job'
    | 'database'
    | 'proxy'
): readonly string[] {
  const limits = {
    application: { memory: '512m', cpus: '1', pids: '256' },
    studio: { memory: '1g', cpus: '2', pids: '512' },
    // pnpm's recursive TypeScript checks peak above 1 GiB on the Golden Stack.
    // Keep this isolated from the long-lived Studio process.
    'studio-task': { memory: '2g', cpus: '2', pids: '512' },
    job: { memory: '512m', cpus: '1', pids: '256' },
    database: { memory: '512m', cpus: '1', pids: '256' },
    proxy: { memory: '128m', cpus: '0.25', pids: '64' },
  }[profile];
  return [
    '--memory',
    limits.memory,
    '--memory-swap',
    limits.memory,
    '--cpus',
    limits.cpus,
    '--pids-limit',
    limits.pids,
    '--ulimit',
    'nofile=1024:1024',
  ];
}

export async function withDockerEnvFile<T>(
  values: Readonly<Record<string, string>>,
  action: (envFilePath: string) => Promise<T>
): Promise<T> {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      value.includes('\r') ||
      value.includes('\n') ||
      value.includes('\0')
    ) {
      throw new Error(`Invalid Docker environment value for ${name}.`);
    }
    lines.push(`${name}=${value}`);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'apex-preview-env-'));
  const envFilePath = path.join(directory, 'runtime.env');
  try {
    await writeFile(envFilePath, `${lines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(envFilePath, 0o600);
    return await action(envFilePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function databaseUrl(resource: {
  username: string;
  password: string;
  databaseName: string;
}): string {
  return `postgresql://${encodeURIComponent(resource.username)}:${encodeURIComponent(
    resource.password
  )}@postgres:5432/${encodeURIComponent(resource.databaseName)}`;
}

export async function removeNetworkWhenUnused(
  docker: DockerCommandRunner,
  resources: DockerPreviewResourceStore,
  previewInstanceId: string,
  networkName: string
): Promise<void> {
  if (
    resources.getDatabase(previewInstanceId) ||
    resources.getApplication(previewInstanceId)
  ) {
    return;
  }
  try {
    await docker.run(['network', 'rm', networkName]);
  } catch (error) {
    if (!isDockerResourceMissing(error)) throw error;
  }
}

export function isDockerResourceMissing(error: unknown): boolean {
  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  const text = [candidate?.message, candidate?.stderr, candidate?.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return /no such (?:container|network|object)|not found|does not exist/i.test(
    text
  );
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
