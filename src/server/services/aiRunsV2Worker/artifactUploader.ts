/**
 * Attempt-scoped immutable artifact upload.
 *
 * Every file lands under runs/{runId}/attempts/{attemptNumber}/, so a retry
 * writes a fresh prefix and never overwrites a previous attempt's output. The
 * manifest is written last: its presence is what marks the set complete.
 */
import { createHash } from 'node:crypto';
import { type ContainerClient } from '@azure/storage-blob';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunBlobRef,
  type AiRunV2ArtifactManifest,
  type AiRunV2ArtifactManifestEntry,
} from '../../../shared/types/aiRunV2';
import { resolveArtifactContainerClient } from '../aiRunV2/artifactContainer';

export const MANIFEST_FILE_NAME = 'manifest.json';

export type ArtifactFile = Readonly<{
  /** Path relative to the attempt prefix, e.g. `output/design.md`. */
  path: string;
  content: Buffer | string;
  contentType?: string;
}>;

export type UploadTarget = Readonly<{
  runId: string;
  attemptId: string;
  attemptNumber: number;
  container: string;
}>;

export type ArtifactUploader = {
  attemptPrefix(): string;
  uploadAll(files: ReadonlyArray<ArtifactFile>): Promise<AiRunBlobRef>;
};

export function buildAttemptPrefix(
  runId: string,
  attemptNumber: number,
): string {
  return `runs/${runId}/attempts/${attemptNumber}`;
}

export function createArtifactUploader(deps: {
  target: UploadTarget;
  getContainerClient?: (containerName: string) => ContainerClient;
  now?: () => Date;
}): ArtifactUploader {
  const getContainerClient =
    deps.getContainerClient ?? resolveArtifactContainerClient;
  const now = deps.now ?? (() => new Date());
  const prefix = buildAttemptPrefix(deps.target.runId, deps.target.attemptNumber);

  return {
    attemptPrefix() {
      return prefix;
    },

    async uploadAll(files) {
      const container = getContainerClient(deps.target.container);
      const entries: AiRunV2ArtifactManifestEntry[] = [];

      for (const file of files) {
        const body =
          typeof file.content === 'string'
            ? Buffer.from(file.content, 'utf8')
            : file.content;
        const key = `${prefix}/${file.path}`;
        await container.getBlockBlobClient(key).uploadData(body, {
          blobHTTPHeaders: {
            blobContentType: file.contentType ?? 'application/octet-stream',
          },
        });
        entries.push({
          path: file.path,
          sha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.byteLength,
          ref: { container: deps.target.container, key },
        });
      }

      const manifest: AiRunV2ArtifactManifest = {
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        transport: 'servicebus-blob-v2',
        runId: deps.target.runId,
        attemptId: deps.target.attemptId,
        attemptNumber: deps.target.attemptNumber,
        files: entries,
        writtenAt: now().toISOString(),
      };
      const manifestKey = `${prefix}/${MANIFEST_FILE_NAME}`;
      await container
        .getBlockBlobClient(manifestKey)
        .uploadData(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), {
          blobHTTPHeaders: { blobContentType: 'application/json' },
        });

      return { container: deps.target.container, key: manifestKey };
    },
  };
}
