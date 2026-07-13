import fs from 'fs';
import path from 'path';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { devSessions } from '../db/schema';
import { resolveDataRoot } from '../utils/dataDir';
import { withRepoCacheLease } from './repoCacheLeaseService';

const STALE_SETUP_MS = 2 * 60 * 60 * 1000;
const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['closed', 'failed', 'completed']);

interface CleanupSession {
  id: string;
  status: string;
  updatedAt: string;
}

export interface DevWorkspaceCleanupStore {
  listSessions(sessionIds: string[]): Promise<CleanupSession[]>;
  markStaleSetupFailed(sessionId: string, staleBefore: string): Promise<boolean>;
}

export interface DevWorkspaceCleanupFileSystem {
  listDirectories(root: string): Promise<string[]>;
  modifiedAt(directory: string): Promise<number>;
  rm(directory: string): Promise<void>;
}

export interface DevWorkspaceCleanupOptions {
  workspaceRoot?: string;
  nowMs?: number;
  store?: DevWorkspaceCleanupStore;
  fileSystem?: DevWorkspaceCleanupFileSystem;
}

const postgresStore: DevWorkspaceCleanupStore = {
  async listSessions(sessionIds) {
    const rows: CleanupSession[] = [];
    for (let index = 0; index < sessionIds.length; index += 500) {
      const chunk = sessionIds.slice(index, index + 500);
      rows.push(...await db
        .select({
          id: devSessions.id,
          status: devSessions.status,
          updatedAt: devSessions.updatedAt,
        })
        .from(devSessions)
        .where(inArray(devSessions.id, chunk)));
    }
    return rows;
  },

  async markStaleSetupFailed(sessionId, staleBefore) {
    const [updated] = await db
      .update(devSessions)
      .set({
        status: 'failed',
        setupError: 'Workspace setup was interrupted and did not recover.',
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        eq(devSessions.id, sessionId),
        eq(devSessions.status, 'setting_up'),
        lt(devSessions.updatedAt, staleBefore),
      ))
      .returning({ id: devSessions.id });
    return Boolean(updated);
  },
};

const nodeFileSystem: DevWorkspaceCleanupFileSystem = {
  async listDirectories(root) {
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  },

  async modifiedAt(directory) {
    return (await fs.promises.stat(directory)).mtimeMs;
  },

  async rm(directory) {
    await fs.promises.rm(directory, { recursive: true, force: true });
  },
};

export async function cleanupStaleDevWorkspaces(
  options: DevWorkspaceCleanupOptions = {},
): Promise<{ scanned: number; removed: number }> {
  const workspaceRoot = options.workspaceRoot
    ?? path.join(resolveDataRoot(), 'dev-workspaces');
  const nowMs = options.nowMs ?? Date.now();
  const store = options.store ?? postgresStore;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const staleSetupBefore = new Date(nowMs - STALE_SETUP_MS).toISOString();
  const orphanBefore = nowMs - ORPHAN_RETENTION_MS;
  const directories = await fileSystem.listDirectories(workspaceRoot);
  const sessions = new Map(
    (await store.listSessions(directories)).map((session) => [session.id, session]),
  );
  let removed = 0;

  for (const directoryName of directories) {
    const directory = path.join(workspaceRoot, directoryName);
    const session = sessions.get(directoryName);

    try {
      let shouldRemove = false;
      if (!session) {
        shouldRemove = (await fileSystem.modifiedAt(directory)) < orphanBefore;
      } else if (TERMINAL_STATUSES.has(session.status)) {
        shouldRemove = true;
      } else if (
        session.status === 'setting_up'
        && Date.parse(session.updatedAt) < Date.parse(staleSetupBefore)
      ) {
        shouldRemove = await store.markStaleSetupFailed(directoryName, staleSetupBefore);
      }

      if (shouldRemove) {
        await fileSystem.rm(directory);
        removed += 1;
        console.log(`[dev-workspace-cleanup] removed stale workspace ${directoryName}`);
      }
    } catch (err) {
      console.warn(
        `[dev-workspace-cleanup] failed to inspect/remove ${directoryName}:`,
        (err as Error).message,
      );
    }
  }

  return { scanned: directories.length, removed };
}

let cleanupInFlight: Promise<void> | null = null;
let lastCleanupStartedAt = 0;

export function scheduleStaleDevWorkspaceCleanup(): void {
  const now = Date.now();
  if (cleanupInFlight || now - lastCleanupStartedAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupStartedAt = now;
  cleanupInFlight = withRepoCacheLease(
    'dev-workspace-cleanup',
    () => cleanupStaleDevWorkspaces(),
    {
      leaseMs: 10 * 60 * 1000,
      heartbeatMs: 60 * 1000,
      waitMs: 0,
    },
  )
    .then(({ scanned, removed }) => {
      console.log(`[dev-workspace-cleanup] complete scanned=${scanned} removed=${removed}`);
    })
    .catch((err) => {
      console.warn('[dev-workspace-cleanup] run failed:', (err as Error).message);
    })
    .finally(() => {
      cleanupInFlight = null;
    });
}
