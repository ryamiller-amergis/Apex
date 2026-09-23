/**
 * Attempt-local pinned repository + attachment materialization for the
 * interactive actor host. The caller supplies the repository-preparation
 * timeout/abort signal; this module has no timer default.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ImmutableInteractiveAttachmentRef } from '../../../shared/types/durableInteractiveTurn';
import type { RepoReader } from '../../../shared/types/repoReader';

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILE_MODE = 0o600;

export type MaterializeInteractiveWorkspaceInput = Readonly<{
  /** Pinned SHA reader, or null when grounding is absent (empty workspace). */
  reader: RepoReader | null;
  destination: string;
  attachments: ReadonlyArray<ImmutableInteractiveAttachmentRef>;
  readAttachment: (
    attachment: ImmutableInteractiveAttachmentRef,
  ) => Promise<Buffer>;
  signal: AbortSignal;
}>;

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason =
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Interactive workspace materialization aborted');
    throw reason;
  }
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(
      `Interactive workspace path escapes destination: ${relativePath}`,
    );
  }
  return normalized;
}

function resolveUnderDestination(
  destination: string,
  relativePath: string,
): string {
  const normalized = normalizeRelativePath(relativePath);
  const target = path.resolve(destination, ...normalized.split('/'));
  const relative = path.relative(destination, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Interactive workspace path escapes destination: ${relativePath}`,
    );
  }
  return target;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function writeFileExclusive(
  target: string,
  body: Buffer | string,
  signal: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  await fs.mkdir(path.dirname(target), { recursive: true });
  assertNotAborted(signal);
  await fs.writeFile(target, body, { flag: 'wx', mode: FILE_MODE });
}

async function materializeRepository(
  reader: RepoReader,
  destination: string,
  signal: AbortSignal,
  dirPath = '',
): Promise<void> {
  assertNotAborted(signal);
  const entries = await reader.listDir(dirPath);
  for (const entry of entries) {
    assertNotAborted(signal);
    if (entry.name === '.git') continue;
    const relative = normalizeRelativePath(entry.path);
    if (entry.isFolder) {
      await materializeRepository(reader, destination, signal, relative);
      continue;
    }
    const content = await reader.readFile(relative);
    await writeFileExclusive(
      resolveUnderDestination(destination, relative),
      content,
      signal,
    );
  }
}

async function materializeAttachment(
  destination: string,
  attachment: ImmutableInteractiveAttachmentRef,
  readAttachment: MaterializeInteractiveWorkspaceInput['readAttachment'],
  signal: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  const bytes = await readAttachment(attachment);
  assertNotAborted(signal);
  if (bytes.byteLength !== attachment.sizeBytes) {
    throw new Error(
      `Attachment size mismatch for ${attachment.attachmentId}: expected ${attachment.sizeBytes}, got ${bytes.byteLength}`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== attachment.sha256) {
    throw new Error(
      `Attachment SHA-256 mismatch for ${attachment.attachmentId}`,
    );
  }

  const target = resolveUnderDestination(
    destination,
    attachment.materializedPath,
  );
  await writeFileExclusive(target, bytes, signal);

  const isDocx =
    attachment.name.toLowerCase().endsWith('.docx') ||
    attachment.contentType === DOCX_CONTENT_TYPE;
  if (!isDocx) return;

  try {
    assertNotAborted(signal);
    const extracted = await extractDocxText(bytes);
    const txtRelative = attachment.materializedPath.replace(/\.docx$/i, '.txt');
    await writeFileExclusive(
      resolveUnderDestination(destination, txtRelative),
      extracted,
      signal,
    );
  } catch (error) {
    console.warn(
      `[interactive] Failed to extract text from ${attachment.name}; keeping raw file`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Materialize a pinned repository tree and/or attachments into an attempt-local
 * directory. On any failure the destination directory is removed.
 */
export async function materializeInteractiveWorkspace(
  input: MaterializeInteractiveWorkspaceInput,
): Promise<void> {
  const { reader, destination, attachments, readAttachment, signal } = input;
  try {
    assertNotAborted(signal);
    await fs.mkdir(destination, { recursive: true });
    if (reader) {
      await materializeRepository(reader, destination, signal);
    }
    for (const attachment of attachments) {
      await materializeAttachment(
        destination,
        attachment,
        readAttachment,
        signal,
      );
    }
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
