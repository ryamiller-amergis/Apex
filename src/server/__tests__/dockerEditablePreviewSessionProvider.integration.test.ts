import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  createDockerEditablePreviewSessionProvider,
  studioNetworkNameFor,
  type ResolvedEditablePreviewChangeSet,
} from '../services/build/dockerEditablePreviewSessionProvider';
import { createDockerCommandRunner } from '../services/build/dockerPreviewRuntime';
import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
  type EditablePreviewSessionSpec,
  type ProviderMutationResult,
} from '../services/build/buildPreviewProviderContracts';

const runDockerIntegration = process.env.RUN_DOCKER_STUDIO_INTEGRATION === '1';
const describeDocker = runDockerIntegration ? describe : describe.skip;
const repositoryRoot = path.resolve(__dirname, '../../..');
const templateRoot = path.join(
  repositoryRoot,
  'templates',
  'full-stack-express'
);
const appSourcePath = path.join(
  templateRoot,
  'apps',
  'web',
  'src',
  'app',
  'App.tsx'
);

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function accepted(result: ProviderMutationResult): string {
  if (!result.ok || !result.accepted.handle) {
    throw new Error(
      `Expected an accepted mutation: ${JSON.stringify(result, null, 2)}`
    );
  }
  return result.accepted.handle;
}

