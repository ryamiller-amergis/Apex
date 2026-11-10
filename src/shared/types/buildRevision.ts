/**
 * Shared types for Build Revisions (FEAT-014, S1).
 */
export const BUILD_REVISION_FEEDBACK_MAX_LENGTH = 4000;
export const BUILD_REVISION_MAX_QUESTIONS = 3;
export const BUILD_REVISION_LIMIT = 5;

export type BuildRevisionErrorCode =
  | 'FEEDBACK_REQUIRED'
  | 'FEEDBACK_TOO_LONG'
  | 'BUILDS_DISABLED'
  | 'NOT_REQUESTER_OR_ADMIN'
  | 'BUILD_PROJECT_MISMATCH'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_NOT_REVISABLE'
  | 'REVISION_IN_PROGRESS'
  | 'REVISION_CAP_REACHED'
  | 'APPROVED_LOGO_REQUIRED';

export interface BuildRevisionRequest {
  project: string;
  feedback: string;
  hasAttachments?: boolean;
  approvedLogoCandidateId?: string;
}

export interface BuildRevisionAccepted {
  buildId: string;
  revisionNumber: number; // 2 to 6 under the working default
  /** `queued` waits for the running build's preview, then starts on its own. */
  status: 'intake' | 'building' | 'queued';
  revisionsUsed: number;
  revisionsLimit: number;
  interviewId: string;
  chatThreadId: string;
  resumed: boolean;
}

export type BuildRevisionStage =
  | 'asking'
  | 'drafting'
  | 'awaiting_approval'
  | 'building'
  | 'planning'
  | 'preview_ready';

export interface BuildRevisionProgressView {
  number: number;
  revisionsUsed: number;
  revisionsLimit: number;
  stage: BuildRevisionStage | null;
  requestedBy: { userId: string; displayName: string } | null;
  actingForRequester: boolean;
  requesterDisplayName: string;
  viewerCanRequestChanges: boolean;
  feedback?: string;
  amendmentError: { message: string; occurredAt: string } | null;
}

export const BUILD_REVISION_FAST_EDIT_STATUSES = [
  'classify',
  'edit',
  'escalate',
  'apply',
  'checking',
  'ready',
  'failed',
  'rollback',
  'superseded',
] as const;

export type BuildRevisionFastEditStatus =
  (typeof BUILD_REVISION_FAST_EDIT_STATUSES)[number];

export type BuildRevisionFastEditRoute = 'fast_edit' | 'full_build';

export type BuildRevisionFastEditCheckStatus = 'pending' | 'passed' | 'failed';

export interface BuildRevisionFastEditCheckSummary {
  status: BuildRevisionFastEditCheckStatus;
  tasks: Array<{
    name: 'typecheck' | 'unit_test';
    status: BuildRevisionFastEditCheckStatus;
    message?: string;
  }>;
}

export interface BuildRevisionFastEditProgress {
  attemptId: string;
  revisionNumber: number;
  status: BuildRevisionFastEditStatus;
  route: BuildRevisionFastEditRoute | null;
  requestedAt: string;
  previewUpdatedAt: string | null;
  checksCompletedAt: string | null;
  checkSummary: BuildRevisionFastEditCheckSummary | null;
  error: { code: string; message: string } | null;
  workspaceVersion: number | null;
}
