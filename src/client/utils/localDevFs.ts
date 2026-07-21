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
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritableFileStream>;
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

const textEncoder = new TextEncoder();

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
  try {
    if (handle.queryPermission) {
      const current = await handle.queryPermission(opts);
      if (current === 'granted') return true;
    }
    if (handle.requestPermission) {
      return (await handle.requestPermission(opts)) === 'granted';
    }
    // Picker already granted write when these methods are absent.
    return !handle.queryPermission && !handle.requestPermission;
  } catch {
    return false;
  }
}

async function pickRepoRoot(): Promise<FsDirectoryHandle> {
  const win = window as DirectoryPickerWindow;
  if (!win.showDirectoryPicker) {
    throw new Error('This browser cannot write files into a local folder. Download the ZIP instead.');
  }
  const handle = await win.showDirectoryPicker({
    id: 'ai-pilot-local-dev-repo',
    mode: 'readwrite',
  });
  await storeRepoHandle(handle);
  return handle;
}

/**
 * Prefer a remembered repo folder when permission is still granted; otherwise
 * prompt. Callers can force a fresh pick after a failed write.
 */
async function resolveRepoRoot(forcePick: boolean): Promise<FsDirectoryHandle> {
  if (!forcePick) {
    const stored = await loadStoredRepoHandle();
    if (stored && (await ensurePermission(stored))) {
      return stored;
    }
  }
  return pickRepoRoot();
}

async function ensureDirectory(
  root: FsDirectoryHandle,
  parts: string[],
): Promise<FsDirectoryHandle> {
  let dir = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create: true });
    } catch (err) {
      const msg = (err as Error).message || String(err);
      throw new Error(
        `Could not create folder "${parts.join('/')}" (failed at "${part}"): ${msg}`,
      );
    }
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
  let fileHandle: FsFileHandle;
  try {
    fileHandle = await dir.getFileHandle(fileName, { create: true });
  } catch (err) {
    throw new Error(`Could not create file "${relativePath}": ${(err as Error).message}`);
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  try {
    // Uint8Array is more reliable than raw strings for large HTML payloads.
    await writable.write(textEncoder.encode(content));
  } finally {
    await writable.close();
  }
}

async function readRelativeFile(
  root: FsDirectoryHandle,
  relativePath: string,
): Promise<string> {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid path: ${relativePath}`);
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return file.text();
}

export interface WriteLocalDevFilesResult {
  repoName: string;
  fileCount: number;
  extractPath: string;
  samplePath: string;
}

/**
 * Writes context-pack files into the user's chosen repository root using the
 * File System Access API. Verifies at least one file can be read back.
 */
export async function writeLocalDevFilesToRepo(
  files: ArtifactFile[],
  opts?: { forcePick?: boolean; extractPathHint?: string },
): Promise<WriteLocalDevFilesResult> {
  if (!files.length) {
    throw new Error('Context pack has no files to write.');
  }

  let root = await resolveRepoRoot(opts?.forcePick ?? false);
  const extractPath = opts?.extractPathHint
    ?? files[0]!.name.split('/').slice(0, 3).join('/')
    ?? '';

  const writeAll = async (target: FsDirectoryHandle) => {
    for (const file of files) {
      await writeRelativeFile(target, file.name, file.content);
    }
  };

  try {
    await writeAll(root);
  } catch (err) {
    // Stored handle may be stale / wrong folder — force a fresh pick once.
    if (!opts?.forcePick) {
      root = await pickRepoRoot();
      await writeAll(root);
    } else {
      throw err;
    }
  }

  // Prove bytes landed on disk before we tell the user / open the IDE.
  const sample = files.find((f) => f.name.endsWith('KICKOFF-PROMPT.md')) ?? files[0]!;
  let readBack: string;
  try {
    readBack = await readRelativeFile(root, sample.name);
  } catch (err) {
    throw new Error(
      `Wrote files into "${root.name}" but could not read them back (${sample.name}): ${(err as Error).message}`,
    );
  }
  if (readBack.length === 0 && sample.content.length > 0) {
    throw new Error(
      `Files appear empty after writing into "${root.name}". Pick the repository root and try again.`,
    );
  }

  return {
    repoName: root.name,
    fileCount: files.length,
    extractPath,
    samplePath: sample.name,
  };
}
