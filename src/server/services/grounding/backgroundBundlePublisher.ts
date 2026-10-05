/**
 * Publishes a grounding bundle out of band so the repo-read service has an
 * object database to restore onto a cold container's ephemeral disk.
 *
 * `git bundle create` against a large mirror takes minutes, so this must never
 * join a caller's turn — that is the cold-start stall bare mirrors removed.
 * Failure is silent by design: without a bundle the read service simply clones
 * the remote instead.
 */
import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import { isFeatureEnabled } from '../featureFlagService';
import {
  groundingBundlePublisher,
  type GroundingBundlePublisher,
} from './groundingBundlePublisherService';

const REPO_READ_SERVICE_FLAG = 'repo-read-service';

export interface BackgroundBundlePublishInput {
  identity: RepositoryIdentity;
  cacheDir: string;
  branch: string;
  userId: string;
}

export interface BackgroundBundlePublisherDependencies {
  publisher?: GroundingBundlePublisher;
  isEnabled?: typeof isFeatureEnabled;
  log?: (message: string) => void;
}

export interface BackgroundBundlePublisher {
  /**
   * Resolves once the attempt settles. Callers fire and forget; tests await.
   */
  publish(input: BackgroundBundlePublishInput): Promise<void>;
}

export function createBackgroundBundlePublisher(
  dependencies: BackgroundBundlePublisherDependencies = {}
): BackgroundBundlePublisher {
  const publisher = dependencies.publisher ?? groundingBundlePublisher;
  const isEnabled = dependencies.isEnabled ?? isFeatureEnabled;
  const log =
    dependencies.log ?? ((message: string) => console.warn(message));
  const inFlight = new Set<string>();

  return {
    publish(input) {
      const { identity } = input;
      const key = [
        identity.provider,
        identity.project,
        identity.repo,
        identity.sha,
      ].join('/');
      // One bundle build per SHA per process; the store also skips uploads
      // for a key that already exists.
      if (inFlight.has(key)) return Promise.resolve();
      inFlight.add(key);

      return (async () => {
        try {
          const enabled = await isEnabled(REPO_READ_SERVICE_FLAG, {
            userId: input.userId,
            project: identity.project,
          });
          if (!enabled) return;
          await publisher.publish({
            identity,
            cacheDir: input.cacheDir,
            branch: input.branch,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          log(`[grounding] bundle publish failed for ${key}: ${message}`);
        } finally {
          inFlight.delete(key);
        }
      })();
    },
  };
}

export const backgroundBundlePublisher = createBackgroundBundlePublisher();
