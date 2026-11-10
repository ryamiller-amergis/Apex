import { exec, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createLocalBrowserEvidenceStore } from '../services/build/buildPreviewBrowserEvidenceStore';
import {
  createBuildPreviewBrowserVerifier,
  type BrowserCheckCompletion,
  type BrowserCheckRepository,
} from '../services/build/buildPreviewBrowserVerifier';
import type {
  ApexPreviewCorrelation,
  ProviderMutationResult,
} from '../services/build/buildPreviewProviderContracts';
import { createDockerPostgresSandboxDataProvider } from '../services/build/dockerPostgresSandboxDataProvider';
import {
  createDockerCommandRunner,
  createDockerPreviewResourceStore,
  dockerResourceName,
} from '../services/build/dockerPreviewRuntime';
import { createDockerSandboxProvider } from '../services/build/dockerSandboxProvider';
import { createGoldenStackPreviewJourneyRunner } from '../services/build/goldenStackPreviewJourneyRunner';

const enabled = process.env.RUN_DOCKER_BROWSER_VERIFIER_INTEGRATION === '1';
const describeDocker = enabled ? describe : describe.skip;
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
    throw new Error(`Expected accepted mutation: ${JSON.stringify(result)}`);
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

describeDocker('Docker browser verifier integration', () => {
  jest.setTimeout(10 * 60_000);

  it('reads, writes, reloads, scans, captures evidence, and restores data', async () => {
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
    const previewInstanceId = `docker-browser-${randomUUID()}`;
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
    const evidenceRoot = await mkdtemp(
      path.join(os.tmpdir(), 'docker-browser-evidence-')
    );
    const completions: BrowserCheckCompletion[] = [];
    const repository: BrowserCheckRepository = {
      createPending: async () => ({ id: randomUUID() }),
      complete: async (input) => {
        completions.push(input);
      },
    };

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
      const targetUrl =
        inspected.snapshot?.applicationTarget?.upstreamRef.replace(
          'docker-loopback:',
          'http://'
        );
      if (!targetUrl) {
        throw new Error('Docker preview has no browser target.');
      }
      const seeded = await fetch(`${targetUrl}/api/v1/me`).then((response) =>
        response.json()
      );

      const verifier = createBuildPreviewBrowserVerifier({
        repository,
        evidence: createLocalBrowserEvidenceStore({ root: evidenceRoot }),
        runner: createGoldenStackPreviewJourneyRunner(),
      });
      const outcome = await verifier.verify({
        revisionId: correlation.revisionId,
        instanceId: previewInstanceId,
        commit: correlation.validatedCommit,
        artifactDigest: runtimeDigest,
        targetUrl,
        journeyVersion: 'full-stack-express:profile:v1',
      });

      expect(outcome.status).toBe('passed');
      expect(completions).toHaveLength(1);
      expect(completions[0]).toMatchObject({
        buildPreviewInstanceId: previewInstanceId,
        commit: correlation.validatedCommit,
        artifactDigest: runtimeDigest,
        status: 'passed',
        consoleSummary: { errorCount: 0, pageErrorCount: 0 },
        networkSummary: { failureCount: 0 },
      });
      const names = outcome.evidenceRefs.map((ref) => {
        const parts = ref.key.split('/');
        return parts[parts.length - 1];
      });
      expect(names).toEqual(['screenshot.png', 'browser-check.json']);
      for (const ref of outcome.evidenceRefs) {
        expect(
          (await stat(path.join(evidenceRoot, ref.container, ref.key))).size
        ).toBeGreaterThan(0);
      }
      const evidence = JSON.parse(
        await readFile(
          path.join(
            evidenceRoot,
            outcome.evidenceRefs[1]!.container,
            outcome.evidenceRefs[1]!.key
          ),
          'utf8'
        )
      ) as { status: string; steps: Array<{ status: string }> };
      expect(evidence.status).toBe('passed');
      expect(evidence.steps).toHaveLength(6);
      expect(evidence.steps.every((step) => step.status === 'passed')).toBe(
        true
      );
      await expect(
        fetch(`${targetUrl}/api/v1/me`).then((response) => response.json())
      ).resolves.toEqual(seeded);

      expect(
        (
          await sandbox.destroy({
            idempotencyKey: `${previewInstanceId}:sandbox:destroy`,
            handle: sandboxHandle,
          })
        ).ok
      ).toBe(true);
      sandboxHandle = null;
      expect(
        (
          await data.destroy({
            idempotencyKey: `${previewInstanceId}:data:destroy`,
            databaseHandle,
          })
        ).ok
      ).toBe(true);
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
      await rm(evidenceRoot, { force: true, recursive: true });
    }
  });
});
