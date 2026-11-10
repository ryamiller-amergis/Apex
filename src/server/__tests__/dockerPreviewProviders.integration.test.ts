import { createHash, randomUUID } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDockerPostgresSandboxDataProvider } from '../services/build/dockerPostgresSandboxDataProvider';
import {
  createDockerCommandRunner,
  createDockerPreviewResourceStore,
  dockerResourceName,
} from '../services/build/dockerPreviewRuntime';
import { createDockerSandboxProvider } from '../services/build/dockerSandboxProvider';
import type {
  ApexPreviewCorrelation,
  ProviderMutationResult,
} from '../services/build/buildPreviewProviderContracts';

const runDockerIntegration = process.env.RUN_DOCKER_PREVIEW_INTEGRATION === '1';
const describeDocker = runDockerIntegration ? describe : describe.skip;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(__dirname, '../../..');
const templateRoot = path.join(
  repositoryRoot,
  'templates',
  'full-stack-express'
);
const bundlePath = path.join(
  templateRoot,
  'artifacts',
  'preview',
  'apex-preview-runtime.tar'
);
const runnerImage = 'apex/full-stack-express-preview-runner:1.0.0';

function accepted(result: ProviderMutationResult): string {
  if (!result.ok || !result.accepted.handle) {
    throw new Error(
      `Expected accepted mutation: ${JSON.stringify(result, null, 2)}`
    );
  }
  return result.accepted.handle;
}

async function waitFor<T>(
  observe: () => Promise<T>,
  complete: (value: T) => boolean,
  timeoutMs = 90_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await observe();
  while (!complete(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await observe();
  }
  if (!complete(latest)) {
    throw new Error(`Timed out waiting for Docker: ${JSON.stringify(latest)}`);
  }
  return latest;
}

describeDocker('Docker preview provider integration', () => {
  jest.setTimeout(10 * 60_000);

  it('migrates, seeds, starts, probes, and destroys a real preview', async () => {
    if (process.env.REUSE_DOCKER_PREVIEW_ASSETS !== '1') {
      await execAsync('corepack pnpm build', {
        cwd: templateRoot,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
      await execFileAsync(
        'node',
        ['scripts/preview/build-runtime-bundle.mjs'],
        {
          cwd: templateRoot,
          windowsHide: true,
        }
      );
      await execFileAsync(
        'docker',
        ['build', '--file', 'Dockerfile.preview', '--tag', runnerImage, '.'],
        {
          cwd: templateRoot,
          windowsHide: true,
          timeout: 8 * 60_000,
          maxBuffer: 50 * 1024 * 1024,
        }
      );
    }

    const bundle = await readFile(bundlePath);
    const runtimeDigest = `sha256:${createHash('sha256')
      .update(bundle)
      .digest('hex')}`;
    const previewInstanceId = `docker-integration-${randomUUID()}`;
    const correlation: ApexPreviewCorrelation = {
      previewInstanceId,
      buildRunId: `run-${randomUUID()}`,
      revisionId: `revision-${randomUUID()}`,
      revisionNumber: 1,
      validatedCommit: 'a'.repeat(40),
      templateVersion: '1.0.0',
    };
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const docker = createDockerCommandRunner({ timeoutMs: 180_000 });
    const resources = createDockerPreviewResourceStore();
    const resolveRuntimeBundle = async (digest: string) => ({
      path: bundlePath,
      digest:
        digest === runtimeDigest
          ? runtimeDigest
          : (() => {
              throw new Error(`Unknown test bundle digest: ${digest}`);
            })(),
    });
    const data = createDockerPostgresSandboxDataProvider({
      docker,
      resources,
      postgresImage: 'postgres:16',
      previewRunnerImage: runnerImage,
      resolveRuntimeBundle,
    });
    const sandbox = createDockerSandboxProvider({
      docker,
      resources,
      previewRunnerImage: runnerImage,
      resolveRuntimeBundle,
    });

    let databaseHandle: string | null = null;
    let sandboxHandle: string | null = null;
    try {
      databaseHandle = accepted(
        await data.create({
          idempotencyKey: `${previewInstanceId}:data:create`,
          correlation,
          expiresAt,
        })
      );
      await waitFor(
        () => data.inspect({ databaseHandle: databaseHandle! }),
        (result) => result.snapshot?.phase === 'migrating'
      );
      accepted(
        await data.migrate({
          idempotencyKey: `${previewInstanceId}:data:migrate`,
          databaseHandle,
          migrationArtifactDigest: runtimeDigest,
        })
      );
      accepted(
        await data.seed({
          idempotencyKey: `${previewInstanceId}:data:seed`,
          databaseHandle,
          seedRecipeDigest: runtimeDigest,
        })
      );

      sandboxHandle = accepted(
        await sandbox.provision({
          idempotencyKey: `${previewInstanceId}:sandbox:provision`,
          spec: {
            correlation,
            artifactDigest: runtimeDigest,
            runtimeBundleDigest: runtimeDigest,
            expiresAt,
            policy: {
              egress: 'denied',
              maxRuntimeSeconds: 7200,
            },
          },
        })
      );
      const inspected = await waitFor(
        () => sandbox.inspect({ handle: sandboxHandle! }),
        (result) => result.snapshot?.lifecycle === 'running'
      );
      const upstream =
        inspected.snapshot?.applicationTarget?.upstreamRef.replace(
          'docker-loopback:',
          'http://'
        );
      if (!upstream)
        throw new Error('Docker preview has no application target.');

      const [health, seededUser, html] = await Promise.all([
        fetch(`${upstream}/health/ready`),
        fetch(`${upstream}/api/v1/me`),
        fetch(upstream),
      ]);
      expect(health.status).toBe(200);
      expect(seededUser.status).toBe(200);
      expect(await seededUser.json()).toMatchObject({
        displayName: expect.any(String),
      });
      expect(html.status).toBe(200);
      expect(await html.text()).toContain('<div id="root"></div>');

      const sandboxDestroy = await sandbox.destroy({
        idempotencyKey: `${previewInstanceId}:sandbox:destroy`,
        handle: sandboxHandle,
      });
      expect(sandboxDestroy.ok).toBe(true);
      expect(
        (await sandbox.inspect({ handle: sandboxHandle })).snapshot?.lifecycle
      ).toBe('terminated');
      sandboxHandle = null;

      const databaseDestroy = await data.destroy({
        idempotencyKey: `${previewInstanceId}:data:destroy`,
        databaseHandle,
      });
      expect(databaseDestroy.ok).toBe(true);
      expect((await data.inspect({ databaseHandle })).snapshot?.phase).toBe(
        'destroyed'
      );
      databaseHandle = null;
    } finally {
      if (sandboxHandle) {
        await sandbox.destroy({
          idempotencyKey: `${previewInstanceId}:sandbox:destroy`,
          handle: sandboxHandle,
        });
      }
      if (databaseHandle) {
        await data.destroy({
          idempotencyKey: `${previewInstanceId}:data:destroy`,
          databaseHandle,
        });
      }
      await docker
        .run([
          'rm',
          '--force',
          dockerResourceName('proxy', previewInstanceId),
          dockerResourceName('app', previewInstanceId),
          dockerResourceName('db', previewInstanceId),
        ])
        .catch(() => undefined);
      await docker
        .run([
          'network',
          'rm',
          dockerResourceName('network', previewInstanceId),
        ])
        .catch(() => undefined);
    }
  });
});
