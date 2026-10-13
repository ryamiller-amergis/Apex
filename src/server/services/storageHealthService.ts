import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveDataRoot } from '../utils/dataDir';
import { REPO_CACHE_MIN_FREE_BYTES, readRepoCacheFreeBytes } from './repoCacheService';

export type StorageCheckName = 'dataRoot' | 'workspaceMount' | 'freeSpace';
export type StorageCheckResult = 'ok' | 'failed';

export interface StorageHealthReport {
  status: 'ok' | 'failed';
  checks: Record<StorageCheckName, StorageCheckResult>;
}

export interface StorageHealthDependencies {
  dataRoot: string;
  /** App Service mounts the Azure Files share here; elsewhere it is a plain folder. */
  requireWorkspaceMount: boolean;
  readMounts: () => Promise<string>;
  readFreeBytes: (dir: string) => Promise<number>;
  minFreeBytes: number;
}

function defaultDependencies(): StorageHealthDependencies {
  return {
    dataRoot: resolveDataRoot(),
    requireWorkspaceMount: Boolean(process.env.WEBSITE_SITE_NAME) && process.platform === 'linux',
    readMounts: () => fs.readFile('/proc/mounts', 'utf8'),
    readFreeBytes: readRepoCacheFreeBytes,
    minFreeBytes: REPO_CACHE_MIN_FREE_BYTES,
  };
}

async function canWrite(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isMountPoint(mounts: string, mountPath: string): boolean {
  return mounts
    .split('\n')
    .some((line) => line.split(' ')[1] === mountPath);
}

export async function checkStorageHealth(
  overrides: Partial<StorageHealthDependencies> = {},
): Promise<StorageHealthReport> {
  const deps = { ...defaultDependencies(), ...overrides };
  const workspaceDir = path.join(deps.dataRoot, 'workspaces');

  const dataRoot: StorageCheckResult = (await canWrite(deps.dataRoot)) ? 'ok' : 'failed';

  let workspaceMount: StorageCheckResult = 'failed';
  try {
    const mounted = !deps.requireWorkspaceMount
      || isMountPoint(await deps.readMounts(), workspaceDir);
    if (mounted && (await canWrite(workspaceDir))) workspaceMount = 'ok';
  } catch {
    workspaceMount = 'failed';
  }

  let freeSpace: StorageCheckResult = 'failed';
  try {
    if ((await deps.readFreeBytes(deps.dataRoot)) >= deps.minFreeBytes) freeSpace = 'ok';
  } catch {
    freeSpace = 'failed';
  }

  const checks = { dataRoot, workspaceMount, freeSpace };
  const failed = Object.values(checks).includes('failed');
  if (failed) {
    console.error(`[storage-health] failed ${JSON.stringify(checks)}`);
  }
  return { status: failed ? 'failed' : 'ok', checks };
}
