/**
 * Reads the immutable execution specification a command points at.
 *
 * The command carries only a blob reference, so runtime data never travels on
 * the queue and a redelivered command always reads the same specification.
 */
import { type ContainerClient } from '@azure/storage-blob';
import type { AiRunBlobRef } from '../../../shared/types/aiRunV2';
import type { AiRunV2DocumentSpecification } from '../../../shared/types/aiRunV2DocumentSpec';
import type { AiRunV2VisualSpecification } from '../../../shared/types/aiRunV2VisualSpec';
import { resolveArtifactContainerClient } from '../aiRunV2/artifactContainer';

/**
 * The document lane repeats the run identity in its specification. Newer
 * lane-specific specifications do not: the command envelope already carries
 * it, so duplicating it invites the two copies to disagree.
 */
export type LegacyExecutionSpecification = Readonly<{
  runId: string;
  attemptId: string;
  attemptNumber: number;
  workloadLane: string;
  prompt?: string;
  model?: string;
  repository?: Record<string, unknown>;
  [key: string]: unknown;
}>;

export type ExecutionSpecification =
  | LegacyExecutionSpecification
  | AiRunV2DocumentSpecification
  | AiRunV2VisualSpecification;

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
