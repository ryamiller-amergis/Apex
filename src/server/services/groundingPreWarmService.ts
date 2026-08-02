import type { PreWarmTarget } from '../../shared/types/runGrounding';
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
import { groundingImpactEvaluatorService } from './groundingImpactEvaluatorService';
import { trackEvent } from './telemetry';
import { git, safeArgs } from '../utils/asyncGit';

const MAX_CHANGED_PATHS = 200;

export interface GroundingPreWarmService {
  preWarm(target: PreWarmTarget): Promise<void>;
  sweep(): Promise<void>;
}

export interface GroundingPreWarmDependencies {
  listActiveTargets?: () => Promise<PreWarmTarget[]>;
  withLease?: (
    cacheKey: string,
    operation: (lease: RepoCacheLeaseContext) => Promise<void>,
  ) => Promise<void>;
  refreshUnderLease?: (
    options: RepoCacheOptions,
    lease: RepoCacheLeaseContext,
  ) => Promise<unknown>;
  wasRefreshedSince?: (
    options: RepoCacheOptions,
    sinceMs: number,
  ) => boolean;
  readCachedSha?: (target: PreWarmTarget) => Promise<string | null>;
  listChangedPaths?: (
    options: RepoCacheOptions,
    fromSha: string,
    toSha: string,
  ) => Promise<string[]>;
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
      }),
    ),
  ].slice(0, MAX_CHANGED_PATHS);
}

async function listChangedRepositoryPaths(
  options: RepoCacheOptions,
  fromSha: string,
  toSha: string,
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
    },
  );
  return output.split(/\r?\n/).filter(Boolean);
}

export function createGroundingPreWarmService(
  dependencies: GroundingPreWarmDependencies = {},
): GroundingPreWarmService {
  const listActiveTargets =
    dependencies.listActiveTargets ??
    (() => runGroundingRepository.listActiveTargets());
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
      () => null,
    );
    const operation = previousSha
      .then((fromSha) =>
        withLease(getRepoCacheLeaseKey(options), async (lease) => {
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
            { durationMs: Math.max(0, now() - requestedAt) },
          );

          void Promise.resolve()
            .then(async () => {
              if (!fromSha) return;
              const toSha = await readCachedSha(target);
              if (!toSha || toSha === fromSha) return;
              const changedFiles = safeChangedPaths(
                await listChangedPaths(options, fromSha, toSha),
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
        }),
      )
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
      await Promise.all(targets.map((target) => preWarm(target)));
    },
  };
}

export const groundingPreWarmService = createGroundingPreWarmService();
