/**
 * Shared, read-only per-SHA grounding checkout.
 *
 * Repository-reading chat callers (interview, ADR, PRD/design-doc assistants,
 * agent-home, walkthrough, design-module) use the grounding checkout strictly
 * read-only — every write in the chat path targets `thread.workspaceDir`, not
 * the grounding `cwd`. So instead of cloning a fresh working tree per run
 * (keyed by `runId` in the run-grounding materializer), sessions at the same
 * `(provider, project, repo, branch, sha)` can share ONE materialized tree.
 *
 * This service owns that shared tree:
 *  - a SHA-keyed opaque destination under `workspaces/grounding-shared`
 *  - lease-guarded materialization (one clone+checkout even under a cold race)
 *  - an in-process ref-count so eviction never deletes a tree in use
 *  - idle-TTL eviction that also protects any SHA an active grounding pins
 *
 * Writing lanes (background generation, dev sessions, attachment/in-process
 * turns) keep their per-`runId` isolated checkouts and never touch this path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SkillProvider } from '../../../shared/types/projectSettings';
import type { RunGrounding } from '../../../shared/types/runGrounding';
import { resolveDataRoot } from '../../utils/dataDir';
import { git, safeArgs } from '../../utils/asyncGit';
import { ensureRepoCache } from '../repoCacheService';
import { materializeWorkspaceFromCache } from '../repoWorkspaceService';
import {
  withRepoCacheLease,
  type RepoCacheLeaseContext,
} from '../repoCacheLeaseService';
import { runGroundingRepository } from '../runGroundingRepository';
import { trackEvent } from '../telemetry';

export interface SharedReadCheckoutIdentity {
  /** Apex-side provider ('ado' | 'github'), matching repo-cache options. */
  provider: SkillProvider;
  project: string;
  repo: string;
  branch: string;
  sha: string;
}

export type SharedReadCheckoutOutcome = 'hit' | 'materialized' | 'wait';

export interface SharedReadCheckoutResult {
  workspacePath: string;
  outcome: SharedReadCheckoutOutcome;
}

export interface SharedReadCheckoutEvictionResult {
  scanned: number;
  evicted: number;
  protected: number;
}

/** Marker written only after a fully successful materialization. */
export const SHARED_READ_MARKER = '.apex-shared-ready';

/**
 * Suffix for the last-use sidecar written BESIDE each shared tree (never inside
 * it, so the tree stays pristine for future read-only chmod hardening). We
 * refresh it explicitly on materialize (cold + warm hit) and release rather than
 * relying on directory atime — Azure Files (App Service `/home`) has unreliable
 * atime semantics and a warm hit never touches the tree.
 */
export const SHARED_READ_LASTUSED_SUFFIX = '.lastused';

/** Idle age (by last-use sidecar) after which an unreferenced tree is evicted. */
export const SHARED_READ_IDLE_TTL_MS = 30 * 60 * 1000;

/** Exact-commit fetch timeout when the pinned SHA is missing from the mirror. */
export const SHARED_READ_EXACT_FETCH_TIMEOUT_MS = 45_000;

const SHARED_ROOT_SEGMENTS = ['workspaces', 'grounding-shared'] as const;

export interface SharedReadCheckoutDependencies {
  dataRoot?: string;
  /** Materialize the pinned SHA working tree into `destination`. */
  materializeToPath?: (
    identity: SharedReadCheckoutIdentity,
    destination: string,
  ) => Promise<void>;
  withLease?: <T>(
    cacheKey: string,
    operation: (lease: RepoCacheLeaseContext) => Promise<T>,
    options?: { waitMs?: number },
  ) => Promise<T>;
  /** Max time to wait for a peer's shared-checkout lease (default 90s). */
  leaseWaitMs?: number;
  listActiveGroundings?: () => Promise<RunGrounding[]>;
  telemetry?: typeof trackEvent;
  now?: () => number;
}

