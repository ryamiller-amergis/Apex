import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RepositoryIdentity } from '../../../shared/types/grounding';
import { git, safeArgs } from '../../utils/asyncGit';
import {
  COLD_CACHE_IDLE_TIMEOUT_MS,
  COLD_CACHE_TIMEOUT_MS,
} from '../repoGitSettings';
import {
  createGroundingBundleStore,
  type GroundingBundleStore,
} from './bundleStoreService';

export type GroundingBundlePublisherStore = Pick<
  GroundingBundleStore,
  'bundleExists' | 'uploadBundle'
>;

export interface GroundingBundlePublishInput {
  identity: RepositoryIdentity;
  cacheDir: string;
  branch: string;
}

export interface GroundingBundlePublisher {
  publish(input: GroundingBundlePublishInput): Promise<'exists' | 'published'>;
}

export interface GroundingBundlePublisherDependencies {
  store?: GroundingBundlePublisherStore;
  runGit?: typeof git;
}

export function createGroundingBundlePublisher(
  dependencies: GroundingBundlePublisherDependencies = {}
): GroundingBundlePublisher {
  const store =
    dependencies.store ??
    createGroundingBundleStore({
      repairAndMaterialize: async () => false,
    });
  const runGit = dependencies.runGit ?? git;

  return {
    async publish(input) {
      if (await store.bundleExists(input.identity)) return 'exists';

      const branchRef = `refs/heads/${input.branch}`;
      const cacheSha = (
        await runGit(safeArgs(input.cacheDir, ['rev-parse', branchRef]), {
          cwd: input.cacheDir,
        })
      )
        .trim()
        .toLowerCase();
      if (cacheSha !== input.identity.sha.trim().toLowerCase()) {
        throw new Error(
          'Repository cache SHA changed before bundle publication'
        );
      }

      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), 'apex-grounding-publish-')
      );
      const temporaryBundlePath = join(temporaryDirectory, 'snapshot.bundle');

      try {
        await runGit(
          safeArgs(input.cacheDir, [
            'bundle',
            'create',
            temporaryBundlePath,
            branchRef,
          ]),
          {
            cwd: input.cacheDir,
            timeout: COLD_CACHE_TIMEOUT_MS,
            idleTimeout: COLD_CACHE_IDLE_TIMEOUT_MS,
          }
        );
        await store.uploadBundle(input.identity, temporaryBundlePath);
        return 'published';
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined
        );
      }
    },
  };
}

export const groundingBundlePublisher = createGroundingBundlePublisher();
