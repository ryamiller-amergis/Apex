import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunV2ArtifactManifest,
} from '../../shared/types/aiRunV2';
import {
  ArtifactManifestValidationError,
  manifestObjectKey,
  validateArtifactManifest,
} from '../services/aiRunV2/artifactManifest';

const validManifest: AiRunV2ArtifactManifest = {
  schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
  transport: 'servicebus-blob-v2',
  runId: 'run-1',
  attemptId: 'attempt-1',
  attemptNumber: 1,
  writtenAt: '2026-09-18T12:05:00.000Z',
  files: [
    {
      path: 'design-doc-design.md',
      sha256: 'A'.repeat(64),
      sizeBytes: 12,
      ref: {
        container: 'ai-run-artifacts',
        key: 'runs/run-1/attempts/1/design-doc-design.md',
      },
    },
  ],
};

describe('AI-run V2 artifact manifests', () => {
  it('normalizes a valid immutable manifest', () => {
    const normalized = validateArtifactManifest(validManifest);
    expect(normalized.files[0].sha256).toBe('a'.repeat(64));
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.files)).toBe(true);
    expect(Object.isFrozen(normalized.files[0])).toBe(true);
  });

  it('rejects absolute, traversal, and duplicate paths', () => {
    expect(() => validateArtifactManifest({
      ...validManifest,
      files: [{ ...validManifest.files[0], path: '/tmp/secret.md' }],
    })).toThrow(ArtifactManifestValidationError);
    expect(() => validateArtifactManifest({
      ...validManifest,
      files: [{ ...validManifest.files[0], path: '../escape.md' }],
    })).toThrow(/traversal/);
    expect(() => validateArtifactManifest({
      ...validManifest,
      files: [validManifest.files[0], validManifest.files[0]],
    })).toThrow(/Duplicate artifact path/);
  });

  it('rejects malformed digests, negative sizes, and unsupported transports', () => {
    expect(() => validateArtifactManifest({
      ...validManifest,
      files: [{ ...validManifest.files[0], sha256: 'not-a-digest' }],
    })).toThrow(/sha256/);
    expect(() => validateArtifactManifest({
      ...validManifest,
      files: [{ ...validManifest.files[0], sizeBytes: -1 }],
    })).toThrow(ArtifactManifestValidationError);
    expect(() => validateArtifactManifest({
      ...validManifest,
      transport: 'http-files-v1',
    })).toThrow(ArtifactManifestValidationError);
    expect(() => validateArtifactManifest({
      ...validManifest,
      attemptNumber: 0,
    })).toThrow(ArtifactManifestValidationError);
  });

  it('builds the canonical manifest object key', () => {
    expect(manifestObjectKey('run-1', 2)).toBe(
      'runs/run-1/attempts/2/manifest.json',
    );
    expect(() => manifestObjectKey('', 1)).toThrow(/runId/);
    expect(() => manifestObjectKey('run-1', 0)).toThrow(/attemptNumber/);
  });
});
