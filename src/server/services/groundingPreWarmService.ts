import type { PreWarmTarget } from '../../shared/types/runGrounding';
import {
  getRepoCacheLeaseKey,
  refreshRepoCacheUnderLease,
  wasRepoCacheRefreshedSince,
  type RepoCacheOptions,
} from './repoCacheService';
import {
  withRepoCacheLease,
  type RepoCacheLeaseContext,
} from './repoCacheLeaseService';
import { runGroundingRepository } from './runGroundingRepository';
import { trackEvent } from './telemetry';

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
  const inFlight = new Map<string, Promise<void>>();

  const preWarm = (target: PreWarmTarget): Promise<void> => {
    const identity = targetIdentity(target);
    const existing = inFlight.get(identity);
    if (existing) return existing;

    const options = cacheOptions(target);
    const requestedAt = now();
    const operation = withLease(
      getRepoCacheLeaseKey(options),
      async (lease) => {
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
      },
    ).finally(() => {
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
