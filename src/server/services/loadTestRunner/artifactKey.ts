const SAFE_SEGMENT = /^[a-zA-Z0-9._@-]+$/;

function assertSafeSegment(value: string, label: string): void {
  if (!value || !SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid load-test artifact ${label}`);
  }
}

export type LoadTestArtifactRefParts = {
  projectId: string;
  runId: string;
  fileName: string;
};

/** Blob key layout: {projectId}/{runId}/{fileName} (mirrors pdfArtifactStore). */
export function buildLoadTestArtifactKey(ref: LoadTestArtifactRefParts): string {
  assertSafeSegment(ref.projectId, 'projectId');
  assertSafeSegment(ref.runId, 'runId');
  assertSafeSegment(ref.fileName, 'fileName');
  return `${ref.projectId}/${ref.runId}/${ref.fileName}`;
}
