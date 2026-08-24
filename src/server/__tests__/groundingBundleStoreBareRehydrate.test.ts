import { execFile } from 'child_process';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ContainerClient } from '@azure/storage-blob';
import type { RepositoryIdentity } from '../../shared/types/repoReader';

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

import {
  createGroundingBundleStore,
  GROUNDING_WORKSPACE_READY_MARKER,
  GroundingBundleAuthorizationError,
} from '../services/grounding/bundleStoreService';

function runRealGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

interface Fixture {
  root: string;
  bundlePath: string;
  destination: string;
  identity: RepositoryIdentity;
}

/** A real single-branch bundle, matching what the publisher uploads. */
async function buildBundle(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'grounding-bare-'));
  const source = join(root, 'source');
  const bundlePath = join(root, 'snapshot.bundle');

  await runRealGit(['init', source]);
  await runRealGit(['config', 'user.email', 'apex-tests@example.invalid'], source);
  await runRealGit(['config', 'user.name', 'Apex Tests'], source);
  await writeFile(join(source, 'snapshot.txt'), 'pinned content');
  await runRealGit(['add', 'snapshot.txt'], source);
  await runRealGit(['commit', '-m', 'pinned commit'], source);

  const branch = (
    await runRealGit(['rev-parse', '--abbrev-ref', 'HEAD'], source)
  ).trim();
  const sha = (await runRealGit(['rev-parse', 'HEAD'], source)).trim();
  await runRealGit(
    ['bundle', 'create', bundlePath, `refs/heads/${branch}`],
    source,
  );

  return {
    root,
    bundlePath,
    destination: join(root, 'mirror.git'),
    identity: { provider: 'ado', project: 'MaxView', repo: 'MaxView', sha },
  };
}

function storeServing(blockBlob: Record<string, jest.Mock>) {
  return createGroundingBundleStore({
    getContainerClient: () =>
      ({ getBlockBlobClient: () => blockBlob }) as unknown as ContainerClient,
    repairAndMaterialize: async () => false,
    telemetry: jest.fn(),
  });
}

function downloadOf(bundlePath: string): Record<string, jest.Mock> {
  return {
    downloadToFile: jest.fn(async (target: string) => {
      await copyFile(bundlePath, target);
    }),
  };
}

function failingDownload(statusCode: number): Record<string, jest.Mock> {
  return {
    downloadToFile: jest.fn(async () => {
      throw Object.assign(new Error(`blob ${statusCode}`), { statusCode });
    }),
  };
}

describe('rehydrateBare', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await buildBundle();
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  it('restores an object database rather than a working tree', async () => {
    const store = storeServing(downloadOf(fixture.bundlePath));

    const result = await store.rehydrateBare(
      fixture.identity,
      fixture.destination,
    );

    expect(result).toEqual({ status: 'materialized', source: 'bundle' });
    // The whole point of the read service: objects, no checked-out files.
    await expect(stat(join(fixture.destination, 'HEAD'))).resolves.toBeDefined();
    await expect(
      stat(join(fixture.destination, 'snapshot.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      stat(join(fixture.destination, '.git')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serves the pinned commit out of the restored mirror', async () => {
    const store = storeServing(downloadOf(fixture.bundlePath));

    await store.rehydrateBare(fixture.identity, fixture.destination);

    const blob = await runRealGit(
      ['-C', fixture.destination, 'cat-file', '-p', `${fixture.identity.sha}:snapshot.txt`],
    );
    expect(blob).toContain('pinned content');
  });

  it('reuses a ready mirror instead of downloading again', async () => {
    const blockBlob = downloadOf(fixture.bundlePath);
    const store = storeServing(blockBlob);
    await store.rehydrateBare(fixture.identity, fixture.destination);

    const second = await store.rehydrateBare(
      fixture.identity,
      fixture.destination,
    );

    expect(second).toEqual({ status: 'materialized', source: 'workspace' });
    expect(blockBlob.downloadToFile).toHaveBeenCalledTimes(1);
  });

  it('marks the mirror ready at its root, since a bare repo has no .git', async () => {
    const store = storeServing(downloadOf(fixture.bundlePath));

    await store.rehydrateBare(fixture.identity, fixture.destination);

    await expect(
      stat(join(fixture.destination, GROUNDING_WORKSPACE_READY_MARKER)),
    ).resolves.toBeDefined();
  });

  it('reports a missing bundle so the caller can clone the remote', async () => {
    const store = storeServing(failingDownload(404));

    const result = await store.rehydrateBare(
      fixture.identity,
      fixture.destination,
    );

    expect(result).toEqual({
      status: 'remote-fallback',
      reason: 'bundle-missing',
    });
  });

  it('leaves no half-written mirror behind when the bundle is unusable', async () => {
    const corrupt = join(fixture.root, 'corrupt.bundle');
    await writeFile(corrupt, 'not a git bundle');
    const store = storeServing(downloadOf(corrupt));

    const result = await store.rehydrateBare(
      fixture.identity,
      fixture.destination,
    );

    expect(result).toEqual({
      status: 'remote-fallback',
      reason: 'bundle-corrupt',
    });
    // A partial mirror would fail every later read instead of triggering a clone.
    await expect(stat(fixture.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('surfaces an authorization failure rather than silently cloning', async () => {
    const store = storeServing(failingDownload(403));

    await expect(
      store.rehydrateBare(fixture.identity, fixture.destination),
    ).rejects.toBeInstanceOf(GroundingBundleAuthorizationError);
  });

  it('rejects a bundle that does not contain the pinned commit', async () => {
    const store = storeServing(downloadOf(fixture.bundlePath));
    const wrongSha = {
      ...fixture.identity,
      sha: 'b'.repeat(40),
    };

    const result = await store.rehydrateBare(wrongSha, fixture.destination);

    expect(result).toEqual({
      status: 'remote-fallback',
      reason: 'bundle-corrupt',
    });
  });
});
