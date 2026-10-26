import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RunGrounding } from '../../shared/types/runGrounding';
import { resolveDataRoot } from '../utils/dataDir';
import {
  withRepoCacheLease,
  type RepoCacheLeaseContext,
} from './repoCacheLeaseService';
import {
  COLD_CACHE_TIMEOUT_MS,
  REPO_CACHE_MIN_FREE_BYTES,
  compactRepoCache,
  getRepoCacheDir,
  getRepoCacheLeaseKey,
  readRepoCacheFreeBytes,
  readRepoCacheIdentity,
  readRepoCacheLastUsed,
  readRepoCachePackStats,
  type RepoCacheCompactionResult,
  type RepoCacheIdentity,
  type RepoCacheOptions,
  type RepoCachePackStats,
} from './repoCacheService';
import { runGroundingRepository } from './runGroundingRepository';
import { trackEvent } from './telemetry';

/**
 * Bare mirrors are only eviction candidates once they have gone unused for
 * this long, so a sweep can never delete objects out from under a checkout
 * that is between git invocations.
 */
export const REPO_CACHE_MIN_IDLE_MS = 30 * 60 * 1000;

/**
 * App Service Basic gives the whole app one 10 GiB share, shared with deploy
 * packages (Kudu keeps two at ~0.7 GiB each) and grounding workspaces, sessions
 * and logs (~0.35 GiB). Holding 1.5 GiB back for the next deploy upload leaves
 * 10 - 1.4 - 0.35 - 1.5, so the cache gets under 6.75 GiB.
 *
 * This is smaller than dev would like: the MaxView mirror alone is ~6.8 GiB, so
 * it and MatterWorx cannot both stay cached, and whichever is least recently
 * used gets re-cloned later. Raising the App Service plan is the fix for that —
 * set REPO_CACHE_MAX_BYTES to match once an environment has a bigger share.
 */
export const DEFAULT_REPO_CACHE_MAX_BYTES = 6.5 * 1024 * 1024 * 1024;

/** A cold clone writes into `<mirror>.tmp-<uuid>`; one killed mid-clone is never renamed or removed. */
const ABANDONED_CLONE_RE = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Git's own `gc.autoPackLimit` default: past this many packs `git gc --auto` would repack. */
export const REPO_CACHE_COMPACT_MAX_PACKS = 50;

/**
 * Compact once total pack bytes exceed this multiple of the largest pack. Each
 * `fetch --refetch` writes a complete copy, so a mirror at 2x holds one full
 * duplicate and anything above it holds more. A mirror fed by incremental
 * fetches stays close to 1x. The production MatterWorx mirror measured about
 * 54 GB against a largest pack near 550 MB, roughly 100x.
 */
export const REPO_CACHE_COMPACT_BYTES_FACTOR = 2;

export function mirrorNeedsCompaction(stats: RepoCachePackStats): boolean {
  if (stats.packCount < 2) return false;
  return (
    stats.packCount > REPO_CACHE_COMPACT_MAX_PACKS
    || stats.packBytes > stats.largestPackBytes * REPO_CACHE_COMPACT_BYTES_FACTOR
  );
}

export interface RepoCacheEvictionResult {
  scanned: number;
  evicted: number;
  protected: number;
  compacted: number;
  compactionBytesReclaimed: number;
  abandonedClonesRemoved: number;
  bytesBefore: number;
  bytesAfter: number;
  maxBytes: number;
  freeBytes: number | null;
}

export interface RepoCacheEvictionService {
  evictOverBudget(): Promise<RepoCacheEvictionResult>;
}

export interface RepoCacheEvictionDependencies {
  dataRoot?: string;
  maxBytes?: number;
  now?: () => number;
  readFreeBytes?: (dir: string) => Promise<number>;
  listActiveGroundings?: () => Promise<RunGrounding[]>;
  withLease?: typeof withRepoCacheLease;
  telemetry?: typeof trackEvent;
  readPackStats?: (cacheDir: string) => RepoCachePackStats;
  compactMirror?: (
    cacheDir: string,
    lease: RepoCacheLeaseContext,
  ) => Promise<RepoCacheCompactionResult>;
}

interface MirrorCandidate {
  name: string;
  dir: string;
  bytes: number;
  lastUsedMs: number;
  identity: RepoCacheIdentity | null;
}

interface ScannedMirror extends MirrorCandidate {
  evictable: boolean;
}

function isLeaseBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith('Timed out waiting for repository cache lease:')
  );
}

