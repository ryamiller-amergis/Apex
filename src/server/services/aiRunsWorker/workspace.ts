import { promises as fs } from 'fs';
import path from 'path';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type { RepoReader, RepositoryIdentity } from '../../../shared/types/repoReader';
import { LocalCheckoutReader } from '../localCheckoutReader';
import { BareRepoReader } from '../repoRead/bareRepoReader';
import { isUsableBareMirror } from '../repoRead/mirrorStore';
import {
  RepoServiceReader,
  resolveRepoReadServiceUrl,
} from '../repoRead/repoServiceReader';

function identityFromSnapshot(
  snapshot: Readonly<ExecutionSnapshot>,
): RepositoryIdentity {
  return {
    provider: snapshot.provider ?? 'ado',
    project: snapshot.projectId,
    repo: snapshot.repository ?? 'local-checkout',
    sha: snapshot.groundedSha?.trim() || 'frozen',
  };
}

/**
 * Open and probe the frozen checkout. Prefer `checkoutRef` (shared read tree at
 * the interview SHA) when present; otherwise the legacy full-clone workspaceRef.
 */
export async function openLocalCheckout(
  snapshot: Readonly<ExecutionSnapshot>,
  checkoutPath = snapshot.checkoutRef?.trim() || snapshot.workspaceRef,
): Promise<LocalCheckoutReader> {
  const reader = new LocalCheckoutReader({
    checkoutPath,
    identity: {
      provider: 'ado',
      project: snapshot.projectId,
      repo: 'local-checkout',
      sha: 'frozen',
    },
  });
  await reader.listDir('');
  return reader;
}

/**
 * Open a repo reader for a background worker. Prefer a usable bare mirror on
 * this host, then the HTTP read service, then a working-tree checkout.
 */
export async function openGroundedReader(
  snapshot: Readonly<ExecutionSnapshot>,
): Promise<RepoReader> {
  const sha = snapshot.groundedSha?.trim();
  const identity = identityFromSnapshot(snapshot);

  if (isUsableBareMirror(snapshot.mirrorRef) && sha) {
    try {
      const reader = new BareRepoReader({
        identity,
        mirrorPath: snapshot.mirrorRef,
      });
      await reader.listDir('');
      return reader;
    } catch {
      // Path may be an App Service cache the ACA worker cannot open.
    }
  }

  const serviceUrl = resolveRepoReadServiceUrl();
  if (serviceUrl && sha) {
    try {
      const reader = new RepoServiceReader({
        identity,
        baseUrl: serviceUrl,
      });
      await reader.listDir('');
      return reader;
    } catch {
      // Fall through to the working-tree reader.
    }
  }

  return openLocalCheckout(snapshot);
}

async function syncFiles(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncFiles(entryPath);
    } else if (entry.isFile()) {
      const handle = await fs.open(entryPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
}

/**
 * Force shared-workspace output file data to storage before terminal ingest.
 * An absent output directory means the workflow produced no file artifacts.
 */
export async function flushWorkspaceArtifacts(
  workspaceRef: string,
): Promise<void> {
  const outputDirectory = path.join(workspaceRef, '.ai-pilot', 'output');
  try {
    await syncFiles(outputDirectory);
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}