async function waitFor<T>(
  observe: () => Promise<T>,
  complete: (value: T) => boolean,
  timeoutMs = 180_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await observe();
  while (!complete(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await observe();
  }
  if (!complete(latest)) {
    throw new Error(`Timed out waiting for Studio: ${JSON.stringify(latest)}`);
  }
  return latest;
}

describeDocker('Docker editable preview HMR integration', () => {
  jest.setTimeout(20 * 60_000);

  it('updates the sandboxed Build iframe through Vite HMR after a change set', async () => {
    const sessionId = `studio-integration-${randomUUID()}`;
    const sourceDigest = digest(sessionId);
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const spec: EditablePreviewSessionSpec = {
      contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
      correlation: {
        sessionId,
        buildRunId: `build-${randomUUID()}`,
        baseRevisionId: `revision-${randomUUID()}`,
        draftRevisionId: `revision-${randomUUID()}`,
        revisionNumber: 2,
        baseCommit: 'a'.repeat(40),
        templateVersion: '1.0.0',
      },
      source: {
        snapshotDigest: sourceDigest,
        snapshotRef: `artifact:${sessionId}`,
      },
      developmentManifestDigest: digest('development-manifest-v1'),
      databaseGrantRef: `grant:${sessionId}`,
      expiresAt,
      policy: {
        egress: 'denied',
        maxRuntimeSeconds: 7_200,
        writableWorkspace: true,
      },
      requiredTransports: EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
    };
    const docker = createDockerCommandRunner({ timeoutMs: 20 * 60_000 });
    let resolvedChangeSet: ResolvedEditablePreviewChangeSet | null = null;
    const createProvider = () =>
      createDockerEditablePreviewSessionProvider({
        docker,
        resolveSourceSnapshot: async () => ({
          path: templateRoot,
          digest: sourceDigest,
        }),
        resolveChangeSet: async () => {
          if (!resolvedChangeSet) {
            throw new Error('The integration change set is unavailable.');
          }
          return resolvedChangeSet;
        },
      });
    let provider = createProvider();

    let handle: string | null = null;
    let runtimeContainer: string | null = null;
    let overlayRoot: string | null = null;
    let hostServer: Server | null = null;
    const browser = await chromium.launch({ headless: true });
    try {
      handle = accepted(
        await provider.start({
          idempotencyKey: `${sessionId}:start`,
          spec,
        })
      );
      const suffix = createHash('sha256')
        .update(sessionId)
        .digest('hex')
        .slice(0, 16);
      runtimeContainer = `apex-preview-app-${suffix}`;
      await docker.run([
        'run',
        '--detach',
        '--name',
        runtimeContainer,
        '--network',
        studioNetworkNameFor(sessionId),
        '--network-alias',
        'studio-api',
        `apex/full-stack-express-studio:${suffix}`,
        'node',
        '-e',
        "require('node:http').createServer((req,res)=>{if(req.url==='/health/ready'){res.writeHead(200,{'content-type':'application/json'});res.end('{\"status\":\"ready\"}');return;}res.writeHead(404);res.end();}).listen(3000,'0.0.0.0')",
      ]);
      const ready = await waitFor(
        () => provider.inspect({ handle: handle! }),
        (result) => result.snapshot?.lifecycle === 'ready'
      );
      const upstreamRef = ready.snapshot?.transport?.upstreamRef;
      if (!upstreamRef?.startsWith('docker-loopback:')) {
        throw new Error('Studio did not return a Docker loopback upstream.');
      }
      const restartedProvider = createProvider();
      const recoveryStartedAt = Date.now();
      handle = accepted(
        await restartedProvider.start({
          idempotencyKey: `${sessionId}:restart`,
          spec,
        })
      );
      const recovered = await waitFor(
        () => restartedProvider.inspect({ handle: handle! }),
        (result) => result.snapshot?.lifecycle === 'ready',
        10_000
      );
      expect(Date.now() - recoveryStartedAt).toBeLessThan(10_000);
      expect(recovered.snapshot?.transport?.upstreamRef).toBe(upstreamRef);
      provider = restartedProvider;

      const previewUrl = `http://${upstreamRef.slice(
        'docker-loopback:'.length
      )}/`;
      const page = await browser.newPage();
      const browserDiagnostics: string[] = [];
      page.on('console', (message) => {
        browserDiagnostics.push(`console.${message.type()}: ${message.text()}`);
      });
      page.on('pageerror', (error) => {
        browserDiagnostics.push(`pageerror: ${error.message}`);
      });
      page.on('requestfailed', (request) => {
        browserDiagnostics.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`
        );
      });
      hostServer = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(
          `<iframe title="Build preview" style="width:1280px;height:800px;border:0" sandbox="allow-forms allow-modals allow-scripts allow-same-origin" referrerpolicy="no-referrer" src="${previewUrl}"></iframe>`
        );
      });
      await new Promise<void>((resolve, reject) => {
        hostServer!.once('error', reject);
        hostServer!.listen(0, '127.0.0.1', resolve);
      });
      const hostAddress = hostServer.address();
      if (!hostAddress || typeof hostAddress === 'string') {
        throw new Error('Could not start the Build iframe host.');
      }
      await page.goto(`http://127.0.0.1:${hostAddress.port}/`, {
        waitUntil: 'domcontentloaded',
      });
      const previewFrame = page.frameLocator('iframe[title="Build preview"]');
      try {
        await previewFrame.getByRole('link', { name: 'Profile' }).waitFor();
      } catch (error) {
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            `frames: ${page
              .frames()
              .map((frame) => frame.url())
              .join(', ')}`,
            ...browserDiagnostics,
          ].join('\n')
        );
      }

      const originalSource = await readFile(appSourcePath, 'utf8');
      const updatedSource = originalSource.replace(
        "{ id: 'profile', label: 'Profile', to: '/profile' }",
        "{ id: 'profile', label: 'People', to: '/profile' }"
      );
      if (updatedSource === originalSource) {
        throw new Error('Could not prepare the HMR proof change.');
      }
      overlayRoot = await mkdtemp(path.join(tmpdir(), 'apex-studio-change-'));
      const overlayFile = path.join(
        overlayRoot,
        'apps',
        'web',
        'src',
        'app',
        'App.tsx'
      );
      await mkdir(path.dirname(overlayFile), { recursive: true });
      await writeFile(overlayFile, updatedSource, 'utf8');
      const changeDigest = digest(updatedSource);
      resolvedChangeSet = {
        path: overlayRoot,
        digest: changeDigest,
        deletePaths: [],
      };

      const changed = await provider.applyChangeSet({
        idempotencyKey: `${sessionId}:change:1`,
        handle,
        expectedWorkspaceVersion: 0,
        changeSet: {
          digest: changeDigest,
          contentRef: `artifact:${sessionId}:change:1`,
        },
      });
      expect(changed.ok).toBe(true);
      await previewFrame
        .getByRole('link', { name: 'People' })
        .waitFor({ timeout: 30_000 });
      expect(
        page
          .frames()
          .find((frame) => frame !== page.mainFrame())
          ?.url()
      ).toContain('/profile');
      await expect(provider.inspect({ handle })).resolves.toMatchObject({
        phase: 'succeeded',
        snapshot: {
          lifecycle: 'ready',
          workspace: { version: 1 },
          transport: {
            checks: {
              http: 'ready',
              websocket: 'ready',
              vite_hmr: 'ready',
            },
          },
        },
      });
    } finally {
      await browser.close();
      if (hostServer) {
        await new Promise<void>((resolve, reject) => {
          hostServer!.close((error) => (error ? reject(error) : resolve()));
        });
      }
      if (runtimeContainer) {
        await docker.run(['rm', '--force', runtimeContainer]);
      }
      if (handle) {
        await provider.destroy({
          idempotencyKey: `${sessionId}:destroy`,
          handle,
        });
      }
      if (overlayRoot) {
        await rm(overlayRoot, { recursive: true, force: true });
      }
    }
  });
});