function resolveMaxBytes(explicit?: number): number {
  if (typeof explicit === 'number') return explicit;
  const configured = Number(process.env.REPO_CACHE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_REPO_CACHE_MAX_BYTES;
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await directoryBytes(child);
      } else if (entry.isFile()) {
        total += (await fsp.stat(child)).size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return total;
}

async function mirrorLastUsedMs(dir: string): Promise<number> {
  return readRepoCacheLastUsed(dir) ?? (await fsp.stat(dir)).mtimeMs;
}

function groundingCacheOptions(grounding: RunGrounding): RepoCacheOptions {
  return {
    provider: grounding.provider === 'azure_devops' ? 'ado' : 'github',
    project: grounding.project,
    repo: grounding.repository,
    branch: grounding.branch,
  };
}

export function createRepoCacheEvictionService(
  dependencies: RepoCacheEvictionDependencies = {},
): RepoCacheEvictionService {
  const dataRoot = dependencies.dataRoot ?? resolveDataRoot();
  const now = dependencies.now ?? Date.now;
  const listActiveGroundings =
    dependencies.listActiveGroundings ??
    (() => runGroundingRepository.listActiveGroundings());
  const withLease = dependencies.withLease ?? withRepoCacheLease;
  const telemetry = dependencies.telemetry ?? trackEvent;
  const readFreeBytes = dependencies.readFreeBytes ?? readRepoCacheFreeBytes;
  const readPackStats = dependencies.readPackStats ?? readRepoCachePackStats;
  const compactMirror =
    dependencies.compactMirror ??
    ((cacheDir: string, lease: RepoCacheLeaseContext) =>
      compactRepoCache(cacheDir, {
        abortSignal: lease.signal,
        assertOwned: lease.assertOwned,
        reason: 'oversized',
      }));
  const cacheRoot = path.join(dataRoot, 'repo-cache');

  const isIdle = async (dir: string): Promise<boolean> =>
    now() - (await mirrorLastUsedMs(dir)) > REPO_CACHE_MIN_IDLE_MS;

  /**
   * Repacking keeps every object, so an active grounding does not block it:
   * workspaces are dissociated from the mirror. Recent use does, because
   * readers clone from the mirror after `ensureRepoCache` releases the lease
   * and a repack deletes the pack files such a clone may be copying. Idle is
   * checked again under the lease, right before the repack.
   */
  async function compactOversized(
    mirror: ScannedMirror,
    result: RepoCacheEvictionResult,
  ): Promise<void> {
    if (!mirror.identity) return;
    if (now() - mirror.lastUsedMs <= REPO_CACHE_MIN_IDLE_MS) return;
    const stats = readPackStats(mirror.dir);
    if (!mirrorNeedsCompaction(stats)) return;
    let outcome: RepoCacheCompactionResult | null = null;
    try {
      outcome = await withLease(
        getRepoCacheLeaseKey(mirror.identity),
        async (lease) => {
          if (!(await isIdle(mirror.dir))) return null;
          return compactMirror(mirror.dir, lease);
        },
        { waitMs: 0 },
      );
      if (!outcome) {
        console.log(
          `[repo-cache] phase=compact-deferred reason=oversized mirror=${mirror.name} recently-used`,
        );
        return;
      }
    } catch (error) {
      if (isLeaseBusy(error)) {
        console.log(
          `[repo-cache] phase=compact-deferred reason=oversized mirror=${mirror.name} lease-busy ` +
            `packs=${stats.packCount} packBytes=${stats.packBytes}`,
        );
        return;
      }
      // One mirror failing to repack must not stop the sweep freeing others.
      console.warn(
        `[repo-cache] phase=compact-failed reason=oversized mirror=${mirror.name}: ` +
          (error instanceof Error ? error.message : String(error)).slice(0, 300),
      );
      return;
    }
    const reclaimed = Math.max(0, outcome.before.packBytes - outcome.after.packBytes);
    telemetry(
      'repo-cache.compaction',
      {
        mirror: mirror.name,
        reason: 'oversized',
        outcome: outcome.compacted ? 'compacted' : (outcome.skippedReason ?? 'skipped'),
      },
      {
        packsBefore: outcome.before.packCount,
        packsAfter: outcome.after.packCount,
        bytesBefore: outcome.before.packBytes,
        bytesAfter: outcome.after.packBytes,
        durationMs: outcome.durationMs,
      },
    );
    if (!outcome.compacted) return;
    mirror.bytes = Math.max(0, mirror.bytes - reclaimed);
    result.compacted += 1;
    result.compactionBytesReclaimed += reclaimed;
  }

  async function finish(result: RepoCacheEvictionResult): Promise<RepoCacheEvictionResult> {
    result.freeBytes = await readFreeBytes(cacheRoot).catch(() => null);
    if (result.freeBytes !== null && result.freeBytes < REPO_CACHE_MIN_FREE_BYTES) {
      console.error(
        `[repo-cache] disk-low freeBytes=${result.freeBytes} requiredBytes=${REPO_CACHE_MIN_FREE_BYTES} dir=${cacheRoot}`,
      );
    }
    telemetry(
      'repo-cache.eviction',
      {},
      {
        scanned: result.scanned,
        evicted: result.evicted,
        protected: result.protected,
        compacted: result.compacted,
        compactionBytesReclaimed: result.compactionBytesReclaimed,
        abandonedClonesRemoved: result.abandonedClonesRemoved,
        bytesBefore: result.bytesBefore,
        bytesAfter: result.bytesAfter,
        maxBytes: result.maxBytes,
        ...(result.freeBytes !== null ? { freeBytes: result.freeBytes } : {}),
      },
    );
    return result;
  }

  return {
    async evictOverBudget() {
      const maxBytes = resolveMaxBytes(dependencies.maxBytes);
      const result: RepoCacheEvictionResult = {
        scanned: 0,
        evicted: 0,
        protected: 0,
        compacted: 0,
        compactionBytesReclaimed: 0,
        abandonedClonesRemoved: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        maxBytes,
        freeBytes: null,
      };

      let entries;
      try {
        entries = await fsp.readdir(cacheRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
        throw error;
      }

      // A mirror backing an active grounding is never a candidate, however
      // large or stale it looks. If that list cannot be loaded, skip eviction
      // rather than treating every mirror as unused.
      let active;
      try {
        active = await listActiveGroundings();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[repo-cache] skipping eviction; could not list active groundings: ${message}`,
        );
        return result;
      }
      const protectedDirs = new Set(
        active.map((grounding) =>
          getRepoCacheDir(groundingCacheOptions(grounding)),
        ),
      );

      const mirrors: ScannedMirror[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        result.scanned += 1;
        const dir = path.join(cacheRoot, entry.name);
        if (ABANDONED_CLONE_RE.test(entry.name)) {
          // The clone's own timeout has passed, so no live git process owns it.
          const stats = await fsp.stat(dir).catch(() => null);
          if (stats && now() - stats.mtimeMs > COLD_CACHE_TIMEOUT_MS) {
            await fsp.rm(dir, { recursive: true, force: true });
            result.abandonedClonesRemoved += 1;
            console.warn(`[repo-cache] removed abandoned clone ${entry.name}`);
            continue;
          }
        }
        let bytes: number;
        let lastUsedMs: number;
        try {
          bytes = await directoryBytes(dir);
          lastUsedMs = await mirrorLastUsedMs(dir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        result.bytesBefore += bytes;

        const idleMs = now() - lastUsedMs;
        const identity = readRepoCacheIdentity(dir);
        // No sidecar means no lease key. Leave the mirror until a fetch writes
        // identity; an unguarded delete or repack can race a live fetch.
        const evictable =
          identity !== null && !protectedDirs.has(dir) && idleMs > REPO_CACHE_MIN_IDLE_MS;
        if (!evictable) result.protected += 1;
        mirrors.push({ name: entry.name, dir, bytes, lastUsedMs, identity, evictable });
      }

      // Compact before the budget check: shrinking a bloated mirror in place
      // can bring the cache under budget without deleting any mirror.
      for (const mirror of mirrors) {
        await compactOversized(mirror, result);
      }

      result.bytesAfter = mirrors.reduce((total, mirror) => total + mirror.bytes, 0);
      if (result.bytesAfter <= maxBytes) return finish(result);

      const candidates: MirrorCandidate[] = mirrors.filter((mirror) => mirror.evictable);

      // Least recently used first: the mirror nobody has touched in the
      // longest goes before one that is merely large.
      candidates.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

      for (const candidate of candidates) {
        if (result.bytesAfter <= maxBytes) break;
        const removed = await removeMirror(candidate, withLease);
        if (!removed) {
          result.protected += 1;
          continue;
        }
        result.bytesAfter -= candidate.bytes;
        result.evicted += 1;
        console.warn(
          `[repo-cache] evicted mirror ${candidate.name} ` +
            `bytes=${candidate.bytes} idleMs=${now() - candidate.lastUsedMs} ` +
            `remaining=${result.bytesAfter} budget=${maxBytes}`,
        );
      }

      return finish(result);
    },
  };
}

async function removeMirror(
  candidate: MirrorCandidate,
  withLease: typeof withRepoCacheLease,
): Promise<boolean> {
  if (!candidate.identity) return false;
  const leaseKey = getRepoCacheLeaseKey(candidate.identity);
  try {
    await withLease(
      leaseKey,
      async () => {
        await fsp.rm(candidate.dir, { recursive: true, force: true });
      },
      { waitMs: 0 },
    );
    return true;
  } catch (error) {
    // Someone is fetching into this mirror right now. Leave it for the next
    // sweep rather than deleting objects a running clone depends on.
    if (isLeaseBusy(error)) return false;
    throw error;
  }
}

export const repoCacheEvictionService = createRepoCacheEvictionService();
