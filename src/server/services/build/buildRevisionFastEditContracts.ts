import type {
  BuildRevisionFastEditCheckSummary,
  BuildRevisionFastEditRoute,
  BuildRevisionFastEditStatus,
} from '../../../shared/types/buildRevision';

export type FastEditChangeSetKind = 'edit' | 'rollback';

export interface FastEditArtifactPointer {
  digest: string;
  ref: string;
}

export interface BuildRevisionFastEditAttempt {
  id: string;
  buildRunId: string;
  buildRevisionId: string;
  idempotencyKey: string;
  requestDigest: string;
  status: BuildRevisionFastEditStatus;
  route: BuildRevisionFastEditRoute | null;
  recordVersion: number;
  baseCommit: string;
  baseSnapshot: FastEditArtifactPointer;
  expectedWorkspaceVersion: number;
  appliedWorkspaceVersion: number | null;
  checkSummary: BuildRevisionFastEditCheckSummary | null;
  agentCorrelationRef: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  requestedAt: string;
  previewUpdatedAt: string | null;
  checksCompletedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BuildRevisionFastEditChangeSet {
  id: string;
  attemptId: string;
  sequence: number;
  idempotencyKey: string;
  kind: FastEditChangeSetKind;
  artifact: FastEditArtifactPointer;
  expectedWorkspaceVersion: number;
  appliedWorkspaceVersion: number;
  createdAt: string;
}

export interface BuildRevisionFastEditRecoveryPlan {
  attempt: BuildRevisionFastEditAttempt;
  baseSnapshot: FastEditArtifactPointer;
  orderedChangeSets: BuildRevisionFastEditChangeSet[];
}

export const ACTIVE_BUILD_REVISION_FAST_EDIT_STATUSES: readonly BuildRevisionFastEditStatus[] = [
  'classify',
  'edit',
  'apply',
  'checking',
  'rollback',
];

const ALLOWED_TRANSITIONS: Readonly<
  Record<BuildRevisionFastEditStatus, readonly BuildRevisionFastEditStatus[]>
> = {
  classify: ['edit', 'escalate', 'failed', 'superseded'],
  edit: ['apply', 'escalate', 'failed', 'superseded'],
  escalate: ['superseded'],
  apply: ['checking', 'failed', 'rollback', 'superseded'],
  checking: ['ready', 'failed', 'rollback', 'superseded'],
  ready: ['rollback', 'superseded'],
  failed: ['edit', 'escalate', 'rollback', 'superseded'],
  rollback: ['checking', 'ready', 'failed', 'superseded'],
  superseded: [],
};

export function isActiveBuildRevisionFastEditStatus(
  status: BuildRevisionFastEditStatus,
): boolean {
  return ACTIVE_BUILD_REVISION_FAST_EDIT_STATUSES.includes(status);
}

export function isLegalBuildRevisionFastEditTransition(
  from: BuildRevisionFastEditStatus,
  to: BuildRevisionFastEditStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isProviderNeutralFastEditRef(value: string): boolean {
  return (
    value.trim().length > 0
    && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    && !/^file:/i.test(value)
    && !/^[a-z]:[\\/]/i.test(value)
    && !value.startsWith('/')
    && !value.startsWith('\\\\')
  );
}

export function assertFastEditArtifactPointer(
  artifact: FastEditArtifactPointer,
): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) {
    throw new Error('Fast-edit artifact digest must be a sha256 digest.');
  }
  if (!isProviderNeutralFastEditRef(artifact.ref)) {
    throw new Error('Fast-edit artifact references must be provider-neutral.');
  }
}
