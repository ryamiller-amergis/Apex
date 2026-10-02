/**
 * Real repository checkout for durable interactive turns.
 *
 * Cursor's own tools (grep, glob, shell) read the local disk, so a grounded
 * turn needs the repository on disk at the pinned SHA. Each replica restores
 * one object-only base per SHA from the grounding bundle, then gives each
 * thread its own git worktree of that base. A missing or oversized bundle, a
 * full disk budget, or any git failure returns `unavailable` so the caller
 * keeps the remote reader.
 *
 * Container Apps evicts a replica whose ephemeral storage exceeds its limit,
 * which kills every turn on it, so disk use is capped by an estimate rather
 * than discovered.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import type { DurableInteractiveTurnSpecification } from '../../../shared/types/durableInteractiveTurn';
import { resolveArtifactCredential } from '../aiRunV2/artifactContainer';
import {
  bundleKey,
  bundleRepositoryName,
  defaultRunGit,
  GROUNDING_WORKSPACE_READY_MARKER,
  prepareEmptyDestination,
  safeSha,
  verifyHead,
  type GitRunner,
} from '../grounding/bundleCheckout';
import { createPerThreadTurnQueue } from './perThreadTurnQueue';

const DEFAULT_GROUNDING_CONTAINER = 'repo-grounding';
const GIB = 1024 * 1024 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 1 * GIB;
const DEFAULT_DISK_BUDGET_BYTES = 2.5 * GIB;
// A full `ls-tree -r -l` of a large repository runs well past git's default 10MB.
const TREE_LISTING_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export type GroundedCheckoutUnavailableReason =
  | 'not-configured'
  | 'bundle-missing'
  | 'bundle-too-large'
  | 'disk-budget'
  | 'failed';

export type GroundedCheckoutResult =
  | Readonly<{
      status: 'ready';
      identity: RepositoryIdentity;
      source: 'worktree' | 'base' | 'bundle';
      durationMs: number;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: GroundedCheckoutUnavailableReason;
      durationMs: number;
    }>;

export interface GroundedCheckoutDependencies {
  getContainerClient?: () => ContainerClient | null;
  runGit?: GitRunner;
  cacheRoot?: string;
  now?: () => number;
  maxBundleBytes?: number;
  diskBudgetBytes?: number;
}

type BaseOutcome =
  | Readonly<{ status: 'ready'; source: 'base' | 'bundle' }>
  | Readonly<{ status: 'unavailable'; reason: 'bundle-missing' | 'bundle-too-large' | 'disk-budget' }>;

/** One restore per base, shared by every turn waiting on it. */
type SharedRestore = {
  outcome: Promise<BaseOutcome>;
  controller: AbortController;
  waiters: number;
};

export function bundleIdentityForGrounding(
  grounding: NonNullable<DurableInteractiveTurnSpecification['grounding']>,
): RepositoryIdentity {
  return {
    provider: grounding.provider,
    project: grounding.project,
    repo: bundleRepositoryName(grounding.provider, grounding.repository),
    sha: safeSha(grounding.sha),
  };
}

function defaultGroundingContainerClient(): ContainerClient | null {
  const account = process.env.GROUNDING_BLOB_ACCOUNT_NAME?.trim();
  if (!account) return null;
  const container =
    process.env.GROUNDING_BLOB_CONTAINER_NAME?.trim() ||
    DEFAULT_GROUNDING_CONTAINER;
  return new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    resolveArtifactCredential(),
  ).getContainerClient(container);
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissingBlob(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
  return statusCode === 404 || code === 'BlobNotFound';
}

async function isWorktreeAt(
  runGit: GitRunner,
  destination: string,
  sha: string,
): Promise<boolean> {
  try {
    await stat(path.join(destination, '.git'));
    return await verifyHead(runGit, destination, sha);
  } catch {
    return false;
  }
}

