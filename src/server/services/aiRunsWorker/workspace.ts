import { promises as fs } from 'fs';
import path from 'path';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import { LocalCheckoutReader } from '../localCheckoutReader';

/**
 * Open and probe exactly the ready checkout named by the frozen snapshot.
 * No remote reader or prepareRepositoryReadRuntime fallback exists here.
 */
export async function openLocalCheckout(
  snapshot: Readonly<ExecutionSnapshot>,
  checkoutPath = snapshot.workspaceRef,
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
