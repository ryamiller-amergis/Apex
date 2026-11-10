import {
  evaluateBuildPreviewCompletion,
  type BuildPreviewCompletionEvidence,
} from '../services/build/buildPreviewCompletionInvariant';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function validEvidence(
  overrides: Partial<BuildPreviewCompletionEvidence> = {},
): BuildPreviewCompletionEvidence {
  return {
    revisionId: 'rev-1',
    validatedCommit: COMMIT,
    artifact: {
      revisionId: 'rev-1',
      commit: COMMIT,
      digest: DIGEST,
    },
    instance: {
      id: 'instance-1',
      revisionId: 'rev-1',
      commit: COMMIT,
      artifactDigest: DIGEST,
      state: 'ready',
    },
    readiness: {
      status: 'passed',
      revisionId: 'rev-1',
      instanceId: 'instance-1',
      artifactDigest: DIGEST,
    },
    browserCheck: {
      id: 'browser-check-1',
      status: 'passed',
      revisionId: 'rev-1',
      commit: COMMIT,
      instanceId: 'instance-1',
      artifactDigest: DIGEST,
    },
    ...overrides,
  };
}

describe('build preview completion invariant', () => {
  it('allows legacy static previews during migration without live evidence', () => {
    expect(
      evaluateBuildPreviewCompletion({
        mode: 'legacy_static',
        expectedRevisionId: 'rev-1',
        expectedCommit: COMMIT,
        evidence: null,
      }),
    ).toEqual({ satisfied: true });
  });

  it('requires all matching live evidence for the same revision', () => {
    expect(
      evaluateBuildPreviewCompletion({
        mode: 'live',
        expectedRevisionId: 'rev-1',
        expectedCommit: COMMIT,
        evidence: validEvidence(),
      }),
    ).toEqual({ satisfied: true });
  });

  it.each([
    ['missing_evidence', null],
    ['missing_artifact', validEvidence({ artifact: null })],
    ['missing_instance', validEvidence({ instance: null })],
    ['missing_readiness', validEvidence({ readiness: null })],
    ['missing_browser_check', validEvidence({ browserCheck: null })],
    [
      'instance_not_ready',
      validEvidence({
        instance: {
          ...validEvidence().instance!,
          state: 'starting',
        },
      }),
    ],
    [
      'readiness_not_passed',
      validEvidence({
        readiness: {
          ...validEvidence().readiness!,
          status: 'failed',
        },
      }),
    ],
    [
      'browser_check_not_passed',
      validEvidence({
        browserCheck: {
          ...validEvidence().browserCheck!,
          status: 'failed',
        },
      }),
    ],
    [
      'revision_mismatch',
      validEvidence({
        browserCheck: {
          ...validEvidence().browserCheck!,
          revisionId: 'rev-stale',
        },
      }),
    ],
    [
      'commit_mismatch',
      validEvidence({
        browserCheck: {
          ...validEvidence().browserCheck!,
          commit: 'c'.repeat(40),
        },
      }),
    ],
    [
      'instance_mismatch',
      validEvidence({
        browserCheck: {
          ...validEvidence().browserCheck!,
          instanceId: 'instance-stale',
        },
      }),
    ],
    [
      'invalid_identity',
      validEvidence({
        artifact: {
          ...validEvidence().artifact!,
          digest: '',
        },
        instance: {
          ...validEvidence().instance!,
          artifactDigest: '',
        },
        readiness: {
          ...validEvidence().readiness!,
          artifactDigest: '',
        },
        browserCheck: {
          ...validEvidence().browserCheck!,
          artifactDigest: '',
        },
      }),
    ],
    [
      'artifact_digest_mismatch',
      validEvidence({
        browserCheck: {
          ...validEvidence().browserCheck!,
          artifactDigest: `sha256:${'d'.repeat(64)}`,
        },
      }),
    ],
  ] as const)(
    'rejects live completion with %s',
    (reason, evidence) => {
      expect(
        evaluateBuildPreviewCompletion({
          mode: 'live',
          expectedRevisionId: 'rev-1',
          expectedCommit: COMMIT,
          evidence,
        }),
      ).toEqual({ satisfied: false, reason });
    },
  );
});
