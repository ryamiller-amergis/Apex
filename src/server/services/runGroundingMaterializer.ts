import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { git, safeArgs } from '../utils/asyncGit';
import { resolveDataRoot } from '../utils/dataDir';
import {
  createGroundingBundleStore,
  type GroundingBundleStore,
  type GroundingBundleStoreOptions,
} from './grounding/bundleStoreService';
import {
  groundingBundlePublisher,
  type GroundingBundlePublisher,
} from './grounding/groundingBundlePublisherService';
import {
  ensureRepoCache,
  repairRepoCache,
  resolveGitRemote,
  type RepoCacheResult,
} from './repoCacheService';
import { redactSecrets } from './repoCheckoutService';
import { materializeWorkspaceFromCache } from './repoWorkspaceService';
import {
  ensureGitSafeDirectory,
  WORKTREE_GIT_TIMEOUT_MS,
} from './repoGitSettings';
import {
  sharedReadCheckoutService,
  sharedReadCheckoutIdentityFromGrounding,
} from './grounding/sharedReadCheckoutService';
import { trackEvent } from './telemetry';

type MaterializationState = 'materialized' | 'unavailable';

export interface RunGroundingMaterializationResult {
  state: MaterializationState;
  workspacePath?: string;
}

export interface GroundingMaterializerDependencies {
  dataRoot?: string;
  createBundleStore?: (
    options: GroundingBundleStoreOptions
  ) => Pick<GroundingBundleStore, 'rehydrate'>;
  ensureRepoCache?: typeof ensureRepoCache;
  repairRepoCache?: typeof repairRepoCache;
  resolveGitRemote?: typeof resolveGitRemote;
  materializeWorkspaceFromCache?: typeof materializeWorkspaceFromCache;
  runGit?: typeof git;
  publishBundle?: GroundingBundlePublisher['publish'];
  telemetry?: typeof trackEvent;
  exactCommitFetch?: (
    cache: Pick<RepoCacheResult, 'cacheDir' | 'remote'>,
    sha: string,
    timeoutMs: number,
  ) => Promise<void>;
  now?: () => number;
  /**
   * When true for the grounding project, skip Blob rehydrate/publish and
   * materialize from the local mirror only (Deployment B enabled path).
   */
  isCheckoutReadinessEnabled?: (project: string) => Promise<boolean>;
  /**
   * Absolute path to a completed, local shared read checkout already pinned at
   * the grounding's exact SHA (materialized earlier by the interview turn), or
   * null when none exists. The readiness path reuses this local tree instead of
   * cold-cloning during generation.
   */
  getReadySharedCheckoutPath?: (grounding: RunGrounding) => string | null;
  /** Azure Files dubious-ownership guard; injectable for unit tests. */
  ensureGitSafeDirectory?: () => Promise<void>;
}

export const EXACT_COMMIT_FETCH_TIMEOUT_MS = 45_000;

function cacheProvider(provider: RunGrounding['provider']): SkillProvider {
  return provider === 'azure_devops' ? 'ado' : 'github';
}

function opaqueDestination(
  dataRoot: string,
  grounding: RunGrounding,
  destinationRun: RunRef
): string {
  const identity = JSON.stringify([
    destinationRun.runType,
    destinationRun.runId,
    destinationRun.project,
    grounding.repoRole,
    grounding.provider,
    grounding.repository,
    grounding.branch,
    grounding.groundedSha,
  ]);
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  // AI-run compute mounts <dataRoot>/workspaces from the shared Azure Files
  // volume. Keep pinned grounding checkouts below that mount so App Service,
  // background workers, and the interactive actor resolve the same path.
  return path.join(dataRoot, 'workspaces', 'grounding', digest);
}

/**
 * Returns the opaque destination for a run grounding on the shared AI-run
 * workspace mount. The path is never transported to clients; callers receive
 * it only as Agent.local.cwd.
 */
