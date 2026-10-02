/**
 * Reads finished V2 artifacts back out of Blob.
 *
 * Domain knowledge stays with the owning service: this returns verified bytes
 * for a manifest entry and says nothing about what the file means. Every read
 * is checked against the sha256 the worker recorded, so a truncated or
 * replaced blob is a hard error rather than silently wrong output.
 */
import { createHash } from 'node:crypto';
import { type ContainerClient } from '@azure/storage-blob';
import {
  isAiRunV2ArtifactManifest,
  type AiRunBlobRef,
  type AiRunV2ArtifactManifest,
  type AiRunV2ArtifactManifestEntry,
} from '../../../shared/types/aiRunV2';
import { resolveArtifactContainerClient } from './artifactContainer';

export class ArtifactVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactVerificationError';
  }
}

export type ArtifactReader = {
  readManifest(ref: AiRunBlobRef): Promise<AiRunV2ArtifactManifest>;
  readFile(entry: AiRunV2ArtifactManifestEntry): Promise<Buffer>;
  readText(
    manifest: AiRunV2ArtifactManifest,
    path: string,
  ): Promise<string>;
};

export function createArtifactReader(options?: {
  getContainerClient?: (containerName: string) => ContainerClient;
}): ArtifactReader {
  const getContainerClient =
    options?.getContainerClient ?? resolveArtifactContainerClient;

  async function download(ref: AiRunBlobRef): Promise<Buffer> {
    return getContainerClient(ref.container)
      .getBlockBlobClient(ref.key)
      .downloadToBuffer();
  }

  const reader: ArtifactReader = {
    async readManifest(ref) {
      const parsed = JSON.parse((await download(ref)).toString('utf8'));
      if (!isAiRunV2ArtifactManifest(parsed)) {
        throw new ArtifactVerificationError(
          `Artifact manifest ${ref.key} does not match the V2 contract`,
        );
      }
      return parsed;
    },

    async readFile(entry) {
      const body = await download(entry.ref);
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== entry.sha256) {
        throw new ArtifactVerificationError(
          `Artifact ${entry.path} failed checksum verification`,
        );
      }
      if (body.byteLength !== entry.sizeBytes) {
        throw new ArtifactVerificationError(
          `Artifact ${entry.path} is ${body.byteLength} bytes, manifest says ${entry.sizeBytes}`,
        );
      }
      return body;
    },

    async readText(manifest, path) {
      const entry = manifest.files.find((file) => file.path === path);
      if (!entry) {
        throw new ArtifactVerificationError(
          `Artifact manifest has no file at ${path}`,
        );
      }
      return (await reader.readFile(entry)).toString('utf8');
    },
  };

  return reader;
}
