import { execFile } from 'child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
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
  bundleKey,
  createGroundingBundleStore,
  groundingCredentialMode,
  GroundingBundleAuthorizationError,
  materializeGroundingBundle,
  type BundleStoreTelemetry,
  type GitRunner,
} from '../services/grounding/bundleStoreService';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const identity: RepositoryIdentity = {
  provider: 'ado',
  project: 'Apex Team',
  repo: 'AI/Pilot',
  sha: SHA,
};

function fakeContainer(blockBlob: Record<string, jest.Mock>): ContainerClient {
  return {
    getBlockBlobClient: jest.fn(() => blockBlob),
  } as unknown as ContainerClient;
}

function runRealGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

describe('AC-0 rehydrates an isolated checkout at the exact pinned SHA', () => {
  it('AC-0 materializes a real git bundle at the pinned commit when no worktree exists', async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), 'grounding-ac0-'));
    const source = join(root, 'source');
    const destination = join(root, 'isolated-checkout');
    const bundlePath = join(root, 'snapshot.bundle');

    try {
      await runRealGit(['init', source]);
      await runRealGit(
        ['config', 'user.email', 'apex-tests@example.invalid'],
        source
      );
      await runRealGit(['config', 'user.name', 'Apex Tests'], source);
      await writeFile(join(source, 'snapshot.txt'), 'pinned content');
      await runRealGit(['add', 'snapshot.txt'], source);
      await runRealGit(['commit', '-m', 'pinned commit'], source);
      const pinnedSha = (
        await runRealGit(['rev-parse', 'HEAD'], source)
      ).trim();
      await writeFile(join(source, 'snapshot.txt'), 'newer content');
      await runRealGit(['commit', '-am', 'newer commit'], source);
      await runRealGit(['bundle', 'create', bundlePath, '--all'], source);
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

      const pinnedIdentity: RepositoryIdentity = {
        ...identity,
        sha: pinnedSha,
      };
      const downloadToFile = jest.fn((downloadPath: string) =>
        copyFile(bundlePath, downloadPath)
      );
      const repairAndMaterialize = jest.fn();
      const store = createGroundingBundleStore({
        getContainerClient: () => fakeContainer({ downloadToFile }),
        repairAndMaterialize,
      });

      // When
      const result = await store.rehydrate(pinnedIdentity, destination);

      // Then
      expect(result).toEqual({ status: 'materialized', source: 'bundle' });
      expect((await stat(destination)).isDirectory()).toBe(true);
      expect(
        (await runRealGit(['-C', destination, 'rev-parse', 'HEAD'])).trim()
      ).toBe(pinnedSha);
      expect(
        (
          await runRealGit([
            '-C',
            destination,
            'rev-parse',
            '--abbrev-ref',
            'HEAD',
          ])
        ).trim()
      ).toBe('HEAD');
      await expect(
        readFile(join(destination, 'snapshot.txt'), 'utf8')
      ).resolves.toBe('pinned content');
      expect(repairAndMaterialize).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses an existing checkout at the exact pinned SHA without downloading it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grounding-warm-reuse-'));
    const destination = join(root, 'isolated-checkout');
    const downloadToFile = jest.fn();

    try {
      await runRealGit(['init', destination]);
      await runRealGit(
        ['config', 'user.email', 'apex-tests@example.invalid'],
        destination
      );
      await runRealGit(['config', 'user.name', 'Apex Tests'], destination);
      await writeFile(join(destination, 'snapshot.txt'), 'pinned content');
      await runRealGit(['add', 'snapshot.txt'], destination);
      await runRealGit(['commit', '-m', 'pinned commit'], destination);
      const pinnedSha = (
        await runRealGit(['rev-parse', 'HEAD'], destination)
      ).trim();
      const store = createGroundingBundleStore({
        getContainerClient: () => fakeContainer({ downloadToFile }),
        repairAndMaterialize: jest.fn(),
      });

      await expect(
        store.rehydrate({ ...identity, sha: pinnedSha }, destination)
      ).resolves.toEqual({ status: 'materialized', source: 'workspace' });
      expect(downloadToFile).not.toHaveBeenCalled();
      await expect(
        readFile(join(destination, 'snapshot.txt'), 'utf8')
      ).resolves.toBe('pinned content');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AC-1 missing or corrupt bundle repairs before controlled fallback', () => {
  it.each([
    { scenario: 'missing', expectedReason: 'bundle-missing' as const },
    { scenario: 'corrupt', expectedReason: 'bundle-corrupt' as const },
  ])(
    'AC-1 invokes repair before fallback for a $scenario bundle and removes its partial destination',
    async ({ scenario, expectedReason }) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), `grounding-ac1-${scenario}-`));
      const destination = join(root, 'partial-checkout');
      const secret = 'https://credential@example.invalid/private/repo';
      const order: string[] = [];
      const downloadToFile = jest.fn(async (downloadPath: string) => {
        order.push('bundle');
        if (scenario === 'missing') {
          throw Object.assign(new Error(`not found: ${secret}`), {
            statusCode: 404,
          });
        }
        await writeFile(downloadPath, `corrupt bundle ${secret}`);
      });
      const repairAndMaterialize = jest.fn(async () => {
        order.push('repair');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'partial.txt'), secret);
        return scenario === 'corrupt';
      });
      const runGit: GitRunner = jest.fn(async (args) => {
        if (args.includes('bundle') && args.includes('verify')) {
          throw new Error(`invalid bundle: ${secret}`);
        }
        if (args.includes('rev-parse')) return `${'f'.repeat(40)}\n`;
        return '';
      });
      const store = createGroundingBundleStore({
        getContainerClient: () => fakeContainer({ downloadToFile }),
        repairAndMaterialize,
        runGit,
      });

      try {
        // When
        const result = await store.rehydrate(identity, destination);
        order.push('returned');

        // Then
        expect(repairAndMaterialize).toHaveBeenCalledWith({
          identity,
          destination,
        });
        expect(order).toEqual(['bundle', 'repair', 'returned']);
        expect(result).toEqual({
          status: 'remote-fallback',
          reason: expectedReason,
        });
        await expect(stat(destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(JSON.stringify(result)).not.toContain(destination);
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe('AC-2 concurrent writers converge on one immutable bundle', () => {
  it('checks the content-addressed key before a publisher builds a bundle', async () => {
    // Given
    const exists = jest.fn().mockResolvedValue(true);
    const store = createGroundingBundleStore({
      getContainerClient: () => fakeContainer({ exists }),
      repairAndMaterialize: jest.fn(),
    });

    // When / Then
    await expect(store.bundleExists(identity)).resolves.toBe(true);
    expect(exists).toHaveBeenCalledTimes(1);
  });

  it.each([409, 412])(
    'AC-2 uses If-None-Match "*", accepts a %i winner, and cleans both temporary artifacts',
    async (concurrentStatus) => {
      // Given
      const directory = await mkdtemp(join(tmpdir(), 'grounding-ac2-'));
      const firstPath = join(directory, 'first.bundle');
      const secondPath = join(directory, 'second.bundle');
      const immutableContent = 'same immutable bundle';
      await Promise.all([
        writeFile(firstPath, immutableContent),
        writeFile(secondPath, immutableContent),
      ]);
      let storedContent: string | undefined;
      let createCount = 0;
      const uploadFile = jest.fn(
        async (
          uploadPath: string,
          options: { conditions: { ifNoneMatch: string } }
        ) => {
          expect(options.conditions.ifNoneMatch).toBe('*');
          const candidate = await readFile(uploadPath, 'utf8');
          if (storedContent !== undefined) {
            throw Object.assign(new Error('condition not met'), {
              statusCode: concurrentStatus,
            });
          }
          storedContent = candidate;
          createCount += 1;
        }
      );
      const store = createGroundingBundleStore({
        getContainerClient: () => fakeContainer({ uploadFile }),
        repairAndMaterialize: jest.fn(),
      });

      try {
        // When
        const refs = await Promise.all([
          store.uploadBundle(identity, firstPath),
          store.uploadBundle(identity, secondPath),
        ]);

        // Then
        expect(createCount).toBe(1);
        expect(storedContent).toBe(immutableContent);
        expect(refs).toEqual([
          { container: 'repo-grounding', key: bundleKey(identity), sha: SHA },
          { container: 'repo-grounding', key: bundleKey(identity), sha: SHA },
        ]);
        expect(uploadFile).toHaveBeenCalledTimes(2);
        await expect(readFile(firstPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(secondPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});

describe('AC-3 authorization denial never uses public, SAS, or account-key fallback', () => {
  it('AC-3 uses the system-assigned identity on App Service instead of the auth client ID', () => {
    const environment = {
      WEBSITE_SITE_NAME: 'apex-production',
      AZURE_CLIENT_ID: 'application-auth-registration-id',
      AZURE_CLIENT_SECRET: 'application-auth-secret',
    } as NodeJS.ProcessEnv;

    expect(groundingCredentialMode(environment)).toBe(
      'system-assigned-managed-identity'
    );
  });

  it.each(['upload', 'download'] as const)(
    'AC-3 surfaces a redacted typed authorization error for %s without fallback',
    async (operation) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), `grounding-ac3-${operation}-`));
      const temporaryBundlePath = join(root, 'secret.bundle');
      const destination = join(root, 'private-checkout');
      const secret = 'AccountKey=credential-do-not-leak';
      await writeFile(temporaryBundlePath, 'temporary bundle');
      const authorizationFailure = Object.assign(
        new Error(`${secret} at ${destination}`),
        { statusCode: 403, code: 'AuthorizationFailure' }
      );
      const uploadFile = jest.fn().mockRejectedValue(authorizationFailure);
      const downloadToFile = jest.fn().mockRejectedValue(authorizationFailure);
      const publicFallback = jest.fn();
      const sasFallback = jest.fn();
      const accountKeyFallback = jest.fn();
      const repairAndMaterialize = jest.fn();
      const blockBlob = {
        uploadFile,
        downloadToFile,
        publicFallback,
        sasFallback,
        accountKeyFallback,
      };
      const store = createGroundingBundleStore({
        getContainerClient: () => fakeContainer(blockBlob),
        repairAndMaterialize,
      });

      try {
        // When
        const action =
          operation === 'upload'
            ? store.uploadBundle(identity, temporaryBundlePath)
            : store.rehydrate(identity, destination);
        const error = await action.catch((caught: unknown) => caught);

        // Then
        expect(error).toBeInstanceOf(GroundingBundleAuthorizationError);
        expect(error).toMatchObject({
          code: 'GROUNDING_BUNDLE_AUTHORIZATION_FAILED',
          message: 'Grounding bundle storage authorization failed',
        });
        expect(repairAndMaterialize).not.toHaveBeenCalled();
        expect(publicFallback).not.toHaveBeenCalled();
        expect(sasFallback).not.toHaveBeenCalled();
        expect(accountKeyFallback).not.toHaveBeenCalled();
        const serializedError = `${String(error)} ${JSON.stringify(error)}`;
        expect(serializedError).not.toContain(destination);
        expect(serializedError).not.toContain(secret);
        if (operation === 'upload') {
          await expect(readFile(temporaryBundlePath)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe('BR-003 support path-safe content-addressed key', () => {
  it('normalizes unsafe identity segments and retains the exact pinned SHA', () => {
    // Arrange
    const unsafeIdentity = {
      provider: 'ADO',
      project: '../Team Project//',
      repo: '.Repo Name\\Feature',
      sha: SHA.toUpperCase(),
    } as unknown as RepositoryIdentity;

    // Act
    const key = bundleKey(unsafeIdentity);

    // Assert
    expect(key).toBe(
      'ado/team-project/repo-name-feature/0123456789abcdef0123456789abcdef01234567.bundle'
    );
    expect(key).not.toMatch(/(^|\/)\.\.?($|\/)/);
    expect(key.split('/')).toHaveLength(4);
  });
});

describe('performance/observability privacy-safe hit/miss and duration signals', () => {
  it('emits raw bundle-hit and duration telemetry without identity, content, credentials, or paths', async () => {
    // Arrange
    const destination = await mkdtemp(join(tmpdir(), 'private-checkout-'));
    const secret = 'credential-do-not-log';
    const events: Parameters<BundleStoreTelemetry>[] = [];
    const telemetry: BundleStoreTelemetry = (
      name,
      properties,
      measurements
    ) => {
      events.push([name, properties, measurements]);
    };
    const downloadToFile = jest.fn(async (bundlePath: string) => {
      await writeFile(bundlePath, `source ${secret}`);
    });
    let cloned = false;
    const runGit: GitRunner = jest.fn(async (args) => {
      if (args.includes('clone')) cloned = true;
      if (args.includes('rev-parse')) {
        if (!cloned) throw new Error('not a git checkout');
        return `${SHA}\n`;
      }
      return '';
    });
    const store = createGroundingBundleStore({
      getContainerClient: () => fakeContainer({ downloadToFile }),
      repairAndMaterialize: jest.fn(),
      runGit,
      telemetry,
      now: (() => {
        let value = 100;
        return () => (value += 25);
      })(),
    });

    // Act
    const result = await store.rehydrate(identity, destination);

    // Assert
    expect(result).toEqual({ status: 'materialized', source: 'bundle' });
    expect(events).toEqual(
      expect.arrayContaining([
        ['grounding.bundle.lookup', { outcome: 'hit' }, undefined],
        [
          'grounding.bundle',
          expect.objectContaining({
            caller: 'bundle-store',
            project: 'system',
            result: 'hit',
          }),
          { hit: 1 },
        ],
        [
          'grounding.bundle.materialization.duration',
          { source: 'bundle', outcome: 'success' },
          { durationMs: expect.any(Number) },
        ],
      ])
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(identity.project);
    expect(serialized).not.toContain(identity.repo);
    expect(serialized).not.toContain(identity.sha);
    expect(serialized).not.toContain(destination);
    expect(serialized).not.toContain(secret);
  });

  it('TBI-008 DoD-0 emits a redacted contract bundle miss from the real lookup path', async () => {
    // Arrange
    const destination = join(
      tmpdir(),
      'private-bundle-destination-do-not-emit'
    );
    const credentialRepo = {
      ...identity,
      repo: 'https://user:bundle-secret@example.invalid/org/repo?token=abc',
    };
    const events: Parameters<BundleStoreTelemetry>[] = [];
    const store = createGroundingBundleStore({
      getContainerClient: () =>
        fakeContainer({
          downloadToFile: jest.fn().mockRejectedValue(
            Object.assign(new Error('missing'), {
              statusCode: 404,
            })
          ),
        }),
      repairAndMaterialize: jest.fn().mockResolvedValue(false),
      telemetry: (name, properties, measurements) => {
        events.push([name, properties, measurements]);
      },
      now: () => 100,
    });

    // Act
    await store.rehydrate(credentialRepo, destination);

    // Assert
    expect(events).toEqual(
      expect.arrayContaining([
        [
          'grounding.bundle',
          expect.objectContaining({ result: 'miss' }),
          { hit: 0 },
        ],
      ])
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('bundle-secret');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain(destination);
  });
});

describe('flag-off disabled returns controlled remote fallback without invoking Blob', () => {
  it('uses the disabled branch when repo-grounding-workspace-profile is off', async () => {
    // Arrange
    const rehydrate = jest.fn();
    const isFeatureEnabled = jest.fn().mockResolvedValue(false);

    // Act
    const result = await materializeGroundingBundle(
      {
        identity,
        destination: 'must-not-be-observed',
        flagContext: { userId: 'user-1', project: identity.project },
      },
      {
        store: { rehydrate },
        isFeatureEnabled,
      }
    );

    // Assert
    expect(isFeatureEnabled).toHaveBeenCalledWith(
      'repo-grounding-workspace-profile',
      { userId: 'user-1', project: identity.project }
    );
    expect(rehydrate).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'remote-fallback',
      reason: 'feature-disabled',
    });
  });
});
