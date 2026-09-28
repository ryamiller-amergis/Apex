/**
 * Real repository checkout for durable interactive turns.
 *
 * Cursor's own tools (grep, glob, shell) read the local disk, so a grounded
 * turn needs the repository on disk at the pinned SHA. Each replica restores
 * one base checkout per SHA from the grounding bundle, then gives each thread
 * its own git worktree of that base. A missing bundle or any git failure
 * returns `unavailable` so the caller keeps the remote reader.
 */
import { mkdir, mkdtemp, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { RepositoryIdentity } from '../../../shared/types/repoReader';
import type { DurableInteractiveTurnSpecification } from '../../../shared/types/durableInteractiveTurn';
import { resolveArtifactCredential } from '../aiRunV2/artifactContainer';
import {
  bundleKey,
  bundleRepositoryName,
  checkoutBundleAtSha,
  defaultRunGit,
  isReadyWorkspace,
  prepareEmptyDestination,
  safeSha,
  verifyHead,
  type GitRunner,
} from '../grounding/bundleCheckout';

const DEFAULT_GROUNDING_CONTAINER = 'repo-grounding';

export type GroundedCheckoutResult =
  | Readonly<{
      status: 'ready';
      identity: RepositoryIdentity;
      source: 'worktree' | 'base' | 'bundle';
      durationMs: number;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'not-configured' | 'bundle-missing' | 'failed';
      durationMs: number;
    }>;

export interface GroundedCheckoutDependencies {
  getContainerClient?: () => ContainerClient | null;
  runGit?: GitRunner;
  cacheRoot?: string;
  now?: () => number;
}

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
  const baseRestores = new Map<string, Promise<'base' | 'bundle' | 'missing'>>();

  const basePathFor = (identity: RepositoryIdentity): string =>
    path.join(
      cacheRoot,
      'apex-interactive-repo',
      bundleKey(identity).replace(/\.bundle$/, ''),
    );

  async function restoreBase(
    container: ContainerClient,
    identity: RepositoryIdentity,
    basePath: string,
    signal: AbortSignal,
  ): Promise<'base' | 'bundle' | 'missing'> {
    if (await isReadyWorkspace(runGit, basePath, identity.sha)) return 'base';
    await mkdir(path.dirname(basePath), { recursive: true });
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'apex-interactive-bundle-'));
    try {
      const bundlePath = path.join(scratch, 'snapshot.bundle');
      try {
        await container
          .getBlockBlobClient(bundleKey(identity))
          .downloadToFile(bundlePath, undefined, undefined, { abortSignal: signal });
      } catch (error) {
        if (isMissingBlob(error)) return 'missing';
        throw error;
      }
      await prepareEmptyDestination(basePath);
      try {
        await checkoutBundleAtSha({
          runGit,
          bundlePath,
          scratchDirectory: scratch,
          destination: basePath,
          expectedSha: identity.sha,
        });
      } catch (error) {
        await rm(basePath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return 'bundle';
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
      const container = getContainerClient();
      if (!container) {
        return { status: 'unavailable', reason: 'not-configured', durationMs: elapsed() };
      }
      try {
        const identity = bundleIdentityForGrounding(grounding);
        if (await isWorktreeAt(runGit, destination, identity.sha)) {
          return { status: 'ready', identity, source: 'worktree', durationMs: elapsed() };
        }

        const basePath = basePathFor(identity);
        let restore = baseRestores.get(basePath);
        const ownsRestore = !restore;
        if (!restore) {
          restore = restoreBase(container, identity, basePath, signal);
          baseRestores.set(basePath, restore);
          void restore.then(
            (outcome) => {
              if (outcome === 'missing') baseRestores.delete(basePath);
            },
            () => baseRestores.delete(basePath),
          );
        }
        const outcome = await restore;
        if (outcome === 'missing') {
          return { status: 'unavailable', reason: 'bundle-missing', durationMs: elapsed() };
        }

        await prepareEmptyDestination(destination);
        await mkdir(path.dirname(destination), { recursive: true });
        await runGit(['-C', basePath, 'worktree', 'prune']);
        await runGit([
          '-C',
          basePath,
          'worktree',
          'add',
          '--detach',
          destination,
          identity.sha,
        ]);
        if (!(await verifyHead(runGit, destination, identity.sha))) {
          throw new Error('Grounded worktree SHA verification failed');
        }
        return {
          status: 'ready',
          identity,
          source: ownsRestore ? outcome : 'base',
          durationMs: elapsed(),
        };
      } catch {
        return { status: 'unavailable', reason: 'failed', durationMs: elapsed() };
      }
    },
  };
}

export type GroundedRepositoryCheckout = ReturnType<
  typeof createGroundedRepositoryCheckout
>;