function identityDigest(identity: SharedReadCheckoutIdentity): string {
  const key = [
    identity.provider,
    identity.project,
    identity.repo,
    identity.branch,
    identity.sha,
  ].join('\0');
  return crypto.createHash('sha256').update(key).digest('hex');
}

function providerFromGrounding(
  provider: RunGrounding['provider'],
): SkillProvider {
  return provider === 'azure_devops' ? 'ado' : 'github';
}

export function sharedReadCheckoutIdentityFromGrounding(
  grounding: Pick<
    RunGrounding,
    'provider' | 'project' | 'repository' | 'branch' | 'groundedSha'
  >,
): SharedReadCheckoutIdentity {
  return {
    provider: providerFromGrounding(grounding.provider),
    project: grounding.project,
    repo: grounding.repository,
    branch: grounding.branch,
    sha: grounding.groundedSha,
  };
}

export interface SharedReadCheckoutService {
  resolvePath(identity: SharedReadCheckoutIdentity): string;
  /**
   * Return an already-complete shared checkout without acquiring a lease or
   * starting materialization. User-facing read paths use this ready-only probe
   * so a cold Azure Files tree can never block a chat turn.
   */
  getReady(
    identity: SharedReadCheckoutIdentity,
  ): SharedReadCheckoutResult | null;
  materialize(
    identity: SharedReadCheckoutIdentity,
  ): Promise<SharedReadCheckoutResult>;
  retain(identity: SharedReadCheckoutIdentity): void;
  releaseRef(identity: SharedReadCheckoutIdentity): void;
  getRefCount(identity: SharedReadCheckoutIdentity): number;
  evictIdle(): Promise<SharedReadCheckoutEvictionResult>;
}

async function defaultMaterializeToPath(
  identity: SharedReadCheckoutIdentity,
  destination: string,
): Promise<void> {
  const options = {
    provider: identity.provider,
    project: identity.project,
    repo: identity.repo,
    branch: identity.branch,
  } as const;
  const cache = await ensureRepoCache(options);
  const checkoutPinnedSha = async (): Promise<void> => {
    await materializeWorkspaceFromCache(
      cache.cacheDir,
      destination,
      identity.branch,
      cache.remote.url,
    );
    await git(safeArgs(destination, ['checkout', '--detach', identity.sha]), {
      cwd: destination,
    });
  };
  try {
    await checkoutPinnedSha();
  } catch {
    // Pinned SHA may be absent from the shared mirror; fetch it exactly, retry.
    await git(
      safeArgs(cache.cacheDir, ['fetch', '--no-tags', cache.remote.url, identity.sha]),
      {
        cwd: cache.cacheDir,
        timeout: SHARED_READ_EXACT_FETCH_TIMEOUT_MS,
        env: cache.remote.env,
      },
    );
    await checkoutPinnedSha();
  }
}

