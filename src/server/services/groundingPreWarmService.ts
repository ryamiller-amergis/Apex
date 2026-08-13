import type { PreWarmTarget } from '../../shared/types/runGrounding';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import {
  getRepoCacheDir,
  getRepoCacheLeaseKey,
  readCachedOriginSha,
  readRemoteBranchTip,
  refreshRepoCacheUnderLease,
  wasRepoCacheRefreshedSince,
  type RepoCacheOptions,
} from './repoCacheService';
import {
  withRepoCacheLease,
  type RepoCacheLeaseContext,
} from './repoCacheLeaseService';
import { runGroundingRepository } from './runGroundingRepository';
import { listSkillConfigs } from './projectSettingsService';
import { groundingImpactEvaluatorService } from './groundingImpactEvaluatorService';
import { trackEvent } from './telemetry';
import { git, safeArgs } from '../utils/asyncGit';
import {
  groundingBundlePublisher,
  type GroundingBundlePublisher,
} from './grounding/groundingBundlePublisherService';
import {
  sharedReadCheckoutService,
  type SharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
import { workerCanReadWithoutWorkingTree } from './repoRead/workerReadVisibility';

const MAX_CHANGED_PATHS = 200;
const PRE_WARM_CONCURRENCY = 2;
/** Idle configured repos are probed at most this often. Active pins probe every sweep. */
export const IDLE_REMOTE_PROBE_INTERVAL_MS = 30 * 60 * 1000;

export interface GroundingPreWarmService {
  preWarm(target: PreWarmTarget): Promise<void>;
  sweep(): Promise<void>;
}

export interface GroundingPreWarmDependencies {
  listActiveTargets?: () => Promise<PreWarmTarget[]>;
  withLease?: (
    cacheKey: string,
    operation: (lease: RepoCacheLeaseContext) => Promise<void>
  ) => Promise<void>;
  refreshUnderLease?: (
    options: RepoCacheOptions,
    lease: RepoCacheLeaseContext
  ) => Promise<unknown>;
  wasRefreshedSince?: (options: RepoCacheOptions, sinceMs: number) => boolean;
  readCachedSha?: (target: PreWarmTarget) => Promise<string | null>;
  readRemoteTip?: (options: RepoCacheOptions) => Promise<string | null>;
  listPinnedTargets?: () => Promise<PreWarmTarget[]>;
  listChangedPaths?: (
    options: RepoCacheOptions,
    fromSha: string,
    toSha: string
  ) => Promise<string[]>;
  publishBundle?: GroundingBundlePublisher['publish'];
  materializeSharedCheckout?: SharedReadCheckoutService['materialize'];
  enqueueImpact?: typeof groundingImpactEvaluatorService.enqueue;
  telemetry?: typeof trackEvent;
  now?: () => number;
  /**
   * When true for the target project, preWarm is a no-op (Deployment B enabled
   * path — admin clone owns mirrors; no Blob publish / shared prewarm).
   */
  isCheckoutReadinessEnabled?: (project: string) => Promise<boolean>;
  /**
   * True when workers can native-read without a working tree (same disk or
   * HTTP). Shared checkout prewarm is then skipped; Blob publish still runs.
   */
  workerCanReadWithoutWorkingTree?: () => boolean;
}

function cacheOptions(target: PreWarmTarget): RepoCacheOptions {
  return {
    provider: target.provider === 'azure_devops' ? 'ado' : 'github',
    project: target.project,
    repo: target.repository,
    branch: target.branch,
  };
}

function targetIdentity(target: PreWarmTarget): string {
  return [
    target.provider,
    target.project,
    target.repository,
    target.branch,
  ].join('\0');
}

function uniqueTargets(targets: PreWarmTarget[]): PreWarmTarget[] {
  return [
    ...new Map(
      targets.map((target) => [targetIdentity(target), target])
    ).values(),
  ];
}

export function configuredPreWarmTargets(
  configs: ProjectSkillConfig[]
): PreWarmTarget[] {
  return uniqueTargets(
    configs.flatMap((config) => {
      const repository = config.skillRepo.trim();
      const branch = config.skillBranch.trim();
      if (!config.project.trim() || !repository || !branch) return [];

      const provider =
        config.skillProvider === 'github' ? 'github' : 'azure_devops';
      const normalizedRepository =
        provider === 'github'
          ? repository.split('/').pop() || repository
          : repository;
      return [
        {
          provider,
          project: config.project,
          repository: normalizedRepository,
          branch,
        },
      ];
    })
  );
}

async function listDefaultPreWarmTargets(): Promise<PreWarmTarget[]> {
  const [activeResult, configuredResult] = await Promise.allSettled([
    runGroundingRepository.listActiveTargets(),
    listSkillConfigs(),
  ]);
  if (
    activeResult.status === 'rejected' &&
    configuredResult.status === 'rejected'
  ) {
    throw activeResult.reason;
  }

  return uniqueTargets([
    ...(activeResult.status === 'fulfilled' ? activeResult.value : []),
    ...(configuredResult.status === 'fulfilled'
      ? configuredPreWarmTargets(configuredResult.value)
      : []),
  ]);
}

function safeChangedPaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths.flatMap((candidate) => {
        const value = candidate.trim().replace(/\\/g, '/');
        if (
          !value ||
          value.startsWith('/') ||
          /^[a-z]:\//i.test(value) ||
          value.includes('\0')
        ) {
          return [];
        }
        const normalized = value.replace(/^\.\//, '');
        return normalized.split('/').includes('..') ? [] : [normalized];
      })
    ),
  ].slice(0, MAX_CHANGED_PATHS);
}

