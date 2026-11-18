/**
 * Corrected-artifact and regression-snapshot blobs for workflow evaluation.
 * Objects live in the shared artifact container under a stable prefix.
 */
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import type { SkillRegressionSnapshotDocument } from '../../shared/types/skillRegressionCase';
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

export function regressionSnapshotBlobKey(project: string, eventId: string): string {
  return `workflow-evaluations/${encodeURIComponent(project)}/${eventId}/original-artifact.json`;
}

export async function writeRegressionSnapshot(
  project: string,
  snapshot: SkillRegressionSnapshotDocument,
): Promise<AiRunBlobRef> {
  const container = artifactContainerName();
  const key = regressionSnapshotBlobKey(project, snapshot.eventId);
  const client = resolveArtifactContainerClient(container);
  const body = Buffer.from(JSON.stringify(snapshot), 'utf8');
  await client.getBlockBlobClient(key).upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
  });
  return { container, key };
}

/** Matches the 1 MB cap on what a reviewer can submit. */
const READ_MAX_BYTES = 1024 * 1024;

async function readBlobText(ref: AiRunBlobRef): Promise<string> {
  const body = await resolveArtifactContainerClient(ref.container).getBlockBlobClient(ref.key).downloadToBuffer();
  return body.subarray(0, READ_MAX_BYTES).toString('utf8');
}

export function readCorrectedArtifact(ref: AiRunBlobRef): Promise<string> {
  return readBlobText(ref);
}

export async function readRegressionSnapshot(ref: AiRunBlobRef): Promise<SkillRegressionSnapshotDocument> {
  return JSON.parse(await readBlobText(ref)) as SkillRegressionSnapshotDocument;
}

/** The document text a reviewer could have corrected, from a regression snapshot. */
export function snapshotText(snapshot: SkillRegressionSnapshotDocument): string | null {
  const { artifact } = snapshot;
  switch (artifact.subjectType) {
    case 'prd':
      return artifact.markdown;
    case 'design_doc':
      return [artifact.designContent, artifact.techSpecContent, artifact.assumptionsContent].join('\n\n');
    case 'test_cases':
      return artifact.testCasesMd;
    case 'interview_phase':
      return null;
    default: {
      const unhandled: never = artifact;
      return unhandled;
    }
  }
}

export async function deleteCorrectedArtifact(ref: AiRunBlobRef): Promise<void> {
  const client = resolveArtifactContainerClient(ref.container);
  await client.getBlockBlobClient(ref.key).deleteIfExists();
}