export function createSharedReadCheckoutService(
  dependencies: SharedReadCheckoutDependencies = {},
): SharedReadCheckoutService {
  const dataRoot = dependencies.dataRoot ?? resolveDataRoot();
  const materializeToPath =
    dependencies.materializeToPath ?? defaultMaterializeToPath;
  const withLease = dependencies.withLease ?? withRepoCacheLease;
  const listActiveGroundings =
    dependencies.listActiveGroundings ??
    (() => runGroundingRepository.listActiveGroundings());
  const telemetry = dependencies.telemetry ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const sharedRoot = path.join(dataRoot, ...SHARED_ROOT_SEGMENTS);

  // In-process ref-count keyed by identity digest. A tree with a live ref is
  // never evicted by this instance's sweep.
  const refCounts = new Map<string, number>();
  const materializations = new Map<
    string,
    Promise<SharedReadCheckoutResult>
  >();

  const safeTelemetry: typeof trackEvent = (name, properties, measurements) => {
    try {
      telemetry(name, properties, measurements);
    } catch {
      // Telemetry is best effort and must never affect grounding.
    }
  };

  const resolvePath = (identity: SharedReadCheckoutIdentity): string =>
    path.join(sharedRoot, identityDigest(identity));

  const markerPath = (destination: string): string =>
    path.join(destination, SHARED_READ_MARKER);

  // Sibling sidecar (never inside the tree) recording the last time a session
  // acquired or released the tree. Drives idle eviction instead of atime.
  const lastUsedPath = (destination: string): string =>
    `${destination}${SHARED_READ_LASTUSED_SUFFIX}`;

  const touchLastUsed = (destination: string): void => {
    try {
      fs.writeFileSync(lastUsedPath(destination), String(now()), 'utf-8');
    } catch {
      // Best effort; eviction falls back to directory mtime.
    }
  };

  const readLastUsed = (destination: string): number | null => {
    try {
      const raw = fs.readFileSync(lastUsedPath(destination), 'utf-8').trim();
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  // Promote a fully-staged tree (marker already inside it) into its final
  // SHA-keyed destination with a single atomic rename. `destination` therefore
  // only ever appears as a COMPLETE, marker-bearing tree — it is never observed
  // half-written and never partially wiped by a racing (or SMB-cache-blinded)
  // re-materialize. Must be called under the materialize lease.
  const promoteStaged = async (
    stagingDir: string,
    destination: string,
  ): Promise<'materialized' | 'wait'> => {
    try {
      await fsp.rename(stagingDir, destination);
      return 'materialized';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A non-empty destination means a peer already promoted a tree here
      // (ENOTEMPTY/EEXIST on POSIX + Azure Files SMB, EPERM/EACCES on Windows).
      if (
        code === 'ENOTEMPTY'
        || code === 'EEXIST'
        || code === 'EPERM'
        || code === 'EACCES'
      ) {
        // A complete peer tree already exists — adopt it, discard our staging.
        if (fs.existsSync(markerPath(destination))) return 'wait';
        // Legacy/partial squatter with no marker (pre-atomic code or crash):
        // safe to replace under the lease we hold, since a marker-less tree is
        // never handed to a reader.
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(stagingDir, destination);
        return 'materialized';
      }
      throw error;
    }
  };

  const getReady = (
    identity: SharedReadCheckoutIdentity,
  ): SharedReadCheckoutResult | null => {
    const destination = resolvePath(identity);
    if (!fs.existsSync(markerPath(destination))) return null;

    touchLastUsed(destination);
    safeTelemetry(
      'grounding.shared.checkout',
      { outcome: 'hit', provider: identity.provider, project: identity.project },
      { durationMs: 0 },
    );
    return { workspacePath: destination, outcome: 'hit' };
  };

  const materialize = async (
    identity: SharedReadCheckoutIdentity,
  ): Promise<SharedReadCheckoutResult> => {
    const destination = resolvePath(identity);

    // Warm fast-path: a completed materialization left a marker.
    const ready = getReady(identity);
    if (ready) return ready;

    const digest = identityDigest(identity);
    const existing = materializations.get(digest);
    if (existing) return existing;

    const startedAt = now();
    const leaseKey = `grounding-shared:${digest}`;
    // Chat turns fail closed after ~45s on the interactive prep path; waiting
    // up to 65 minutes for a peer lease would retain stale background work.
    // Bound peer waiting; user-facing callers already returned remote.
    const leaseWaitMs = dependencies.leaseWaitMs ?? 90_000;
    const pending = (async (): Promise<SharedReadCheckoutResult> => {
      const outcome = await withLease(
        leaseKey,
        async (lease) => {
          // Someone may have materialized it while we waited for the lease.
          if (fs.existsSync(markerPath(destination))) return 'wait' as const;
          await lease.assertOwned();
          fs.mkdirSync(path.dirname(destination), { recursive: true });

          // Build into a private temp sibling on the SAME share, drop the marker
          // INSIDE it, then atomically rename it into place. Staging + rename makes
          // materialization crash-safe and idempotent across instances: we never
          // rm/re-clone an existing ready tree (the old destructive loop that wiped
          // the marker), so a warm tree survives even when this instance's SMB
          // directory cache transiently hides the marker.
          const stagingDir = `${destination}.tmp-${process.pid}-${crypto
            .randomBytes(6)
            .toString('hex')}`;
          try {
            await materializeToPath(identity, stagingDir);
            // Marker travels atomically with the tree via the rename below.
            await fsp.writeFile(
              path.join(stagingDir, SHARED_READ_MARKER),
              JSON.stringify({
                sha: identity.sha,
                readyAt: new Date(now()).toISOString(),
              }),
              'utf-8',
            );
            return await promoteStaged(stagingDir, destination);
          } finally {
            // If we didn't promote (peer won, or error) drop the staged tree.
            // After a successful rename this is a no-op (ENOENT swallowed by force).
            await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
          }
        },
        { waitMs: leaseWaitMs },
      );

      touchLastUsed(destination);
      safeTelemetry(
        'grounding.shared.checkout',
        { outcome, provider: identity.provider, project: identity.project },
        { durationMs: Math.max(0, now() - startedAt) },
      );
      return { workspacePath: destination, outcome };
    })();
    materializations.set(digest, pending);
    try {
      return await pending;
    } finally {
      if (materializations.get(digest) === pending) {
        materializations.delete(digest);
      }
    }
  };

  const retain = (identity: SharedReadCheckoutIdentity): void => {
    const digest = identityDigest(identity);
    refCounts.set(digest, (refCounts.get(digest) ?? 0) + 1);
  };

  const releaseRef = (identity: SharedReadCheckoutIdentity): void => {
    const digest = identityDigest(identity);
    const next = (refCounts.get(digest) ?? 0) - 1;
    if (next <= 0) refCounts.delete(digest);
    else refCounts.set(digest, next);
    // Count idle from the last release, not the last acquire.
    touchLastUsed(resolvePath(identity));
  };

  const getRefCount = (identity: SharedReadCheckoutIdentity): number =>
    refCounts.get(identityDigest(identity)) ?? 0;

  const evictIdle = async (): Promise<SharedReadCheckoutEvictionResult> => {
    const result: SharedReadCheckoutEvictionResult = {
      scanned: 0,
      evicted: 0,
      protected: 0,
    };

    let entries;
    try {
      entries = await fsp.readdir(sharedRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw error;
    }

    // Protect any SHA an active grounding currently pins.
    const active = await listActiveGroundings().catch(() => []);
    const protectedDigests = new Set(
      active.map((grounding) =>
        identityDigest(sharedReadCheckoutIdentityFromGrounding(grounding)),
      ),
    );

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      result.scanned += 1;
      const digest = entry.name;
      if (protectedDigests.has(digest) || (refCounts.get(digest) ?? 0) > 0) {
        result.protected += 1;
        continue;
      }
      const workspace = path.join(sharedRoot, digest);
      try {
        const lastUsed =
          readLastUsed(workspace) ?? (await fsp.stat(workspace)).mtimeMs;
        if (now() - lastUsed <= SHARED_READ_IDLE_TTL_MS) continue;
        // Guard deletion with the same lease so we never race a materialize.
        await withLease(`grounding-shared:${digest}`, async () => {
          if ((refCounts.get(digest) ?? 0) > 0) return;
          await fsp.rm(workspace, { recursive: true, force: true });
          await fsp.rm(lastUsedPath(workspace), { force: true });
          result.evicted += 1;
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    safeTelemetry(
      'grounding.shared.eviction',
      {},
      {
        scanned: result.scanned,
        evicted: result.evicted,
        protected: result.protected,
      },
    );
    return result;
  };

  return {
    resolvePath,
    getReady,
    materialize,
    retain,
    releaseRef,
    getRefCount,
    evictIdle,
  };
}

export const sharedReadCheckoutService = createSharedReadCheckoutService();
