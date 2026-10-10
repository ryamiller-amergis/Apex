/**
 * Writes the immutable execution specification a V2 command points at.
 *
 * The command carries only a blob reference, so the queue never holds runtime
 * data and a redelivered command always reads the same instructions. The blob
 * is written with an if-none-match condition: re-dispatching the same attempt
 * reuses the existing specification instead of rewriting it.
 */
import { type ContainerClient } from '@azure/storage-blob';
import type { AiRunBlobRef } from '../../../shared/types/aiRunV2';
import {
  artifactContainerName,
  resolveArtifactContainerClient,
} from './artifactContainer';

export const SPECIFICATION_FILE_NAME = 'spec.json';

export type SpecificationWriter = {
  write(input: {
    runId: string;
    attemptNumber: number;
    specification: Record<string, unknown>;
  }): Promise<AiRunBlobRef>;
};

export function buildSpecificationKey(
  runId: string,
  attemptNumber: number,
): string {
  return `runs/${runId}/attempts/${attemptNumber}/${SPECIFICATION_FILE_NAME}`;
}

function isAlreadyExists(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  if (status === 409 || status === 412) return true;
  const code = (error as { code?: string } | null)?.code;
  return code === 'BlobAlreadyExists';
}

export function createSpecificationWriter(options?: {
  getContainerClient?: (containerName: string) => ContainerClient;
  containerName?: string;
}): SpecificationWriter {
  const getContainerClient =
    options?.getContainerClient ?? resolveArtifactContainerClient;
  const containerName = options?.containerName ?? artifactContainerName();

  return {
    async write({ runId, attemptNumber, specification }) {
      const key = buildSpecificationKey(runId, attemptNumber);
      const body = Buffer.from(JSON.stringify(specification), 'utf8');
      try {
        await getContainerClient(containerName)
          .getBlockBlobClient(key)
          .uploadData(body, {
            conditions: { ifNoneMatch: '*' },
            blobHTTPHeaders: { blobContentType: 'application/json' },
          });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      return { container: containerName, key };
    },
  };
}
