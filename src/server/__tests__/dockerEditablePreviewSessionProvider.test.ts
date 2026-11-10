import path from 'node:path';
import {
  createDockerEditablePreviewSessionProvider,
  probeStudioHttpReadiness,
} from '../services/build/dockerEditablePreviewSessionProvider';
import type { DockerCommandRunner } from '../services/build/dockerPreviewRuntime';
import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
  evaluateEditablePreviewReadiness,
  type EditablePreviewSessionSpec,
  type ProviderMutationResult,
} from '../services/build/buildPreviewProviderContracts';

const NOW = '2027-11-06T17:00:00.000Z';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const CHANGE_DIGEST = `sha256:${'b'.repeat(64)}`;

function sessionSpec(): EditablePreviewSessionSpec {
  return {
    contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
    correlation: {
      sessionId: 'studio-session-1',
      buildRunId: 'build-1',
      baseRevisionId: 'revision-1',
      draftRevisionId: 'revision-2',
      revisionNumber: 2,
      baseCommit: 'c'.repeat(40),
      templateVersion: '1.0.0',
    },
    source: {
      snapshotDigest: SOURCE_DIGEST,
      snapshotRef: 'artifact:source-snapshot-1',
    },
    developmentManifestDigest: `sha256:${'d'.repeat(64)}`,
    databaseGrantRef: 'grant:preview-database-1',
    expiresAt: '2027-11-06T18:00:00.000Z',
    policy: {
      egress: 'denied',
      maxRuntimeSeconds: 28_800,
      writableWorkspace: true,
    },
    requiredTransports: EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  };
}

