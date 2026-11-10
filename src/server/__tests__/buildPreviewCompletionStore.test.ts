import type { BuildPreviewCompletionEvidenceReader } from '../services/build/buildPreviewCompletionStore';
import { createBuildPreviewCompletionPort } from '../services/build/buildPreviewCompletionStore';
import { evaluateBuildPreviewCompletion } from '../services/build/buildPreviewCompletionInvariant';

const REVISION_ID = '00000000-0000-4000-8000-000000000101';
const ARTIFACT_ID = '00000000-0000-4000-8000-000000000102';
const INSTANCE_ID = '00000000-0000-4000-8000-000000000103';
const BROWSER_CHECK_ID = '00000000-0000-4000-8000-000000000104';
const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function createReader(
  overrides: Partial<BuildPreviewCompletionEvidenceReader> = {},
): BuildPreviewCompletionEvidenceReader {
  return {
    loadRevision: async () => ({
      id: REVISION_ID,
      validatedCommit: COMMIT,
      previewRolloutMode: 'live',
    }),
    loadArtifact: async () => ({
      id: ARTIFACT_ID,
      buildRevisionId: REVISION_ID,
      commit: COMMIT,
      digest: DIGEST,
    }),
    loadLatestReadyInstance: async () => ({
      id: INSTANCE_ID,
      buildPreviewArtifactId: ARTIFACT_ID,
      commit: COMMIT,
      artifactDigest: DIGEST,
      state: 'ready',
      readinessStatus: 'passed',
    }),
    loadLatestBrowserCheck: async () => ({
      id: BROWSER_CHECK_ID,
      buildPreviewInstanceId: INSTANCE_ID,
      commit: COMMIT,
      artifactDigest: DIGEST,
      status: 'passed',
    }),
    ...overrides,
  };
}

describe('build preview completion evidence store', () => {
  it('returns the revision-pinned legacy gate without loading live evidence', async () => {
    let artifactLoads = 0;
    const reader = createReader({
      loadRevision: async () => ({
        id: REVISION_ID,
        validatedCommit: COMMIT,
        previewRolloutMode: 'legacy_static',
      }),
      loadArtifact: async () => {
        artifactLoads += 1;
        return null;
      },
    });

    const result = await createBuildPreviewCompletionPort(reader).loadGate({
      revisionId: REVISION_ID,
      project: 'Apex',
      repository: 'apex',
    });

    expect(result).toEqual({ mode: 'legacy_static', evidence: null });
    expect(artifactLoads).toBe(0);
  });

  it('returns incomplete live evidence when no artifact exists', async () => {
    const result = await createBuildPreviewCompletionPort(createReader({
      loadArtifact: async () => null,
    })).loadGate({
      revisionId: REVISION_ID,
      project: 'Apex',
      repository: 'apex',
    });

    expect(result.mode).toBe('live');
    expect(result.evidence?.artifact).toBeNull();
    expect(evaluateBuildPreviewCompletion({
      mode: result.mode,
      expectedRevisionId: REVISION_ID,
      expectedCommit: COMMIT,
      evidence: result.evidence,
    })).toEqual({ satisfied: false, reason: 'missing_artifact' });
  });

  it('loads a matching artifact, ready instance, readiness, and browser chain', async () => {
    const result = await createBuildPreviewCompletionPort(createReader()).loadGate({
      revisionId: REVISION_ID,
      project: 'Apex',
      repository: 'apex',
    });

    expect(evaluateBuildPreviewCompletion({
      mode: result.mode,
      expectedRevisionId: REVISION_ID,
      expectedCommit: COMMIT,
      evidence: result.evidence,
    })).toEqual({ satisfied: true });
  });

  it('uses the latest browser result so a newer failure blocks completion', async () => {
    let loadedInstanceId: string | null = null;
    const reader = createReader({
      loadLatestBrowserCheck: async (instanceId) => {
        loadedInstanceId = instanceId;
        return {
          id: BROWSER_CHECK_ID,
          buildPreviewInstanceId: INSTANCE_ID,
          commit: COMMIT,
          artifactDigest: DIGEST,
          status: 'failed',
        };
      },
    });

    const result = await createBuildPreviewCompletionPort(reader).loadGate({
      revisionId: REVISION_ID,
      project: 'Apex',
      repository: 'apex',
    });

    expect(evaluateBuildPreviewCompletion({
      mode: result.mode,
      expectedRevisionId: REVISION_ID,
      expectedCommit: COMMIT,
      evidence: result.evidence,
    })).toEqual({ satisfied: false, reason: 'browser_check_not_passed' });
    expect(loadedInstanceId).toBe(INSTANCE_ID);
  });

  it('throws when the requested revision does not belong to the project repository', async () => {
    const port = createBuildPreviewCompletionPort(createReader({
      loadRevision: async () => null,
    }));

    await expect(port.loadGate({
      revisionId: REVISION_ID,
      project: 'Other',
      repository: 'other-repo',
    })).rejects.toThrow(`Build revision ${REVISION_ID} was not found`);
  });
});
