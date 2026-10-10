/**
 * Collect attempt-local workspace outputs that App Service may persist.
 * Only regular files under `.ai-pilot/output/**` and
 * `.ai-pilot/kickoff-transcript.md` are eligible.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ALLOWED_TRANSCRIPT = path.posix.join('.ai-pilot', 'kickoff-transcript.md');
const ALLOWED_OUTPUT_PREFIX = path.posix.join('.ai-pilot', 'output');

export type CollectedInteractiveArtifact = Readonly<{
  /** Posix path relative to the workspace root. */
  relativePath: string;
  content: Buffer;
  sha256: string;
  sizeBytes: number;
}>;

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function assertAllowedRelativePath(relativePath: string): string {
  const normalized = toPosix(relativePath).replace(/^\.\//, '');
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`Artifact path escapes workspace: ${relativePath}`);
  }
  if (
    normalized !== ALLOWED_TRANSCRIPT &&
    !normalized.startsWith(`${ALLOWED_OUTPUT_PREFIX}/`)
  ) {
    throw new Error(`Artifact path is not allowed: ${relativePath}`);
  }
  return normalized;
}

async function assertRegularFile(absolutePath: string): Promise<void> {
  const stat = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Artifact must not be a symlink: ${absolutePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Artifact must be a regular file: ${absolutePath}`);
  }
  // Reject hard links (nlink > 1) so collected bytes cannot alias another path.
  if (stat.nlink > 1) {
    throw new Error(`Artifact must not be a hard link: ${absolutePath}`);
  }
}

async function walkOutputDir(
  workspaceRoot: string,
  absoluteDir: string,
  collected: CollectedInteractiveArtifact[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await walkOutputDir(workspaceRoot, absolute, collected);
      continue;
    }
    const relative = assertAllowedRelativePath(
      path.relative(workspaceRoot, absolute),
    );
    await assertRegularFile(absolute);
    const content = await fs.readFile(absolute);
    collected.push({
      relativePath: relative,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.byteLength,
    });
  }
}

export async function collectInteractiveArtifacts(
  workspaceRoot: string,
): Promise<ReadonlyArray<CollectedInteractiveArtifact>> {
  const collected: CollectedInteractiveArtifact[] = [];
  const transcriptAbsolute = path.join(
    workspaceRoot,
    ...ALLOWED_TRANSCRIPT.split('/'),
  );
  try {
    await assertRegularFile(transcriptAbsolute);
    const content = await fs.readFile(transcriptAbsolute);
    collected.push({
      relativePath: ALLOWED_TRANSCRIPT,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.byteLength,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await walkOutputDir(
    workspaceRoot,
    path.join(workspaceRoot, '.ai-pilot', 'output'),
    collected,
  );
  return collected.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}