function accepted(result: ProviderMutationResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.accepted.handle) {
    throw new Error('Expected an accepted mutation with a session handle.');
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
        })}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'port') {
      return { stdout: '127.0.0.1:49125\n', stderr: '' };
    }
    if (args[0] === 'run' && args.includes('--detach')) {
      return { stdout: 'container-id\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

class RestartedDocker implements DockerCommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly mode: 'healthy' | 'partial' | 'unavailable',
    private readonly persistedSpec = sessionSpec()
  ) {}

  async run(
    args: readonly string[]
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([...args]);
    if (args[0] === 'inspect') {
      const containerName = args[args.length - 1] ?? '';
      if (
        this.mode === 'partial' &&
        containerName.startsWith('apex-studio-proxy-')
      ) {
        throw Object.assign(new Error('No such container'), {
          stderr: 'Error: No such container',
        });
      }
      return {
        stdout: `${JSON.stringify({
          Status: 'running',
          Running: true,
          Paused: false,
          ExitCode: 0,
        })}\n`,
        stderr: '',
      };
    }
    if (
      args[0] === 'exec' &&
      args.includes('/home/studio/.apex-session.json')
    ) {
      if (this.mode === 'unavailable') {
        throw new Error('Docker daemon timed out');
      }
      return {
        stdout: `${JSON.stringify({
          contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
          spec: this.persistedSpec,
          workspace: {
            writable: true,
            version: 1,
            baseSnapshotDigest: SOURCE_DIGEST,
            appliedChangeSets: [
              {
                digest: CHANGE_DIGEST,
                contentRef: 'artifact:change-set-1',
              },
            ],
          },
          expiresAt: this.persistedSpec.expiresAt,
        })}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'port') {
      return { stdout: '127.0.0.1:49125\n', stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'create') {
      return { stdout: 'network-id\n', stderr: '' };
    }
    if (args[0] === 'run' && args.includes('--detach')) {
      return { stdout: 'container-id\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

function createProvider(docker = new RecordingDocker()) {
  return {
    docker,
    provider: createDockerEditablePreviewSessionProvider({
      docker,
      now: () => new Date(NOW),
      resolveSourceSnapshot: async (source) => ({
        path: 'C:\\studio\\source',
        digest: source.snapshotDigest,
      }),
      resolveChangeSet: async (changeSet) => ({
        path: 'C:\\studio\\change-set',
        digest: changeSet.digest,
        deletePaths: ['apps/web/src/obsolete.ts'],
      }),
      probeTransport: async () => ({
        http: 'ready',
        websocket: 'ready',
        vite_hmr: 'ready',
      }),
    }),
  };
}

async function start(
  provider: ReturnType<typeof createDockerEditablePreviewSessionProvider>
): Promise<string> {
  return accepted(
    await provider.start({
      idempotencyKey: 'studio-session-1:start:1',
      spec: sessionSpec(),
    })
  );
}

describe('Docker EditablePreviewSessionProvider', () => {
  it('reconciles a healthy existing session after a provider restart without rebuilding it', async () => {
    const docker = new RestartedDocker('healthy');
    const { provider } = createProvider(docker);

    const handle = await start(provider);
    const inspected = await provider.inspect({ handle });

    expect(inspected).toMatchObject({
      phase: 'succeeded',
      snapshot: {
        lifecycle: 'ready',
        workspace: {
          version: 1,
          appliedChangeSets: [
            {
              digest: CHANGE_DIGEST,
              contentRef: 'artifact:change-set-1',
            },
          ],
        },
      },
    });
    expect(docker.calls.some((args) => args[0] === 'build')).toBe(false);
    expect(
      docker.calls.some((args) => args[0] === 'network' && args[1] === 'create')
    ).toBe(false);
    expect(
      docker.calls.some(
        (args) => args[0] === 'run' && args.includes('--detach')
      )
    ).toBe(false);
  });

  it('removes a partial session before creating its replacement', async () => {
    const docker = new RestartedDocker('partial');
    const { provider } = createProvider(docker);

    await start(provider);

    const cleanupIndex = docker.calls.findIndex(
      (args) => args[0] === 'rm' && args[1] === '--force'
    );
    const buildIndex = docker.calls.findIndex((args) => args[0] === 'build');
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(cleanupIndex);
  });

  it('keeps a healthy session when Docker recovery has a transient error', async () => {
    const docker = new RestartedDocker('unavailable');
    const { provider } = createProvider(docker);

    await expect(
      provider.start({
        idempotencyKey: 'studio-session-1:start:transient',
        spec: sessionSpec(),
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_unavailable', retryable: true },
    });
    expect(
      docker.calls.some((args) => args[0] === 'rm' && args[1] === '--force')
    ).toBe(false);
    expect(docker.calls.some((args) => args[0] === 'build')).toBe(false);
  });

  it('builds a writable isolated workspace and reports an opaque HMR-ready upstream', async () => {
    const { docker, provider } = createProvider();
    const handle = await start(provider);
    const inspected = await provider.inspect({ handle });

    expect(inspected.phase).toBe('succeeded');
    expect(evaluateEditablePreviewReadiness(inspected.snapshot!)).toEqual({
      ready: true,
    });
    expect(JSON.stringify(inspected.snapshot)).not.toMatch(
      /https?:\/\/|file:\/|[a-z]:\\/i
    );

    const build = docker.calls.find((args) => args[0] === 'build');
    expect(build).toEqual(
      expect.arrayContaining([
        '--file',
        'C:\\studio\\source\\Dockerfile.studio',
        '--tag',
        expect.stringMatching(/^apex\/full-stack-express-studio:/),
        'C:\\studio\\source',
      ])
    );
    expect(
      docker.calls.find((args) => args[0] === 'network' && args[1] === 'create')
    ).toContain('--internal');

    const appRun = docker.calls.find(
      (args) => args[0] === 'run' && args.includes('--network-alias')
    );
    expect(appRun).toEqual(
      expect.arrayContaining([
        '--memory',
        '1g',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
      ])
    );
    expect(appRun).not.toContain('--publish');
    const proxyRun = docker.calls.find(
      (args) => args[0] === 'run' && args.includes('--publish')
    );
    expect(proxyRun).toEqual(
      expect.arrayContaining(['--publish', '127.0.0.1:0:3000'])
    );
  });

  it('points the Studio dev server at the verified runtime API alias', async () => {
    const { docker, provider } = createProvider();
    await start(provider);

    const appRun = docker.calls.find(
      (args) => args[0] === 'run' && args.includes('--network-alias')
    );
    expect(appRun).toEqual(
      expect.arrayContaining([
        '--env',
        'APEX_API_PROXY_TARGET=http://studio-api:3000',
        expect.stringMatching(/^apex\/full-stack-express-studio:/),
        'node',
        'scripts/preview/studio-runner.mjs',
      ])
    );
  });

  it('reports Studio HTTP ready before the runtime API is linked', async () => {
    const responses = new Map([
      ['/', { status: 200, type: 'text/html', body: '<main>App</main>' }],
      [
        '/@vite/client',
        {
          status: 200,
          type: 'text/javascript',
          body: 'const wsToken = "studio-token"',
        },
      ],
    ]);
    const server = await import('node:http').then(({ createServer }) =>
      createServer((request, response) => {
        const fixture = responses.get(request.url ?? '/');
        response.writeHead(fixture?.status ?? 404, {
          'content-type': fixture?.type ?? 'text/plain',
        });
        response.end(fixture?.body ?? 'Not found');
      })
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;

    try {
      await expect(
        probeStudioHttpReadiness(`http://127.0.0.1:${port}/`)
      ).resolves.toEqual({ ready: true, hmrToken: 'studio-token' });
      expect(responses.has('/health/ready')).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('detaches linked runtime applications before it removes the Studio network on destroy', async () => {
    const { docker, provider } = createProvider();
    const handle = await start(provider);
    await provider.inspect({ handle });

    await provider.destroy({
      idempotencyKey: 'studio-session-1:destroy:linked',
      handle,
    });

    const inspectIndex = docker.calls.findIndex(
      (args) => args[0] === 'network' && args[1] === 'inspect'
    );
    const removeIndex = docker.calls.findIndex(
      (args) => args[0] === 'network' && args[1] === 'rm'
    );
    expect(inspectIndex).toBeGreaterThanOrEqual(0);
    expect(inspectIndex).toBeLessThan(removeIndex);
  });

  it('copies an ordered change set into the running workspace once and keeps HMR ready', async () => {
    const { docker, provider } = createProvider();
    const handle = await start(provider);
    await provider.inspect({ handle });
    const input = {
      idempotencyKey: 'studio-session-1:change:1',
      handle,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: CHANGE_DIGEST,
        contentRef: 'artifact:change-set-1',
      },
    };

    const first = await provider.applyChangeSet(input);
    const replay = await provider.applyChangeSet(input);

    expect(replay).toEqual(first);
    expect(docker.calls.filter((args) => args[0] === 'cp')).toHaveLength(1);
    expect(docker.calls.find((args) => args[0] === 'cp')).toEqual(
      expect.arrayContaining(['C:\\studio\\change-set\\.'])
    );
    expect(
      docker.calls.find(
        (args) =>
          args[0] === 'exec' &&
          args.includes('/workspace/apps/web/src/obsolete.ts')
      )
    ).toEqual(
      expect.arrayContaining([
        'rm',
        '-rf',
        '--',
        '/workspace/apps/web/src/obsolete.ts',
      ])
    );
    const snapshot = (await provider.inspect({ handle })).snapshot;
    expect(snapshot?.workspace).toMatchObject({
      version: 1,
      appliedChangeSets: [input.changeSet],
    });
    expect(evaluateEditablePreviewReadiness(snapshot!)).toEqual({
      ready: true,
    });
  });

  it('rejects a stale workspace version before mutating the container', async () => {
    const { docker, provider } = createProvider();
    const handle = await start(provider);
    await provider.inspect({ handle });
    await provider.applyChangeSet({
      idempotencyKey: 'studio-session-1:change:1',
      handle,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: CHANGE_DIGEST,
        contentRef: 'artifact:change-set-1',
      },
    });
    const copiesBefore = docker.calls.filter((args) => args[0] === 'cp').length;

    await expect(
      provider.applyChangeSet({
        idempotencyKey: 'studio-session-1:change:2',
        handle,
        expectedWorkspaceVersion: 0,
        changeSet: {
          digest: `sha256:${'e'.repeat(64)}`,
          contentRef: 'artifact:change-set-2',
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
    expect(docker.calls.filter((args) => args[0] === 'cp')).toHaveLength(
      copiesBefore
    );
  });

  it('maps stable tasks and lifecycle operations to the running session and cleans up Docker resources', async () => {
    const { docker, provider } = createProvider();
    const handle = await start(provider);
    await provider.inspect({ handle });

    expect(
      (
        await provider.runTask({
          idempotencyKey: 'studio-session-1:task:1',
          handle,
          expectedWorkspaceVersion: 0,
          task: 'typecheck',
        })
      ).ok
    ).toBe(true);
    expect(
      docker.calls.find(
        (args) =>
          args[0] === 'run' &&
          args.includes('--rm') &&
          args.slice(-6).join(' ') ===
            'corepack pnpm -r --workspace-concurrency=1 run typecheck'
      )
    ).toBeDefined();
    const taskRun = docker.calls.find(
      (args) =>
        args[0] === 'run' &&
        args.includes('--rm') &&
        args.slice(-6).join(' ') ===
          'corepack pnpm -r --workspace-concurrency=1 run typecheck'
    );
    expect(taskRun).toEqual(
      expect.arrayContaining([
        '--memory',
        '2g',
        '--memory-swap',
        '2g',
        '--user',
        '0:0',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'DAC_OVERRIDE',
        '--cap-add',
        'FOWNER',
        '--env',
        'APEX_API_PROXY_TARGET=',
      ])
    );
    expect(
      docker.calls.find(
        (args) =>
          args[0] === 'commit' &&
          args.includes('--no-pause') &&
          args.some((arg) => arg.startsWith('apex-studio-app-'))
      )
    ).toBeDefined();
    expect(
      docker.calls.some(
        (args) =>
          args[0] === 'exec' &&
          args.slice(-6).join(' ') ===
            'corepack pnpm -r --workspace-concurrency=1 run typecheck'
      )
    ).toBe(false);

    await provider.suspend({
      idempotencyKey: 'studio-session-1:suspend:1',
      handle,
    });
    await provider.resume({
      idempotencyKey: 'studio-session-1:resume:1',
      handle,
    });
    await provider.destroy({
      idempotencyKey: 'studio-session-1:destroy:1',
      handle,
    });

    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'terminated'
    );
    expect(
      docker.calls.some((args) => args[0] === 'rm' && args[1] === '--force')
    ).toBe(true);
    expect(
      docker.calls.some((args) => args[0] === 'network' && args[1] === 'rm')
    ).toBe(true);
    expect(
      docker.calls.some(
        (args) =>
          args[0] === 'image' && args[1] === 'rm' && args[2] === '--force'
      )
    ).toBe(true);
  });

  it('rejects unsafe deletion paths before Docker receives them', async () => {
    const docker = new RecordingDocker();
    const provider = createDockerEditablePreviewSessionProvider({
      docker,
      now: () => new Date(NOW),
      resolveSourceSnapshot: async (source) => ({
        path: 'C:\\studio\\source',
        digest: source.snapshotDigest,
      }),
      resolveChangeSet: async (changeSet) => ({
        path: path.join('C:\\studio', 'change-set'),
        digest: changeSet.digest,
        deletePaths: ['../outside-workspace'],
      }),
      probeTransport: async () => ({
        http: 'ready',
        websocket: 'ready',
        vite_hmr: 'ready',
      }),
    });
    const handle = await start(provider);
    await provider.inspect({ handle });

    await expect(
      provider.applyChangeSet({
        idempotencyKey: 'studio-session-1:change:unsafe',
        handle,
        expectedWorkspaceVersion: 0,
        changeSet: {
          digest: CHANGE_DIGEST,
          contentRef: 'artifact:change-set-unsafe',
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', retryable: false },
    });
    expect(docker.calls.some((args) => args[0] === 'cp')).toBe(false);
  });
});
