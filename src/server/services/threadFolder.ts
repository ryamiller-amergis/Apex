import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isFlagEnabledForWholeProject } from './featureFlagService';

/**
 * Whole-V2 projects run every AI turn on V2 hosts, which read thread inputs
 * from the database and Blob, so their threads get no folder on the share.
 */
export async function keepsThreadFolder(project: string): Promise<boolean> {
  return !(await isFlagEnabledForWholeProject('ai-runs-v2-transport', project).catch(() => false));
}

/** Write a file into the thread folder, unless the project's threads have none. */
export async function writeThreadFolderFile(input: {
  project: string;
  workspaceDir: string | null | undefined;
  relativePath: string;
  content: string;
}): Promise<void> {
  if (!input.workspaceDir || !(await keepsThreadFolder(input.project))) return;
  const target = path.join(input.workspaceDir, ...input.relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, input.content, 'utf-8');
}
