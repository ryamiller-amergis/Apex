import { readFile, stat, writeFile } from 'fs/promises';
import type { RepositoryIdentity } from '../../shared/types/grounding';

jest.mock('../db/drizzle', () => ({ db: {} }));

import { bundleKey } from '../services/grounding/bundleStoreService';
import {
  createGroundingBundlePublisher,
  type GroundingBundlePublisherStore,
} from '../services/grounding/groundingBundlePublisherService';

const sha = 'a'.repeat(40);
const identity: RepositoryIdentity = {
  provider: 'github',
  project: 'Apex',
  repo: 'AI-Pilot',
  sha,
};

describe('groundingBundlePublisherService', () => {
  it('skips bundle creation when the immutable Blob already exists', async () => {
    // Given
    const store: GroundingBundlePublisherStore = {
      bundleExists: jest.fn().mockResolvedValue(true),
      uploadBundle: jest.fn(),
    };
    const runGit = jest.fn();
    const publisher = createGroundingBundlePublisher({ store, runGit });

    // When
    const result = await publisher.publish({
      identity,
      cacheDir: '/cache/apex.git',
      branch: 'main',
    });

    // Then
    expect(result).toBe('exists');
    expect(runGit).not.toHaveBeenCalled();
    expect(store.uploadBundle).not.toHaveBeenCalled();
  });

  it('verifies the branch SHA, creates a safe bundle, and uploads it', async () => {
    // Given
    const store: GroundingBundlePublisherStore = {
      bundleExists: jest.fn().mockResolvedValue(false),
      uploadBundle: jest.fn(async (_identity, bundlePath) => {
        await expect(readFile(bundlePath, 'utf8')).resolves.toBe('bundle');
        return {
          container: 'repo-grounding',
          key: bundleKey(identity),
          sha,
        };
      }),
    };
    const runGit = jest.fn(async (args: string[]) => {
      if (args.includes('rev-parse')) return `${sha}\n`;
      const bundlePath = args[args.indexOf('create') + 1];
      await writeFile(bundlePath, 'bundle');
      return '';
    });
    const publisher = createGroundingBundlePublisher({ store, runGit });

    // When
    const result = await publisher.publish({
      identity,
      cacheDir: '/cache/apex.git',
      branch: 'main',
    });

    // Then
    expect(result).toBe('published');
    expect(runGit.mock.calls[0][0]).toEqual([
      '-c',
      'safe.directory=/cache/apex.git',
      'rev-parse',
      'refs/heads/main',
    ]);
    expect(runGit.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        '-c',
        'safe.directory=/cache/apex.git',
        'bundle',
        'create',
        expect.stringMatching(/snapshot\.bundle$/),
        'refs/heads/main',
      ])
    );
    expect(store.uploadBundle).toHaveBeenCalledWith(
      identity,
      expect.stringMatching(/snapshot\.bundle$/)
    );
    const uploadedPath = (store.uploadBundle as jest.Mock).mock.calls[0][1];
    await expect(stat(uploadedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a cache tip that does not match the content-addressed identity', async () => {
    // Given
    const store: GroundingBundlePublisherStore = {
      bundleExists: jest.fn().mockResolvedValue(false),
      uploadBundle: jest.fn(),
    };
    const runGit = jest.fn().mockResolvedValue(`${'b'.repeat(40)}\n`);
    const publisher = createGroundingBundlePublisher({ store, runGit });

    // When / Then
    await expect(
      publisher.publish({
        identity,
        cacheDir: '/cache/apex.git',
        branch: 'main',
      })
    ).rejects.toThrow('Repository cache SHA changed before bundle publication');
    expect(store.uploadBundle).not.toHaveBeenCalled();
  });
});
