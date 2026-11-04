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
  | 'REVISION_CAP_REACHED';

export interface BuildRevisionRequest {
  project: string;
  feedback: string;
}

export interface BuildRevisionAccepted {
  buildId: string;
  revisionNumber: number; // 2 to 6 under the working default
  status: 'intake';
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
