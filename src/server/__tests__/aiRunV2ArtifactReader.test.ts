import { createHash } from 'node:crypto';
import type { ContainerClient } from '@azure/storage-blob';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunV2ArtifactManifest,
} from '../../shared/types/aiRunV2';
import {
  ArtifactVerificationError,
  createArtifactReader,
} from '../services/aiRunV2/artifactReader';

const HTML = '<html>prototype</html>';
const HTML_SHA = createHash('sha256').update(Buffer.from(HTML, 'utf8')).digest('hex');

const manifest: AiRunV2ArtifactManifest = {
  schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
  transport: 'servicebus-blob-v2',
  runId: 'run-1',
  attemptId: 'attempt-1',
  attemptNumber: 1,
  files: [
    {
      path: 'prototype.html',
      sha256: HTML_SHA,
      sizeBytes: Buffer.byteLength(HTML, 'utf8'),
      ref: {
        container: 'ai-run-artifacts',
        key: 'runs/run-1/attempts/1/prototype.html',
      },
    },
  ],
  writtenAt: '2026-09-18T12:00:00.000Z',
};

function containerReturning(
  bodyByKey: Record<string, string>,
): (containerName: string) => ContainerClient {
  return () =>
    ({
      getBlockBlobClient: (key: string) => ({
        downloadToBuffer: async () => {
          const body = bodyByKey[key];
          if (body === undefined) throw new Error(`missing blob ${key}`);
          return Buffer.from(body, 'utf8');
        },
      }),
    }) as unknown as ContainerClient;
}

describe('artifactReader', () => {
  const manifestRef = {
    container: 'ai-run-artifacts',
    key: 'runs/run-1/attempts/1/manifest.json',
  };

  it('reads a manifest and returns the verified file contents', async () => {
    const reader = createArtifactReader({
      getContainerClient: containerReturning({
        [manifestRef.key]: JSON.stringify(manifest),
        'runs/run-1/attempts/1/prototype.html': HTML,
      }),
    });

    const read = await reader.readManifest(manifestRef);
    await expect(reader.readText(read, 'prototype.html')).resolves.toBe(HTML);
  });

  it('refuses a manifest that does not match the contract', async () => {
    const reader = createArtifactReader({
      getContainerClient: containerReturning({
        [manifestRef.key]: JSON.stringify({ schemaVersion: 1 }),
      }),
    });

    await expect(reader.readManifest(manifestRef)).rejects.toBeInstanceOf(
      ArtifactVerificationError,
    );
  });

  it('refuses a file whose bytes no longer match the recorded checksum', async () => {
    const reader = createArtifactReader({
      getContainerClient: containerReturning({
        'runs/run-1/attempts/1/prototype.html': '<html>tampered</html>',
      }),
    });

    await expect(reader.readFile(manifest.files[0])).rejects.toThrow(
      'failed checksum verification',
    );
  });

  it('refuses a file whose length disagrees with the manifest', async () => {
    const shortBody = 'x';
    const reader = createArtifactReader({
      getContainerClient: containerReturning({
        'runs/run-1/attempts/1/prototype.html': shortBody,
      }),
    });

    await expect(
      reader.readFile({
        ...manifest.files[0],
        sha256: createHash('sha256')
          .update(Buffer.from(shortBody, 'utf8'))
          .digest('hex'),
      }),
    ).rejects.toThrow('manifest says');
  });

  it('names the missing path when a manifest has no such file', async () => {
    const reader = createArtifactReader({
      getContainerClient: containerReturning({}),
    });

    await expect(reader.readText(manifest, 'absent.html')).rejects.toThrow(
      'no file at absent.html',
    );
  });
});
