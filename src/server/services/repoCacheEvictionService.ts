import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RunGrounding } from '../../shared/types/runGrounding';
import { resolveDataRoot } from '../utils/dataDir';
import { withRepoCacheLease } from './repoCacheLeaseService';
import {
  COLD_CACHE_TIMEOUT_MS,
  REPO_CACHE_MIN_FREE_BYTES,
  getRepoCacheDir,
  getRepoCacheLeaseKey,
  readRepoCacheFreeBytes,
  readRepoCacheIdentity,
  readRepoCacheLastUsed,
  type RepoCacheIdentity,
  type RepoCacheOptions,
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

export interface RepoCacheEvictionResult {
  scanned: number;
  evicted: number;
  protected: number;
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
}

interface MirrorCandidate {
  name: string;
  dir: string;
  bytes: number;
  lastUsedMs: number;
  identity: RepoCacheIdentity | null;
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
  const cacheRoot = path.join(dataRoot, 'repo-cache');

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

      const candidates: MirrorCandidate[] = [];
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
          lastUsedMs =
            readRepoCacheLastUsed(dir) ?? (await fsp.stat(dir)).mtimeMs;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        result.bytesBefore += bytes;

        const idleMs = now() - lastUsedMs;
        const identity = readRepoCacheIdentity(dir);
        // No sidecar means no lease key. Leave the mirror until a fetch writes
        // identity; unguarded delete can remove a cache a live fetch still owns.
        if (!identity || protectedDirs.has(dir) || idleMs <= REPO_CACHE_MIN_IDLE_MS) {
          result.protected += 1;
          continue;
        }
        candidates.push({ name: entry.name, dir, bytes, lastUsedMs, identity });
      }

      result.bytesAfter = result.bytesBefore;
      if (result.bytesAfter <= maxBytes) return finish(result);

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
    if (
      error instanceof Error &&
      error.message.startsWith('Timed out waiting for repository cache lease:')
    ) {
      return false;
    }
    throw error;
  }
}

export const repoCacheEvictionService = createRepoCacheEvictionService();
