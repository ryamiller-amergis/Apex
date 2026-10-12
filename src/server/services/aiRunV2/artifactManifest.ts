import {
  AI_RUN_V2_SCHEMA_VERSION,
  isAiRunV2ArtifactManifest,
  type AiRunV2ArtifactManifest,
  type AiRunV2ArtifactManifestEntry,
} from '../../../shared/types/aiRunV2';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export class ArtifactManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactManifestValidationError';
  }
}

function assertSafeRelativePath(filePath: string): void {
  if (!filePath.trim()) {
    throw new ArtifactManifestValidationError(
      'Artifact path must be non-empty'
    );
  }
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    throw new ArtifactManifestValidationError(
      `Artifact path must be relative: ${filePath}`
    );
  }
  if (filePath.includes('\\')) {
    throw new ArtifactManifestValidationError(
      `Artifact path must use forward slashes: ${filePath}`
    );
  }
  const segments = filePath.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new ArtifactManifestValidationError(
      `Artifact path must not contain empty or traversal segments: ${filePath}`
    );
  }
}

function normalizeEntry(
  entry: AiRunV2ArtifactManifestEntry
): AiRunV2ArtifactManifestEntry {
  assertSafeRelativePath(entry.path);
  if (!SHA256_PATTERN.test(entry.sha256)) {
    throw new ArtifactManifestValidationError(
      `Artifact sha256 must be a 64-character hex digest: ${entry.path}`
    );
  }
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
    throw new ArtifactManifestValidationError(
      `Artifact sizeBytes must be a non-negative integer: ${entry.path}`
    );
  }
  if (!entry.ref.container.trim() || !entry.ref.key.trim()) {
    throw new ArtifactManifestValidationError(
      `Artifact blob reference must include container and key: ${entry.path}`
    );
  }
  return Object.freeze({
    path: entry.path,
    sha256: entry.sha256.toLowerCase(),
    sizeBytes: entry.sizeBytes,
    ref: Object.freeze({
      container: entry.ref.container,
      key: entry.ref.key,
    }),
  });
}

/**
 * Validate and return an immutable artifact manifest.
 * Task 3 never reads or writes Blob storage.
 */
export function validateArtifactManifest(
  value: unknown
): AiRunV2ArtifactManifest {
  if (!isAiRunV2ArtifactManifest(value)) {
    throw new ArtifactManifestValidationError(
      'Artifact manifest failed closed schema validation'
    );
  }
  if (value.schemaVersion !== AI_RUN_V2_SCHEMA_VERSION) {
    throw new ArtifactManifestValidationError(
      `Unsupported artifact manifest schemaVersion: ${value.schemaVersion}`
    );
  }
  if (value.transport !== 'servicebus-blob-v2') {
    throw new ArtifactManifestValidationError(
      `Unsupported artifact manifest transport: ${value.transport}`
    );
  }
  if (!value.runId.trim() || !value.attemptId.trim()) {
    throw new ArtifactManifestValidationError(
      'Artifact manifest requires non-empty runId and attemptId'
    );
  }
  if (!Number.isInteger(value.attemptNumber) || value.attemptNumber <= 0) {
    throw new ArtifactManifestValidationError(
      'Artifact manifest attemptNumber must be a positive integer'
    );
  }

  const seenPaths = new Set<string>();
  const files = value.files.map((entry) => {
    const normalized = normalizeEntry(entry);
    if (seenPaths.has(normalized.path)) {
      throw new ArtifactManifestValidationError(
        `Duplicate artifact path: ${normalized.path}`
      );
    }
    seenPaths.add(normalized.path);
    return normalized;
  });

  return Object.freeze({
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    transport: 'servicebus-blob-v2',
    runId: value.runId,
    attemptId: value.attemptId,
    attemptNumber: value.attemptNumber,
    writtenAt: value.writtenAt,
    files: Object.freeze(files),
  });
}

export function manifestObjectKey(
  runId: string,
  attemptNumber: number
): string {
  if (!runId.trim()) {
    throw new ArtifactManifestValidationError('runId must be non-empty');
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new ArtifactManifestValidationError(
      'attemptNumber must be a positive integer'
    );
  }
  return `runs/${runId}/attempts/${attemptNumber}/manifest.json`;
}