export function resolveRunGroundingWorkspacePath(
  grounding: RunGrounding,
  destinationRun: RunRef,
  dataRoot = resolveDataRoot()
): string {
  return opaqueDestination(dataRoot, grounding, destinationRun);
}

export function createRunGroundingMaterializer(
  dependencies: GroundingMaterializerDependencies = {}
): (
  grounding: RunGrounding,
  destinationRun: RunRef
) => Promise<MaterializationState> {
  const dataRoot = dependencies.dataRoot ?? resolveDataRoot();
  const ensureCache = dependencies.ensureRepoCache ?? ensureRepoCache;
  const repairCache = dependencies.repairRepoCache ?? repairRepoCache;
  const resolveRemote = dependencies.resolveGitRemote ?? resolveGitRemote;
  const materializeFromCache =
    dependencies.materializeWorkspaceFromCache ?? materializeWorkspaceFromCache;
  const runGit = dependencies.runGit ?? git;
  const telemetry = dependencies.telemetry ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const safeTelemetry: typeof trackEvent = (name, properties, measurements) => {
    try {
      telemetry(name, properties, measurements);
    } catch {
      // Application Insights is best effort and cannot fail grounding.
    }
  };
  const exactCommitFetch =
    dependencies.exactCommitFetch ??
    (async (
      cache: Pick<RepoCacheResult, 'cacheDir' | 'remote'>,
      sha: string,
      timeoutMs: number,
    ): Promise<void> => {
      await runGit(
        safeArgs(cache.cacheDir, [
          'fetch',
          '--no-tags',
          cache.remote.url,
          sha,
        ]),
        {
          cwd: cache.cacheDir,
          timeout: timeoutMs,
          env: cache.remote.env,
        },
      );
    });
  const branchesByDestination = new Map<string, string>();
  const materializations = new Map<string, Promise<MaterializationState>>();
  const createBundleStore =
    dependencies.createBundleStore ?? createGroundingBundleStore;
  const rawPublishBundle =
    dependencies.publishBundle ??
    ((input) => groundingBundlePublisher.publish(input));
  const isCheckoutReadinessEnabled =
    dependencies.isCheckoutReadinessEnabled ??
    (async (project: string) => {
      const { isProjectRepositoryCheckoutReadinessEnabledForProject } =
        await import('./featureFlagService');
      return isProjectRepositoryCheckoutReadinessEnabledForProject(project);
    });
  const getReadySharedCheckoutPath =
    dependencies.getReadySharedCheckoutPath ??
    ((grounding: RunGrounding) =>
      sharedReadCheckoutService.getReady(
        sharedReadCheckoutIdentityFromGrounding(grounding),
      )?.workspacePath ?? null);
  const ensureSafeDirectory =
    dependencies.ensureGitSafeDirectory ?? ensureGitSafeDirectory;
  const publishBundle: GroundingBundlePublisher['publish'] = async (input) => {
    // @feature-flag:project-repository-checkout-readiness start winner=enabled
    let checkoutReadinessEnabled = false;
    try {
      checkoutReadinessEnabled = await isCheckoutReadinessEnabled(
        input.identity.project,
      );
    } catch {
      checkoutReadinessEnabled = false;
    }
    if (checkoutReadinessEnabled) {
      // @feature-flag:project-repository-checkout-readiness enabled-start
      return 'exists';
      // @feature-flag:project-repository-checkout-readiness enabled-end
    }
    // @feature-flag:project-repository-checkout-readiness end
    return rawPublishBundle(input);
  };
  const store = createBundleStore({
    repairAndMaterialize: async ({ identity, destination }) => {
      const branch = branchesByDestination.get(destination);
      if (!branch) return false;
      const cacheOptions = {
        provider: identity.provider,
        project: identity.project,
        repo: identity.repo,
        branch,
      } as const;
      const materializePinnedSha = async (
        cache: Pick<RepoCacheResult, 'cacheDir' | 'remote'>
      ): Promise<void> => {
        await materializeFromCache(
          cache.cacheDir,
          destination,
          branch,
          cache.remote.url
        );
        await runGit(
          safeArgs(destination, ['checkout', '--detach', identity.sha]),
          { cwd: destination }
        );
      };
      const publishFromCache = (
        cache: Pick<RepoCacheResult, 'cacheDir'>
      ): void => {
        void Promise.resolve()
          .then(() =>
            publishBundle({
              identity,
              cacheDir: cache.cacheDir,
              branch,
            })
          )
          .then((outcome) => {
            safeTelemetry('grounding.bundle.publish', {
              provider: String(identity.provider),
              project: identity.project,
              repository: redactSecrets(identity.repo),
              branch,
              outcome,
            });
          })
          .catch(() => {
            safeTelemetry('grounding.bundle.publish', {
              provider: String(identity.provider),
              project: identity.project,
              repository: redactSecrets(identity.repo),
              branch,
              outcome: 'failed',
            });
          });
      };

      const cache = await ensureCache(cacheOptions);
      try {
        await materializePinnedSha(cache);
        publishFromCache(cache);
        return true;
      } catch {
        const exactFetchStartedAt = now();
        try {
          await exactCommitFetch(
            cache,
            identity.sha,
            EXACT_COMMIT_FETCH_TIMEOUT_MS,
          );
          await materializePinnedSha(cache);
          safeTelemetry('grounding.materialization.exact-fetch', {
            provider: String(identity.provider),
            project: identity.project,
            repository: redactSecrets(identity.repo),
            branch,
            reason: 'pinned-sha-miss',
            outcome: 'materialized',
          }, {
            durationMs: Math.max(0, now() - exactFetchStartedAt),
          });
          publishFromCache(cache);
          return true;
        } catch {
          safeTelemetry('grounding.materialization.fallback', {
            provider: String(identity.provider),
            project: identity.project,
            repository: redactSecrets(identity.repo),
            branch,
            reason: 'pinned-sha-unavailable',
            outcome: 'unavailable',
          }, {
            durationMs: Math.max(0, now() - exactFetchStartedAt),
          });
        }
        try {
          const repairedCache = await repairCache(cacheOptions);
          await materializePinnedSha(repairedCache);
          publishFromCache(repairedCache);
          return true;
        } catch {
          return false;
        }
      }
    },
  });

  const materializeLocalOnly = async (
    grounding: RunGrounding,
    destination: string,
  ): Promise<MaterializationState> => {
    const branch = grounding.branch;
    const identity = {
      provider: cacheProvider(grounding.provider),
      project: grounding.project,
      repo: grounding.repository,
      sha: grounding.groundedSha,
    };
    const cacheOptions = {
      provider: identity.provider,
      project: identity.project,
      repo: identity.repo,
      branch,
    } as const;
    const materializePinnedSha = async (
      cache: Pick<RepoCacheResult, 'cacheDir' | 'remote'>,
    ): Promise<void> => {
      await materializeFromCache(
        cache.cacheDir,
        destination,
        branch,
        cache.remote.url,
      );
      await runGit(
        safeArgs(destination, ['checkout', '--detach', identity.sha]),
        { cwd: destination },
      );
    };

    // FIRST: reuse the exact SHA the interview already materialized on the
    // shared Azure Files volume. Do NOT call ensureRepoCache first — a MaxView
    // mirror refresh can hang for minutes and would block this fast path.
    // Generation must not wait on a mirror worktree clone (COLD_CACHE_TIMEOUT_MS
    // up to 30 minutes) when the shared read checkout is already a warm hit.
    const seedFromLocalSharedCheckout = async (
      remoteUrl: string,
    ): Promise<boolean> => {
      const sharedPath = getReadySharedCheckoutPath(grounding);
      if (!sharedPath) return false;
      await ensureSafeDirectory();
      fs.rmSync(destination, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await runGit(
        safeArgs(sharedPath, [
          '-c',
          'core.longpaths=true',
          'clone',
          '--no-hardlinks',
          '--local',
          sharedPath,
          destination,
        ]),
        {
          cwd: path.dirname(destination),
          timeout: WORKTREE_GIT_TIMEOUT_MS,
        },
      );
      await runGit(
        safeArgs(destination, ['checkout', '--detach', identity.sha]),
        { cwd: destination, timeout: WORKTREE_GIT_TIMEOUT_MS },
      );
      await runGit(
        safeArgs(destination, ['remote', 'set-url', 'origin', remoteUrl]),
        { cwd: destination },
      );
      return true;
    };

    const reuseStartedAt = now();
    try {
      const remote = resolveRemote(
        identity.provider,
        identity.project,
        identity.repo,
      );
      if (await seedFromLocalSharedCheckout(remote.url)) {
        safeTelemetry(
          'grounding.materialization.local-reuse',
          {
            provider: String(identity.provider),
            project: identity.project,
            repository: redactSecrets(identity.repo),
            branch,
            source: 'shared-read-checkout',
            outcome: 'materialized',
          },
          { durationMs: Math.max(0, now() - reuseStartedAt) },
        );
        return 'materialized';
      }
    } catch {
      // Shared-tree seed failed (or remote resolve failed); fall through.
    }

    // SECOND: warm bare-mirror worktree. Still no cold repair/network fetch —
    // if this fails, return unavailable so the router falls back in-process.
    const cache = await ensureCache(cacheOptions);
    try {
      await materializePinnedSha(cache);
      return 'materialized';
    } catch {
      safeTelemetry(
        'grounding.materialization.fallback',
        {
          provider: String(identity.provider),
          project: identity.project,
          repository: redactSecrets(identity.repo),
          branch,
          reason: 'pinned-sha-unavailable',
          outcome: 'unavailable',
        },
        { durationMs: Math.max(0, now() - reuseStartedAt) },
      );
      return 'unavailable';
    }
  };

  return async (grounding, destinationRun) => {
    const destination = opaqueDestination(dataRoot, grounding, destinationRun);
    const existing = materializations.get(destination);
    if (existing) return existing;

    const pending = (async (): Promise<MaterializationState> => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      branchesByDestination.set(destination, grounding.branch);
      try {
        // @feature-flag:project-repository-checkout-readiness start winner=enabled
        let checkoutReadinessEnabled = false;
        try {
          checkoutReadinessEnabled = await isCheckoutReadinessEnabled(
            grounding.project,
          );
        } catch {
          checkoutReadinessEnabled = false;
        }
        if (checkoutReadinessEnabled) {
          // @feature-flag:project-repository-checkout-readiness enabled-start
          // No Blob rehydrate / publish — materialize from local mirror only.
          return materializeLocalOnly(grounding, destination);
          // @feature-flag:project-repository-checkout-readiness enabled-end
        }
        // @feature-flag:project-repository-checkout-readiness end

        const result = await store.rehydrate(
          {
            provider: cacheProvider(grounding.provider),
            project: grounding.project,
            repo: grounding.repository,
            sha: grounding.groundedSha,
          },
          destination
        );
        return result.status === 'materialized' ? 'materialized' : 'unavailable';
      } catch {
        return 'unavailable';
      } finally {
        branchesByDestination.delete(destination);
      }
    })();
    materializations.set(destination, pending);
    try {
      return await pending;
    } finally {
      if (materializations.get(destination) === pending) {
        materializations.delete(destination);
      }
    }
  };
}

export const materializeRunGrounding = createRunGroundingMaterializer();

export async function materializeRunGroundingWithPath(
  grounding: RunGrounding,
  destinationRun: RunRef
): Promise<RunGroundingMaterializationResult> {
  const state = await materializeRunGrounding(grounding, destinationRun);
  return state === 'materialized'
    ? {
        state,
        workspacePath: resolveRunGroundingWorkspacePath(
          grounding,
          destinationRun
        ),
      }
    : { state };
}
