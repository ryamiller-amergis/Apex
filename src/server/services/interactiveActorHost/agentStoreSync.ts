/**
 * FEAT-002 / PBI-007 — Blob backup and restore of the per-thread Cursor SDK
 * agent store under `agent-store/<threadId>/` in the V2 artifact container.
 *
 * Pure Node + Azure Storage Blob with ZERO database imports so the V2
 * interactive actor host stays isolated from PostgreSQL.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  artifactContainerName,
  resolveArtifactContainerClient,
} from '../aiRunV2/artifactContainer';

export const AGENT_STORE_BLOB_PREFIX = 'agent-store';

export type AgentStoreRestoreStatus = 'local-present' | 'restored' | 'missing';

export interface AgentStoreBlobClient {
  listBlobs(prefix: string): AsyncIterable<string> | Promise<readonly string[]>;
  downloadBlob(key: string): Promise<Buffer>;
  uploadBlob(key: string, content: Buffer): Promise<void>;
}

export interface AgentStoreSync {
  restoreAgentStore(
    threadId: string,
    localWorkspaceDir: string,
  ): Promise<AgentStoreRestoreStatus>;
  backupAgentStore(
    threadId: string,
    localWorkspaceDir: string,
  ): Promise<number>;
}

const STANDALONE_STORE_FILE_RE = /\.(?:db|db-wal|db-shm|sqlite|sqlite3|jsonl)$/i;

export function agentStoreBlobPrefix(threadId: string): string {
  const safeId = threadId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${AGENT_STORE_BLOB_PREFIX}/${safeId}/`;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function assertSafeRelativeStorePath(relativePath: string): string {
  const normalized = toPosix(relativePath).replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    path.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Invalid agent store relative path: ${relativePath}`);
  }
  return normalized;
}

function resolveUnderWorkspace(
  workspaceDir: string,
  relativePath: string,
): string {
  const safeRelative = assertSafeRelativeStorePath(relativePath);
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, ...safeRelative.split('/'));
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Agent store path escapes workspace: ${relativePath}`);
  }
  return target;
}

async function assertNoSymlinkInPath(
  workspaceDir: string,
  target: string,
): Promise<void> {
  let current = path.resolve(workspaceDir);
  const rel = path.relative(current, path.resolve(target));
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Agent store path must not be a symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function collectFilesUnderDir(
  workspaceRoot: string,
  currentDir: string,
  collected: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectFilesUnderDir(workspaceRoot, absolute, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = toPosix(path.relative(workspaceRoot, absolute));
    collected.push(assertSafeRelativeStorePath(rel));
  }
}

async function collectLocalAgentStoreFiles(
  localWorkspaceDir: string,
): Promise<string[]> {
  const collected: string[] = [];
  await collectFilesUnderDir(
    localWorkspaceDir,
    path.join(localWorkspaceDir, '.cursor'),
    collected,
  );

  // Also detect direct SQLite/JSONL store files placed directly in a store root.
  let topEntries;
  try {
    topEntries = await fs.readdir(localWorkspaceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return collected;
    throw error;
  }
  for (const entry of topEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (STANDALONE_STORE_FILE_RE.test(entry.name)) {
      collected.push(assertSafeRelativeStorePath(entry.name));
    }
  }

  return collected.sort();
}

export function createDefaultAgentStoreBlobClient(
  env: NodeJS.ProcessEnv = process.env,
): AgentStoreBlobClient | null {
  const account = env.AI_PLATFORM_V2_BLOB_ACCOUNT_NAME?.trim();
  if (!account) return null;
  const container = resolveArtifactContainerClient(artifactContainerName(env));
  return {
    async *listBlobs(prefix: string): AsyncIterable<string> {
      for await (const item of container.listBlobsFlat({ prefix })) {
        yield item.name;
      }
    },
    async downloadBlob(key: string): Promise<Buffer> {
      return container.getBlockBlobClient(key).downloadToBuffer();
    },
    async uploadBlob(key: string, content: Buffer): Promise<void> {
      await container.getBlockBlobClient(key).uploadData(content);
    },
  };
}

async function materializeBlobKeys(
  iterable: AsyncIterable<string> | Promise<readonly string[]>,
): Promise<string[]> {
  if (typeof (iterable as Promise<readonly string[]>).then === 'function') {
    const list = await (iterable as Promise<readonly string[]>);
    return [...list];
  }
  const keys: string[] = [];
  for await (const key of iterable as AsyncIterable<string>) {
    keys.push(key);
  }
  return keys;
}

/**
 * Before resuming an agent, ensure the local SDK agent store exists.
 * - Returns `'local-present'` when store files already exist locally.
 * - Downloads blobs under `agent-store/<threadId>/` into `localWorkspaceDir`
 *   and returns `'restored'` when found in Blob storage.
 * - Returns `'missing'` when Blob storage is unconfigured, empty, or unreachable.
 */
export async function restoreAgentStore(
  threadId: string,
  localWorkspaceDir: string,
  store?: AgentStoreBlobClient,
): Promise<AgentStoreRestoreStatus> {
  const existing = await collectLocalAgentStoreFiles(localWorkspaceDir);
  if (existing.length > 0) {
    return 'local-present';
  }

  const client = store ?? createDefaultAgentStoreBlobClient();
  if (!client) {
    return 'missing';
  }

  const prefix = agentStoreBlobPrefix(threadId);
  let keys: string[];
  try {
    keys = await materializeBlobKeys(client.listBlobs(prefix));
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'AgentStoreRestoreListFailed',
        threadId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    return 'missing';
  }

  if (keys.length === 0) {
    return 'missing';
  }

  let restoredCount = 0;
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const relativePath = key.slice(prefix.length);
    if (!relativePath) continue;
    try {
      const target = resolveUnderWorkspace(localWorkspaceDir, relativePath);
      await assertNoSymlinkInPath(localWorkspaceDir, target);
      const data = await client.downloadBlob(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await assertNoSymlinkInPath(localWorkspaceDir, target);
      await fs.writeFile(target, data, { mode: 0o600 });
      restoredCount += 1;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'AgentStoreRestoreFileFailed',
          threadId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }

  return restoredCount > 0 ? 'restored' : 'missing';
}

/**
 * After a turn finishes, upload local SDK agent-store files to
 * `agent-store/<threadId>/`. Safe no-op (returns `0`) when Blob storage is
 * unconfigured or no store files exist.
 */
export async function backupAgentStore(
  threadId: string,
  localWorkspaceDir: string,
  store?: AgentStoreBlobClient,
): Promise<number> {
  const client = store ?? createDefaultAgentStoreBlobClient();
  if (!client) {
    return 0;
  }

  const files = await collectLocalAgentStoreFiles(localWorkspaceDir);
  if (files.length === 0) {
    return 0;
  }

  const prefix = agentStoreBlobPrefix(threadId);
  let uploadedCount = 0;
  for (const relativePath of files) {
    const absolutePath = resolveUnderWorkspace(localWorkspaceDir, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const content = await fs.readFile(absolutePath);
    await client.uploadBlob(`${prefix}${relativePath}`, content);
    uploadedCount += 1;
  }

  return uploadedCount;
}

export const defaultAgentStoreSync: AgentStoreSync = {
  restoreAgentStore: (threadId, localWorkspaceDir) =>
    restoreAgentStore(threadId, localWorkspaceDir),
  backupAgentStore: (threadId, localWorkspaceDir) =>
    backupAgentStore(threadId, localWorkspaceDir),
};
