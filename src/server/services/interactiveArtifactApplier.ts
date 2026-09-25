/**
 * App Service side: verify an actor artifact manifest and apply files beneath
 * the thread workspace. Never runs Cursor/model.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AiRunBlobRef,
  AiRunV2ArtifactManifest,
  AiRunV2ArtifactManifestEntry,
} from '../../shared/types/aiRunV2';

const ALLOWED_TRANSCRIPT = path.posix.join('.ai-pilot', 'kickoff-transcript.md');
const ALLOWED_OUTPUT_PREFIX = path.posix.join('.ai-pilot', 'output');

export class InteractiveArtifactApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractiveArtifactApplyError';
  }
}

export type InteractiveArtifactReader = {
  readFile(entry: AiRunV2ArtifactManifestEntry): Promise<Buffer>;
};

function assertAllowedPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new InteractiveArtifactApplyError(
      `Artifact path escapes workspace: ${relativePath}`,
    );
  }
  if (
    normalized !== ALLOWED_TRANSCRIPT &&
    !normalized.startsWith(`${ALLOWED_OUTPUT_PREFIX}/`)
  ) {
    throw new InteractiveArtifactApplyError(
      `Artifact path is not allowed: ${relativePath}`,
    );
  }
  return normalized;
}

function resolveUnderWorkspace(
  workspaceRoot: string,
  relativePath: string,
): string {
  const normalized = assertAllowedPath(relativePath);
  const target = path.resolve(workspaceRoot, ...normalized.split('/'));
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new InteractiveArtifactApplyError(
      `Artifact path escapes workspace: ${relativePath}`,
    );
  }
  return target;
}

export function assertInteractiveArtifactManifestIdentity(
  manifest: AiRunV2ArtifactManifest,
  expected: Readonly<{
    runId: string;
    attemptId: string;
    attemptNumber: number;
  }>,
): void {
  if (
    manifest.runId !== expected.runId ||
    manifest.attemptId !== expected.attemptId ||
    manifest.attemptNumber !== expected.attemptNumber
  ) {
    throw new InteractiveArtifactApplyError(
      'Artifact manifest identity does not match the finished attempt',
    );
  }
}

/**
 * Download, checksum-verify, and write each manifest entry beneath the thread
 * workspace. Writes use exclusive create (`wx`) with mode 0600.
 */
export async function applyInteractiveArtifacts(options: {
  workspaceRoot: string;
  manifest: AiRunV2ArtifactManifest;
  expected: Readonly<{
    runId: string;
    attemptId: string;
    attemptNumber: number;
  }>;
  reader: InteractiveArtifactReader;
}): Promise<void> {
  assertInteractiveArtifactManifestIdentity(options.manifest, options.expected);

  for (const entry of options.manifest.files) {
    const target = resolveUnderWorkspace(
      options.workspaceRoot,
      entry.path.startsWith('.ai-pilot/')
        ? entry.path
        : path.posix.join('.ai-pilot', entry.path),
    );
    const body = await options.reader.readFile(entry);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== entry.sha256 || body.byteLength !== entry.sizeBytes) {
      throw new InteractiveArtifactApplyError(
        `Artifact checksum mismatch for ${entry.path}`,
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { flag: 'wx', mode: 0o600 });
  }
}

/** Convenience: build a Blob-backed reader using an injectable download fn. */
export function createBlobInteractiveArtifactReader(
  download: (ref: AiRunBlobRef) => Promise<Buffer>,
): InteractiveArtifactReader {
  return {
    async readFile(entry) {
      return download(entry.ref);
    },
  };
}
