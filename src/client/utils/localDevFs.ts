import type { ArtifactFile } from './artifactDownload';

const IDB_NAME = 'ai-pilot-local-dev';
const IDB_STORE = 'handles';
const IDB_KEY = 'repoRoot';

/** Minimal FS Access types — full DOM lib coverage varies by TS version. */
interface FsPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FsDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  queryPermission?(descriptor?: FsPermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FsPermissionDescriptor): Promise<PermissionState>;
}

interface FsFileHandle {
  readonly kind: 'file';
  createWritable(): Promise<FsWritableFileStream>;
}

interface FsWritableFileStream {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  }) => Promise<FsDirectoryHandle>;
};

export function canWriteLocalDevFiles(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

async function loadStoredRepoHandle(): Promise<FsDirectoryHandle | null> {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as FsDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('Failed to read stored directory handle'));
    });
  } catch {
    return null;
  }
}

async function storeRepoHandle(handle: FsDirectoryHandle): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store directory handle'));
    });
  } catch {
    // Non-fatal — user can re-pick next time.
  }
}

async function ensurePermission(handle: FsDirectoryHandle): Promise<boolean> {
  const opts: FsPermissionDescriptor = { mode: 'readwrite' };
  if (handle.queryPermission && (await handle.queryPermission(opts)) === 'granted') return true;
  if (handle.requestPermission && (await handle.requestPermission(opts)) === 'granted') return true;
  // Some browsers grant write via showDirectoryPicker without these methods.
  if (!handle.queryPermission && !handle.requestPermission) return true;
  return false;
}

async function resolveRepoRoot(forcePick: boolean): Promise<FsDirectoryHandle> {
  const win = window as DirectoryPickerWindow;
  if (!win.showDirectoryPicker) {
    throw new Error('This browser cannot write files into a local folder. Download the ZIP instead.');
  }

  if (!forcePick) {
    const stored = await loadStoredRepoHandle();
    if (stored && (await ensurePermission(stored))) {
      return stored;
    }
  }

  const handle = await win.showDirectoryPicker({
    id: 'ai-pilot-local-dev-repo',
    mode: 'readwrite',
  });
  await storeRepoHandle(handle);
  return handle;
}

async function ensureDirectory(
  root: FsDirectoryHandle,
  parts: string[],
): Promise<FsDirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function writeRelativeFile(
  root: FsDirectoryHandle,
  relativePath: string,
  content: string,
): Promise<void> {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return;
  const fileName = parts.pop()!;
  const dir = await ensureDirectory(root, parts);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

export interface WriteLocalDevFilesResult {
  repoName: string;
  fileCount: number;
  extractPath: string;
}

/**
 * Writes context-pack files into the user's chosen repository root using the
 * File System Access API. Remembers the folder for subsequent runs.
 */
export async function writeLocalDevFilesToRepo(
  files: ArtifactFile[],
  opts?: { forcePick?: boolean; extractPathHint?: string },
): Promise<WriteLocalDevFilesResult> {
  const root = await resolveRepoRoot(opts?.forcePick ?? false);
  for (const file of files) {
    await writeRelativeFile(root, file.name, file.content);
  }
  return {
    repoName: root.name,
    fileCount: files.length,
    extractPath: opts?.extractPathHint ?? files[0]?.name.split('/').slice(0, 3).join('/') ?? '',
  };
}
