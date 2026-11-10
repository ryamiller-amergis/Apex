import type {
  BuildPreviewEvidenceStatus,
  BuildPreviewInstanceState,
  BuildPreviewRolloutMode,
} from '../../../shared/types/build';

export type { BuildPreviewRolloutMode };

export interface BuildPreviewCompletionEvidence {
  revisionId: string;
  validatedCommit: string;
  artifact: {
    revisionId: string;
    commit: string;
    digest: string;
  } | null;
  instance: {
    id: string;
    revisionId: string;
    commit: string;
    artifactDigest: string;
    state: BuildPreviewInstanceState;
  } | null;
  readiness: {
    status: BuildPreviewEvidenceStatus;
    revisionId: string;
    instanceId: string;
    artifactDigest: string;
  } | null;
  browserCheck: {
    id: string;
    status: BuildPreviewEvidenceStatus;
    revisionId: string;
    commit: string;
    instanceId: string;
    artifactDigest: string;
  } | null;
}

export type BuildPreviewCompletionFailureReason =
  | 'missing_evidence'
  | 'missing_artifact'
  | 'missing_instance'
  | 'missing_readiness'
  | 'missing_browser_check'
  | 'instance_not_ready'
  | 'readiness_not_passed'
  | 'browser_check_not_passed'
  | 'revision_mismatch'
  | 'commit_mismatch'
  | 'instance_mismatch'
  | 'invalid_identity'
  | 'artifact_digest_mismatch';

export type BuildPreviewCompletionResult =
  | { satisfied: true }
  | {
      satisfied: false;
      reason: BuildPreviewCompletionFailureReason;
    };

export interface BuildPreviewCompletionPort {
  /**
   * Returns the rollout mode pinned to this revision and its current evidence.
   * A repository rollout change must not reclassify an existing revision.
   */
  loadGate(input: {
    revisionId: string;
    project: string;
    repository: string;
  }): Promise<{
    mode: BuildPreviewRolloutMode;
    evidence: BuildPreviewCompletionEvidence | null;
  }>;
}

export function evaluateBuildPreviewCompletion(input: {
  mode: BuildPreviewRolloutMode;
  expectedRevisionId: string;
  expectedCommit: string | null;
  evidence: BuildPreviewCompletionEvidence | null;
}): BuildPreviewCompletionResult {
  if (input.mode === 'legacy_static') return { satisfied: true };

  const evidence = input.evidence;
  if (!evidence) return { satisfied: false, reason: 'missing_evidence' };
  if (!evidence.artifact) {
    return { satisfied: false, reason: 'missing_artifact' };
  }
  if (!evidence.instance) {
    return { satisfied: false, reason: 'missing_instance' };
  }
  if (!evidence.readiness) {
    return { satisfied: false, reason: 'missing_readiness' };
  }
  if (!evidence.browserCheck) {
    return { satisfied: false, reason: 'missing_browser_check' };
  }
  if (evidence.instance.state !== 'ready') {
    return { satisfied: false, reason: 'instance_not_ready' };
  }
  if (evidence.readiness.status !== 'passed') {
    return { satisfied: false, reason: 'readiness_not_passed' };
  }
  if (evidence.browserCheck.status !== 'passed') {
    return { satisfied: false, reason: 'browser_check_not_passed' };
  }

  const revisionIds = [
    evidence.revisionId,
    evidence.artifact.revisionId,
    evidence.instance.revisionId,
    evidence.readiness.revisionId,
    evidence.browserCheck.revisionId,
  ];
  if (revisionIds.some((id) => id !== input.expectedRevisionId)) {
    return { satisfied: false, reason: 'revision_mismatch' };
  }

  const commits = [
    evidence.validatedCommit,
    evidence.artifact.commit,
    evidence.instance.commit,
    evidence.browserCheck.commit,
  ];
  if (
    !input.expectedCommit
    || commits.some((commit) => commit !== input.expectedCommit)
  ) {
    return { satisfied: false, reason: 'commit_mismatch' };
  }

  if (
    !evidence.artifact.digest.trim()
    || !evidence.instance.id.trim()
    || !evidence.instance.artifactDigest.trim()
    || !evidence.readiness.instanceId.trim()
    || !evidence.readiness.artifactDigest.trim()
    || !evidence.browserCheck.instanceId.trim()
    || !evidence.browserCheck.id.trim()
    || !evidence.browserCheck.artifactDigest.trim()
  ) {
    return { satisfied: false, reason: 'invalid_identity' };
  }

  if (
    evidence.readiness.instanceId !== evidence.instance.id
    || evidence.browserCheck.instanceId !== evidence.instance.id
  ) {
    return { satisfied: false, reason: 'instance_mismatch' };
  }

  if (
    evidence.instance.artifactDigest !== evidence.artifact.digest
    || evidence.readiness.artifactDigest !== evidence.artifact.digest
    || evidence.browserCheck.artifactDigest !== evidence.artifact.digest
  ) {
    return { satisfied: false, reason: 'artifact_digest_mismatch' };
  }

  return { satisfied: true };
}
