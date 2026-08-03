import type { PreWarmTarget } from '../../shared/types/runGrounding';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import {
  getRepoCacheDir,
  getRepoCacheLeaseKey,
  readCachedOriginSha,
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

const MAX_CHANGED_PATHS = 200;
const PRE_WARM_CONCURRENCY = 2;

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
  listChangedPaths?: (
    options: RepoCacheOptions,
    fromSha: string,
    toSha: string
  ) => Promise<string[]>;
  publishBundle?: GroundingBundlePublisher['publish'];
  enqueueImpact?: typeof groundingImpactEvaluatorService.enqueue;
  telemetry?: typeof trackEvent;
  now?: () => number;
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
      return [{
        provider,
        project: config.project,
        repository: normalizedRepository,
        branch,
      }];
    })
  );
}

async function listDefaultPreWarmTargets(): Promise<PreWarmTarget[]> {
  const [activeResult, configuredResult] = await Promise.allSettled([
    runGroundingRepository.listActiveTargets(),
    listSkillConfigs(),
  ]);
  if (
    activeResult.status === 'rejected'
    && configuredResult.status === 'rejected'
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
    dependencies.listActiveTargets ??
    listDefaultPreWarmTargets;
  const withLease = dependencies.withLease ?? withRepoCacheLease;
  const refreshUnderLease =
    dependencies.refreshUnderLease ?? refreshRepoCacheUnderLease;
  const wasRefreshedSince =
    dependencies.wasRefreshedSince ?? wasRepoCacheRefreshedSince;
  const telemetry = dependencies.telemetry ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const readCachedSha = dependencies.readCachedSha ?? readCachedOriginSha;
  const listChangedPaths =
    dependencies.listChangedPaths ?? listChangedRepositoryPaths;
  const publishBundle =
    dependencies.publishBundle ??
    ((input) => groundingBundlePublisher.publish(input));
  const enqueueImpact =
    dependencies.enqueueImpact ??
    ((event) => groundingImpactEvaluatorService.enqueue(event));
  const inFlight = new Map<string, Promise<void>>();

  const preWarm = (target: PreWarmTarget): Promise<void> => {
    const identity = targetIdentity(target);
    const existing = inFlight.get(identity);
    if (existing) return existing;

    const options = cacheOptions(target);
    const requestedAt = now();
    const previousSha = Promise.resolve(readCachedSha(target)).catch(
      () => null
    );
    const operation = previousSha
      .then(async (fromSha) => {
        let toSha: string | null = null;
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
          toSha = await Promise.resolve(readCachedSha(target)).catch(
            () => null
          );
        });

        if (toSha) {
          try {
            const outcome = await publishBundle({
              identity: {
                provider: options.provider,
                project: target.project,
                repo: target.repository,
                sha: toSha,
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
        }

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
      })
      .finally(() => {
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
      for (let index = 0; index < targets.length; index += PRE_WARM_CONCURRENCY) {
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