// A bare repository has no `.git` subdirectory; its root is the git dir.
async function isReadyBase(
  runGit: GitRunner,
  basePath: string,
  sha: string,
): Promise<boolean> {
  try {
    const marked = (await readFile(path.join(basePath, GROUNDING_WORKSPACE_READY_MARKER), 'utf8'))
      .trim()
      .toLowerCase();
    if (marked !== sha) return false;
    await runGit(['-C', basePath, 'cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function createGroundedRepositoryCheckout(
  dependencies: GroundedCheckoutDependencies = {},
) {
  const getContainerClient =
    dependencies.getContainerClient ?? defaultGroundingContainerClient;
  const runGit = dependencies.runGit ?? defaultRunGit;
  const cacheRoot =
    dependencies.cacheRoot ??
    (process.env.AI_RUNS_INTERACTIVE_ATTEMPT_ROOT?.trim() || os.tmpdir());
  const now = dependencies.now ?? Date.now;
  const maxBundleBytes =
    dependencies.maxBundleBytes ??
    positiveNumberFromEnv('AI_RUNS_INTERACTIVE_CHECKOUT_MAX_BUNDLE_BYTES', DEFAULT_MAX_BUNDLE_BYTES);
  const diskBudgetBytes =
    dependencies.diskBudgetBytes ??
    positiveNumberFromEnv('AI_RUNS_INTERACTIVE_CHECKOUT_DISK_BUDGET_BYTES', DEFAULT_DISK_BUDGET_BYTES);

  const baseRestores = new Map<string, SharedRestore>();
  // Checkouts in progress per base, so eviction never removes a base between
  // its restore and the worktree that will depend on it.
  const basePins = new Map<string, number>();
  // `git worktree prune`/`add` on one base must not interleave.
  const worktreeQueue = createPerThreadTurnQueue();
  // Estimated bytes on disk: a base holds the bundle's objects; a worktree
  // holds the commit's uncompressed files, which for a large repository can be
  // many times the bundle size.
  const baseBytes = new Map<string, number>();
  const worktreeSizeByBase = new Map<string, number>();
  const worktreeBytes = new Map<string, number>();
  const worktreeBase = new Map<string, string>();
  const baseLastUsed = new Map<string, number>();
  const estimatedBytes = (): number =>
    [...baseBytes.values(), ...worktreeBytes.values()].reduce((sum, bytes) => sum + bytes, 0);

  // A worktree breaks if its base is deleted, so only bases no thread uses are
  // removed, least recently used first.
  async function evictIdleBases(neededBytes: number, keep: string): Promise<void> {
    const inUse = new Set(worktreeBase.values());
    const idle = [...baseBytes.keys()]
      .filter((basePath) => basePath !== keep && !inUse.has(basePath) && !basePins.has(basePath))
      .sort((left, right) => (baseLastUsed.get(left) ?? 0) - (baseLastUsed.get(right) ?? 0));
    for (const basePath of idle) {
      if (estimatedBytes() + neededBytes <= diskBudgetBytes) return;
      baseBytes.delete(basePath);
      baseLastUsed.delete(basePath);
      baseRestores.delete(basePath);
      worktreeSizeByBase.delete(basePath);
      await rm(basePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  const basePathFor = (identity: RepositoryIdentity): string =>
    path.join(
      cacheRoot,
      'apex-interactive-repo',
      `${bundleKey(identity).replace(/\.bundle$/, '')}.git`,
    );

  const pinBase = (basePath: string): void => {
    basePins.set(basePath, (basePins.get(basePath) ?? 0) + 1);
  };
  const unpinBase = (basePath: string): void => {
    const remaining = (basePins.get(basePath) ?? 1) - 1;
    if (remaining > 0) basePins.set(basePath, remaining);
    else basePins.delete(basePath);
  };

  // Each waiter stops waiting on its own abort; the shared restore is aborted
  // only once every waiter has left.
  function awaitRestore(
    basePath: string,
    shared: SharedRestore,
    signal: AbortSignal,
  ): Promise<BaseOutcome> {
    if (signal.aborted) return Promise.reject(signal.reason);
    shared.waiters += 1;
    return new Promise<BaseOutcome>((resolve, reject) => {
      let waiting = true;
      const leave = (): boolean => {
        if (!waiting) return false;
        waiting = false;
        shared.waiters -= 1;
        return true;
      };
      const onAbort = (): void => {
        if (leave() && shared.waiters === 0) {
          if (baseRestores.get(basePath) === shared) baseRestores.delete(basePath);
          shared.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.outcome.then(
        (outcome) => {
          signal.removeEventListener('abort', onAbort);
          leave();
          resolve(outcome);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          leave();
          reject(error);
        },
      );
    });
  }

  async function worktreeBytesFor(
    basePath: string,
    sha: string,
    signal: AbortSignal,
  ): Promise<number> {
    const known = worktreeSizeByBase.get(basePath);
    if (known !== undefined) return known;
    const listing = await runGit(['-C', basePath, 'ls-tree', '-r', '-l', '--full-tree', sha], {
      signal,
      maxBuffer: TREE_LISTING_MAX_BUFFER_BYTES,
    });
    let fileBytes = 0;
    for (const line of listing.split('\n')) {
      // "<mode> <type> <object> <size>\t<path>"; submodules report "-".
      const size = Number(line.split(/\s+/)[3]);
      if (Number.isFinite(size)) fileBytes += size;
    }
    const bytes = Math.max(fileBytes, baseBytes.get(basePath) ?? 0);
    worktreeSizeByBase.set(basePath, bytes);
    return bytes;
  }

  async function restoreBase(
    container: ContainerClient,
    identity: RepositoryIdentity,
    basePath: string,
    signal: AbortSignal,
  ): Promise<BaseOutcome> {
    if (baseBytes.has(basePath) && (await isReadyBase(runGit, basePath, identity.sha))) {
      return { status: 'ready', source: 'base' };
    }
    const blob = container.getBlockBlobClient(bundleKey(identity));
    let size: number;
    try {
      size = (await blob.getProperties({ abortSignal: signal })).contentLength ?? 0;
    } catch (error) {
      if (isMissingBlob(error)) return { status: 'unavailable', reason: 'bundle-missing' };
      throw error;
    }
    if (size > maxBundleBytes) return { status: 'unavailable', reason: 'bundle-too-large' };
    // Peak while restoring: the downloaded bundle plus the cloned objects.
    await evictIdleBases(2 * size, basePath);
    if (estimatedBytes() + 2 * size > diskBudgetBytes) {
      return { status: 'unavailable', reason: 'disk-budget' };
    }

    await mkdir(path.dirname(basePath), { recursive: true });
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'apex-interactive-bundle-'));
    try {
      const bundlePath = path.join(scratch, 'snapshot.bundle');
      try {
        await blob.downloadToFile(bundlePath, undefined, undefined, { abortSignal: signal });
      } catch (error) {
        if (isMissingBlob(error)) return { status: 'unavailable', reason: 'bundle-missing' };
        throw error;
      }
      await prepareEmptyDestination(basePath);
      try {
        await runGit(['clone', '--bare', bundlePath, basePath], { signal });
        await rm(scratch, { recursive: true, force: true });
        await runGit(['-C', basePath, 'cat-file', '-e', `${identity.sha}^{commit}`]);
        await writeFile(
          path.join(basePath, GROUNDING_WORKSPACE_READY_MARKER),
          `${identity.sha}\n`,
          'utf8',
        );
      } catch (error) {
        await rm(basePath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      baseBytes.set(basePath, size);
      return { status: 'ready', source: 'bundle' };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    /**
     * Places a worktree of the grounded repository at `destination`. Files the
     * caller wrote there earlier (attachments, turn outputs) are removed when a
     * new worktree has to be created.
     */
    async checkout(
      grounding: NonNullable<DurableInteractiveTurnSpecification['grounding']>,
      destination: string,
      signal: AbortSignal,
    ): Promise<GroundedCheckoutResult> {
      const startedAt = now();
      const elapsed = () => now() - startedAt;
      const unavailable = (reason: GroundedCheckoutUnavailableReason): GroundedCheckoutResult => ({
        status: 'unavailable',
        reason,
        durationMs: elapsed(),
      });
      const container = getContainerClient();
      if (!container) return unavailable('not-configured');
      let pinnedBase: string | undefined;
      try {
        const identity = bundleIdentityForGrounding(grounding);
        const basePath = basePathFor(identity);
        pinBase(basePath);
        pinnedBase = basePath;
        if (worktreeBytes.has(destination) && (await isWorktreeAt(runGit, destination, identity.sha))) {
          baseLastUsed.set(basePath, now());
          return { status: 'ready', identity, source: 'worktree', durationMs: elapsed() };
        }
        // The thread moved to another commit; its old worktree is replaced below.
        worktreeBytes.delete(destination);
        worktreeBase.delete(destination);

        let shared = baseRestores.get(basePath);
        const ownsRestore = !shared;
        if (!shared) {
          const controller = new AbortController();
          const created: SharedRestore = {
            outcome: restoreBase(container, identity, basePath, controller.signal),
            controller,
            waiters: 0,
          };
          shared = created;
          baseRestores.set(basePath, created);
          const forget = (): void => {
            if (baseRestores.get(basePath) === created) baseRestores.delete(basePath);
          };
          void created.outcome.then(
            (outcome) => {
              if (outcome.status !== 'ready') forget();
            },
            forget,
          );
        }
        const outcome = await awaitRestore(basePath, shared, signal);
        if (outcome.status !== 'ready') return unavailable(outcome.reason);

        const worktreeSize = await worktreeBytesFor(basePath, identity.sha, signal);
        await evictIdleBases(worktreeSize, basePath);
        if (estimatedBytes() + worktreeSize > diskBudgetBytes) return unavailable('disk-budget');

        await worktreeQueue.submit(basePath, async () => {
          signal.throwIfAborted();
          await prepareEmptyDestination(destination);
          await mkdir(path.dirname(destination), { recursive: true });
          await runGit(['-C', basePath, 'worktree', 'prune']);
          await runGit(
            ['-C', basePath, 'worktree', 'add', '--detach', destination, identity.sha],
            { signal },
          );
        });
        if (!(await verifyHead(runGit, destination, identity.sha))) {
          throw new Error('Grounded worktree SHA verification failed');
        }
        worktreeBytes.set(destination, worktreeSize);
        worktreeBase.set(destination, basePath);
        baseLastUsed.set(basePath, now());
        return {
          status: 'ready',
          identity,
          source: ownsRestore ? outcome.source : 'base',
          durationMs: elapsed(),
        };
      } catch {
        return unavailable('failed');
      } finally {
        if (pinnedBase) unpinBase(pinnedBase);
      }
    },

    /** Removes a thread worktree and returns its share of the disk budget. */
    async release(destination: string): Promise<void> {
      worktreeBytes.delete(destination);
      worktreeBase.delete(destination);
      await rm(destination, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export type GroundedRepositoryCheckout = ReturnType<
  typeof createGroundedRepositoryCheckout
>;
