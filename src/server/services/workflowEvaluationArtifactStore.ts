/**
 * Corrected-artifact blobs for workflow evaluation.
 * Objects live in the shared artifact container under a stable prefix.
 */
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import {
  artifactContainerName,
  resolveArtifactContainerClient,
} from './aiRunV2/artifactContainer';

export function correctedArtifactBlobKey(project: string, eventId: string): string {
  return `workflow-evaluations/${encodeURIComponent(project)}/${eventId}/corrected-artifact.md`;
}

export async function writeCorrectedArtifact(
  project: string,
  eventId: string,
  text: string,
): Promise<AiRunBlobRef> {
  const container = artifactContainerName();
  const key = correctedArtifactBlobKey(project, eventId);
  const client = resolveArtifactContainerClient(container);
  const body = Buffer.from(text, 'utf8');
  await client.getBlockBlobClient(key).upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: 'text/markdown; charset=utf-8' },
  });
  return { container, key };
}

export async function deleteCorrectedArtifact(ref: AiRunBlobRef): Promise<void> {
  const client = resolveArtifactContainerClient(ref.container);
  await client.getBlockBlobClient(ref.key).deleteIfExists();
}