async function listChangedRepositoryPaths(
  options: RepoCacheOptions,
  fromSha: string,
  toSha: string
): Promise<string[]> {
  const cacheDir = getRepoCacheDir(options);
  const output = await git(
    safeArgs(cacheDir, [
      'diff',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      fromSha,
      toSha,
      '--',
    ]),
    {
      cwd: cacheDir,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    }
  );
  return output.split(/\r?\n/).filter(Boolean);
}

export function createGroundingPreWarmService(
  dependencies: GroundingPreWarmDependencies = {}
): GroundingPreWarmService {
  const listActiveTargets =
    dependencies.listActiveTargets ?? listDefaultPreWarmTargets;
  const withLease = dependencies.withLease ?? withRepoCacheLease;
  const refreshUnderLease =
    dependencies.refreshUnderLease ?? refreshRepoCacheUnderLease;
  const wasRefreshedSince =
    dependencies.wasRefreshedSince ?? wasRepoCacheRefreshedSince;
  const telemetry = dependencies.telemetry ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const readCachedSha = dependencies.readCachedSha ?? readCachedOriginSha;
  const readRemoteTip = dependencies.readRemoteTip ?? readRemoteBranchTip;
  const listPinnedTargets =
    dependencies.listPinnedTargets ??
    (() => runGroundingRepository.listActiveTargets());
  const listChangedPaths =
    dependencies.listChangedPaths ?? listChangedRepositoryPaths;
  const publishBundle =
    dependencies.publishBundle ??
    ((input) => groundingBundlePublisher.publish(input));
  const materializeSharedCheckout =
    dependencies.materializeSharedCheckout ??
    ((identity) => sharedReadCheckoutService.materialize(identity));
  const enqueueImpact =
    dependencies.enqueueImpact ??
    ((event) => groundingImpactEvaluatorService.enqueue(event));
  const isCheckoutReadinessEnabled =
    dependencies.isCheckoutReadinessEnabled ??
    (async (project: string) => {
      // Lazy import avoids pulling featureFlagService into every Jest graph that
      // only exercises injected prewarm dependencies.
      const { isProjectRepositoryCheckoutReadinessEnabledForProject } =
        await import('./featureFlagService');
      return isProjectRepositoryCheckoutReadinessEnabledForProject(project);
    });
  const canSkipSharedCheckout =
    dependencies.workerCanReadWithoutWorkingTree
    ?? (() => workerCanReadWithoutWorkingTree());
  const inFlight = new Map<string, Promise<void>>();
  const lastProbeAt = new Map<string, number>();

  const isActivelyPinned = async (target: PreWarmTarget): Promise<boolean> => {
    try {
      const pinned = await listPinnedTargets();
      const identity = targetIdentity(target);
      return pinned.some((candidate) => targetIdentity(candidate) === identity);
    } catch {
      return true;
    }
  };

  const shouldDeferIdleProbe = async (
    target: PreWarmTarget,
  ): Promise<boolean> => {
    if (await isActivelyPinned(target)) return false;
    const last = lastProbeAt.get(targetIdentity(target));
    if (last === undefined) return false;
    return now() - last < IDLE_REMOTE_PROBE_INTERVAL_MS;
  };

  const preWarm = (target: PreWarmTarget): Promise<void> => {
    const identity = targetIdentity(target);
    const existing = inFlight.get(identity);
    if (existing) return existing;

    const operation = (async () => {
      // @feature-flag:project-repository-checkout-readiness start winner=enabled
      let checkoutReadinessEnabled = false;
      try {
        checkoutReadinessEnabled = await isCheckoutReadinessEnabled(
          target.project,
        );
      } catch {
        checkoutReadinessEnabled = false;
      }
      if (checkoutReadinessEnabled) {
        // @feature-flag:project-repository-checkout-readiness enabled-start
        // Admin-managed checkouts: no mirror refresh / Blob publish / shared prewarm.
        return;
        // @feature-flag:project-repository-checkout-readiness enabled-end
      }
      // @feature-flag:project-repository-checkout-readiness end

      if (await shouldDeferIdleProbe(target)) {
        telemetry(
          'grounding.mirror.prewarm',
          {
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            outcome: 'deferred',
          },
          { durationMs: 0 },
        );
        return;
      }

      const options = cacheOptions(target);
      const requestedAt = now();
      const fromSha = await Promise.resolve(readCachedSha(target)).catch(
        () => null,
      );
      const cachedTip = fromSha?.trim().toLowerCase() || null;
      let remoteTip: string | null = null;
      try {
        remoteTip = (await readRemoteTip(options))?.trim().toLowerCase() || null;
      } catch {
        remoteTip = null;
      }
      if (cachedTip && remoteTip && remoteTip === cachedTip) {
        lastProbeAt.set(identity, now());
        telemetry(
          'grounding.mirror.prewarm',
          {
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            outcome: 'unchanged',
          },
          { durationMs: Math.max(0, now() - requestedAt) },
        );
        return;
      }

      const refreshed = { sha: null as string | null };
      await withLease(getRepoCacheLeaseKey(options), async (lease) => {
        lease.signal.throwIfAborted();
        const coalesced = wasRefreshedSince(options, requestedAt);
        if (!coalesced) {
          await refreshUnderLease(options, lease);
        }
        lease.signal.throwIfAborted();
        telemetry(
          'grounding.mirror.prewarm',
          {
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            outcome: coalesced ? 'coalesced' : 'refreshed',
          },
          { durationMs: Math.max(0, now() - requestedAt) }
        );
        refreshed.sha = await Promise.resolve(readCachedSha(target)).catch(
          () => null
        );
      });

      const cachedSha = refreshed.sha?.trim();
      const toSha = cachedSha || null;
      if (cachedSha) {
        try {
          const outcome = await publishBundle({
            identity: {
              provider: options.provider,
              project: target.project,
              repo: target.repository,
              sha: cachedSha,
            },
            cacheDir: getRepoCacheDir(options),
            branch: target.branch,
          });
          telemetry('grounding.bundle.publish', {
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            outcome,
          });
        } catch {
          telemetry('grounding.bundle.publish', {
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            outcome: 'failed',
          });
        }

        try {
          if (canSkipSharedCheckout()) {
            telemetry('grounding.shared.prewarm', {
              provider: target.provider,
              project: target.project,
              repository: target.repository,
              branch: target.branch,
              sha: cachedSha,
              outcome: 'skipped-bare-mirror',
            });
          } else {
            const { outcome } = await materializeSharedCheckout({
              provider: options.provider,
              project: target.project,
              repo: target.repository,
              branch: target.branch,
              sha: cachedSha,
            });
            telemetry('grounding.shared.prewarm', {
              provider: target.provider,
              project: target.project,
              repository: target.repository,
              branch: target.branch,
              sha: cachedSha,
              outcome,
            });
          }
        } catch {
          telemetry('grounding.shared.prewarm', {
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            sha: cachedSha,
            outcome: 'failed',
          });
          // Shared checkout prewarming is only an acceleration. The
          // user-facing preparation path owns on-demand materialization.
        }
      }

      lastProbeAt.set(identity, now());

      void Promise.resolve()
        .then(async () => {
          if (!fromSha || !toSha || toSha === fromSha) return;
          const changedFiles = safeChangedPaths(
            await listChangedPaths(options, fromSha, toSha)
          );
          if (changedFiles.length === 0) return;
          enqueueImpact({
            provider: target.provider,
            project: target.project,
            repository: target.repository,
            branch: target.branch,
            fromSha,
            toSha,
            changedFiles,
          });
        })
        .catch(() => undefined);
    })().finally(() => {
      inFlight.delete(identity);
    });
    inFlight.set(identity, operation);
    return operation;
  };

  return {
    preWarm,
    async sweep() {
      const targets = await listActiveTargets();
      let firstError: unknown;
      for (
        let index = 0;
        index < targets.length;
        index += PRE_WARM_CONCURRENCY
      ) {
        const results = await Promise.allSettled(
          targets
            .slice(index, index + PRE_WARM_CONCURRENCY)
            .map((target) => preWarm(target))
        );
        firstError ??= results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected'
        )?.reason;
      }
      if (firstError) throw firstError;
    },
  };
}

export const groundingPreWarmService = createGroundingPreWarmService();
