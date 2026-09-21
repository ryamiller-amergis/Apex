/**
 * Reads the immutable execution specification a command points at.
 *
 * The command carries only a blob reference, so runtime data never travels on
 * the queue and a redelivered command always reads the same specification.
 */
import { type ContainerClient } from '@azure/storage-blob';
import type { AiRunBlobRef } from '../../../shared/types/aiRunV2';
import { resolveArtifactContainerClient } from '../aiRunV2/artifactContainer';

export type ExecutionSpecification = Readonly<{
  runId: string;
  attemptId: string;
  attemptNumber: number;
  workloadLane: string;
  prompt?: string;
  model?: string;
  repository?: Record<string, unknown>;
  [key: string]: unknown;
}>;

export type SpecificationClient = {
  read(ref: AiRunBlobRef): Promise<ExecutionSpecification>;
};

export function createSpecificationClient(options?: {
  getContainerClient?: (containerName: string) => ContainerClient;
}): SpecificationClient {
  const getContainerClient =
    options?.getContainerClient ?? resolveArtifactContainerClient;

  return {
    async read(ref) {
      const blob = getContainerClient(ref.container).getBlockBlobClient(
        ref.key,
      );
      const downloaded = await blob.downloadToBuffer();
      const parsed = JSON.parse(downloaded.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Execution specification ${ref.key} is not an object`);
      }
      return parsed as ExecutionSpecification;
    },
  };
}
