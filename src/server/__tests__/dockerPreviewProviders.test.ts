import {
  createDockerPostgresSandboxDataProvider,
  type DockerPostgresSandboxDataProvider,
} from '../services/build/dockerPostgresSandboxDataProvider';
import {
  createDockerPreviewResourceStore,
  dockerResourceName,
  type DockerCommandRunner,
} from '../services/build/dockerPreviewRuntime';
import {
  createDockerSandboxProvider,
  type DockerSandboxProvider,
} from '../services/build/dockerSandboxProvider';
import type {
  ApexPreviewCorrelation,
  ProviderMutationResult,
  SandboxProvisionSpec,
} from '../services/build/buildPreviewProviderContracts';

const COMMIT = 'a'.repeat(40);
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`;
const RUNTIME_DIGEST = `sha256:${'c'.repeat(64)}`;
const MIGRATION_DIGEST = `sha256:${'d'.repeat(64)}`;
const SEED_DIGEST = `sha256:${'e'.repeat(64)}`;

const correlation: ApexPreviewCorrelation = {
  previewInstanceId: 'instance-1',
  buildRunId: 'run-1',
  revisionId: 'revision-1',
  revisionNumber: 1,
  validatedCommit: COMMIT,
  templateVersion: '1.0.0',
};

function provisionSpec(): SandboxProvisionSpec {
  return {
    correlation,
    artifactDigest: ARTIFACT_DIGEST,
    runtimeBundleDigest: RUNTIME_DIGEST,
    expiresAt: '2026-11-06T04:00:00.000Z',
    policy: {
      egress: 'denied',
      maxRuntimeSeconds: 3600,
    },
  };
}

function accepted(result: ProviderMutationResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.accepted.handle) {
    throw new Error('Expected an accepted provider mutation with a handle.');
  }
  return result.accepted.handle;
}

class RecordingDocker implements DockerCommandRunner {
  readonly calls: string[][] = [];

  async run(
    args: readonly string[]
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'create') {
      return { stdout: 'network-id\n', stderr: '' };
    }
    if (args[0] === 'inspect') {
      return {
        stdout: `${JSON.stringify({
          Status: 'running',
          Running: true,
          Paused: false,
          ExitCode: 0,
          Health: { Status: 'healthy' },
        })}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'port') {
      return { stdout: '127.0.0.1:49123\n', stderr: '' };
    }
    if (args[0] === 'run' && args.includes('--detach')) {
      return { stdout: 'container-id\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

function createProviders(docker = new RecordingDocker()): {
  docker: RecordingDocker;
  data: DockerPostgresSandboxDataProvider;
  sandbox: DockerSandboxProvider;
} {
  const resources = createDockerPreviewResourceStore();
  const now = () => new Date('2026-11-06T03:00:00.000Z');
  const resolveRuntimeBundle = async (digest: string) => ({
    path: 'C:\\preview\\runtime.tar',
    digest,
  });
  return {
    docker,
    data: createDockerPostgresSandboxDataProvider({
      docker,
      resources,
      postgresImage: 'postgres:16',
      previewRunnerImage: 'apex/full-stack-express-preview-runner:1.0.0',
      resolveRuntimeBundle,
      randomHex: () => '0123456789abcdef',
      now,
    }),
    sandbox: createDockerSandboxProvider({
      docker,
      resources,
      previewRunnerImage: 'apex/full-stack-express-preview-runner:1.0.0',
      resolveRuntimeBundle,
      now,
      probe: async () => true,
    }),
  };
}

async function readyDatabase(
  data: DockerPostgresSandboxDataProvider
): Promise<string> {
  const databaseHandle = accepted(
    await data.create({
      idempotencyKey: 'instance-1:data:create:1',
      correlation,
      expiresAt: '2026-11-06T04:00:00.000Z',
    })
  );
  expect((await data.inspect({ databaseHandle })).snapshot?.phase).toBe(
    'migrating'
  );
  expect(
    (
      await data.migrate({
        idempotencyKey: 'instance-1:data:migrate:1',
        databaseHandle,
        migrationArtifactDigest: MIGRATION_DIGEST,
      })
    ).ok
  ).toBe(true);
  expect(
    (
      await data.seed({
        idempotencyKey: 'instance-1:data:seed:1',
        databaseHandle,
        seedRecipeDigest: SEED_DIGEST,
      })
    ).ok
  ).toBe(true);
  return databaseHandle;
}

describe('local Docker preview providers', () => {
  it('runs PostgreSQL, migration, seed, and the app on one internal network', async () => {
    const { data, docker, sandbox } = createProviders();
    const databaseHandle = await readyDatabase(data);

    const handle = accepted(
      await sandbox.provision({
        idempotencyKey: 'instance-1:sandbox:provision:1',
        spec: provisionSpec(),
      })
    );
    const inspected = await sandbox.inspect({ handle });

    expect(inspected).toMatchObject({
      phase: 'succeeded',
      snapshot: {
        lifecycle: 'running',
        applicationTarget: {
          upstreamRef: 'docker-loopback:127.0.0.1:49123',
          health: {
            livenessPath: '/health/live',
            readinessPath: '/health/ready',
            applicationPort: 3000,
          },
        },
      },
    });
    expect((await data.inspect({ databaseHandle })).snapshot).toMatchObject({
      phase: 'ready',
      migrationDigest: MIGRATION_DIGEST,
      seedChecksum: SEED_DIGEST,
    });

    const networkCreate = docker.calls.find(
      (args) => args[0] === 'network' && args[1] === 'create'
    );
    expect(networkCreate).toContain('--internal');
    const appRun = docker.calls.find(
      (args) =>
        args[0] === 'run' &&
        args.includes('apex/full-stack-express-preview-runner:1.0.0') &&
        args[args.length - 1] === 'start'
    );
    expect(appRun).toEqual(
      expect.arrayContaining([
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
      ])
    );
    expect(appRun).not.toContain('--publish');
    const proxyRun = docker.calls.find(
      (args) =>
        args[0] === 'run' &&
        args.includes('apex/full-stack-express-preview-runner:1.0.0') &&
        args[args.length - 1] === 'proxy'
    );
    expect(proxyRun).toEqual(
      expect.arrayContaining([
        '--publish',
        '127.0.0.1:0:3000',
        '--read-only',
        '--cap-drop',
        'ALL',
      ])
    );
    expect(proxyRun?.join(' ')).not.toContain('0.0.0.0');
    for (const run of docker.calls.filter((args) => args[0] === 'run')) {
      expect(run).toEqual(
        expect.arrayContaining([
          '--memory',
          '--memory-swap',
          '--cpus',
          '--pids-limit',
          '--ulimit',
        ])
      );
    }
    const dockerArguments = docker.calls.flat().join(' ');
    expect(dockerArguments).not.toContain('0123456789abcdef');
    expect(dockerArguments).not.toContain('postgresql://');
  });

  it('uses idempotency keys and rejects changed replay input', async () => {
    const { data, docker } = createProviders();
    const input = {
      idempotencyKey: 'instance-1:data:create:1',
      correlation,
      expiresAt: '2026-11-06T04:00:00.000Z',
    };

    const [first, second] = await Promise.all([
      data.create(input),
      data.create(input),
    ]);
    expect(second).toEqual(first);
    expect(
      docker.calls.filter(
        (args) => args[0] === 'run' && args.includes('postgres:16')
      )
    ).toHaveLength(1);

    const conflict = await data.create({
      ...input,
      expiresAt: '2026-11-06T05:00:00.000Z',
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
  });

  it('allows the same idempotency key to retry a transient Docker failure', async () => {
    const docker = new RecordingDocker();
    const run = docker.run.bind(docker);
    let failOnce = true;
    docker.run = async (args) => {
      if (failOnce && args[0] === 'network' && args[1] === 'create') {
        failOnce = false;
        throw new Error('Docker daemon temporarily unavailable.');
      }
      return run(args);
    };
    const { data } = createProviders(docker);
    const input = {
      idempotencyKey: 'instance-1:data:create:retry',
      correlation,
      expiresAt: '2026-11-06T04:00:00.000Z',
    };

    await expect(data.create(input)).resolves.toMatchObject({
      ok: false,
      error: { retryable: true },
    });
    await expect(data.create(input)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('requires ready synthetic data and denies unsupported egress policies', async () => {
    const { data, sandbox } = createProviders();

    const beforeData = await sandbox.provision({
      idempotencyKey: 'instance-1:sandbox:provision:before-data',
      spec: provisionSpec(),
    });
    expect(beforeData).toMatchObject({
      ok: false,
      error: { code: 'not_ready', retryable: true },
    });

    await readyDatabase(data);
    const allowlist = await sandbox.provision({
      idempotencyKey: 'instance-1:sandbox:provision:allowlist',
      spec: {
        ...provisionSpec(),
        policy: {
          ...provisionSpec().policy,
          egress: 'allowlist',
          allowlistedHosts: ['example.com'],
        },
      },
    });
    expect(allowlist).toMatchObject({
      ok: false,
      error: { code: 'policy_denied', retryable: false },
    });
  });

  it('suspends, resumes, and destroys the app and database', async () => {
    const { data, docker, sandbox } = createProviders();
    const databaseHandle = await readyDatabase(data);
    const handle = accepted(
      await sandbox.provision({
        idempotencyKey: 'instance-1:sandbox:provision:1',
        spec: provisionSpec(),
      })
    );

    expect(
      (
        await sandbox.suspend({
          idempotencyKey: 'instance-1:sandbox:suspend:1',
          handle,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await sandbox.resume({
          idempotencyKey: 'instance-1:sandbox:resume:1',
          handle,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await sandbox.destroy({
          idempotencyKey: 'instance-1:sandbox:destroy:1',
          handle,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await data.destroy({
          idempotencyKey: 'instance-1:data:destroy:1',
          databaseHandle,
        })
      ).ok
    ).toBe(true);

    expect(docker.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['pause']),
        expect.arrayContaining(['unpause']),
        expect.arrayContaining(['rm', '--force']),
      ])
    );
    expect((await sandbox.inspect({ handle })).snapshot?.lifecycle).toBe(
      'terminated'
    );
    expect((await data.inspect({ databaseHandle })).snapshot?.phase).toBe(
      'destroyed'
    );
  });

  it('reclaims deterministic Docker resources after provider memory is lost', async () => {
    const { data, docker, sandbox } = createProviders();
    const previewInstanceId = 'abandoned-instance';

    await expect(
      sandbox.destroy({
        idempotencyKey: `${previewInstanceId}:sandbox:destroy`,
        handle: `docker-sandbox:${previewInstanceId}`,
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      data.destroy({
        idempotencyKey: `${previewInstanceId}:data:destroy`,
        databaseHandle: `docker-db:${previewInstanceId}`,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(docker.calls).toEqual(
      expect.arrayContaining([
        [
          'rm',
          '--force',
          dockerResourceName('proxy', previewInstanceId),
          dockerResourceName('app', previewInstanceId),
        ],
        ['rm', '--force', dockerResourceName('db', previewInstanceId)],
        ['network', 'rm', dockerResourceName('network', previewInstanceId)],
      ])
    );
  });
});
