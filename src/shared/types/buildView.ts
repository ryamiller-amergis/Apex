/**
 * Response shapes for the Build Run View (FEAT-008): `GET /api/builds/:id` and `GET /api/builds/:id/events`.
 * The server returns tokens; the client turns them into sentences.
 */
import type {
  BuildClassification,
  BuildDeploymentStatus,
  BuildRequirement,
  BuildReuseEntry,
  BuildRiskDecision,
  BuildRunStatus,
  BuildSuspendReason,
  BuildTaskRole,
  BuildTaskRunMode,
  BuildTaskStatus,
} from './build';

export const BUILD_DELIVERY_TARGET_SECONDS: Record<BuildClassification, number> = { small: 300, full: 3600 };

export const BUILD_EVENTS_DEFAULT_LIMIT = 200;
export const BUILD_EVENTS_MAX_LIMIT = 500;

export type BuildStageKey =
  | 'queued' | 'intake' | 'planning' | 'building' | 'checking' | 'deploying' | 'preview_ready';
export type BuildExceptionKey =
  | 'suspended' | 'deployment_failed' | 'needs_developer' | 'failed' | 'cancelled' | 'accepted';

export type BuildStageView =
  | {
    kind: 'stage';
    key: BuildStageKey;
    tasks: { merged: number; total: number } | null;
    queuePosition: number | null;
    suspendReason: null;
  }
  | {
    kind: 'exception';
    key: BuildExceptionKey;
    tasks: { merged: number; total: number } | null;
    queuePosition: null;
    /** Set only for `suspended`. Null on a suspended build is a data error. */
    suspendReason: BuildSuspendReason | null;
  };

export interface BuildTimingView {
  /** Null before the revision exists. */
  elapsedSeconds: number | null;
  /** 300 small, 3600 full, null when unclassified. */
  targetSeconds: number | null;
  state: 'within' | 'over' | 'none';
  /** True when deployment timestamps are missing, so elapsed includes deployment. */
  includesDeployment: boolean;
}

export interface BuildCapView {
  cost: { usedUsd: string; limitUsd: string };
  revisions: { used: number; limit: number };
  elapsedSeconds: { used: number; limit: number };
  parallelism: { used: number; limit: number };
}

export interface BuildSupportContactView {
  displayName: string;
  email: string | null;
}

export type BuildRequirementView = BuildRequirement;
export type BuildRiskDecisionView = BuildRiskDecision;

export type BuildBriefView =
  | {
    status: 'ok';
    overview: string | null;
    requirements: BuildRequirementView[];
    assumptions: string[];
    exclusions: string[];
    riskDecisions: BuildRiskDecisionView[];
  }
  | { status: 'unavailable' };

export interface BuildTaskView {
  key: string;
  role: BuildTaskRole;
  dependsOn: string[];
  ownedFiles: string[];
  reuse: BuildReuseEntry[];
  runMode: BuildTaskRunMode;
  branch: string | null;
  status: BuildTaskStatus;
  attempt: number;
  omittedReason: string | null;
}

export interface BuildRevisionSummary {
  number: number;
  createdAt: string;
  classification: BuildClassification | null;
  deploymentStatus: BuildDeploymentStatus;
  previewUrl: string | null;
}

export interface BuildVerificationSummary {
  total: number;
  pass: number;
  fail: number;
  deferred: number;
  retired: number;
}

export interface BuildDetailResponse {
  build: {
    id: string;
    project: string;
    repository: string;
    status: BuildRunStatus;
    currentRevisionNumber: number;
    intakeInterviewId: string | null;
    createdAt: string;
    endedAt: string | null;
  };
  stage: BuildStageView;
  timing: BuildTimingView;
  caps: BuildCapView;
  supportContacts: BuildSupportContactView[];
  revisions: BuildRevisionSummary[];
  /** Null while no revision row exists yet. */
  currentRevision: {
    number: number;
    classification: BuildClassification | null;
    repairAttempts: number;
    brief: BuildBriefView;
    tasks: BuildTaskView[];
  } | null;
  verificationSummary: BuildVerificationSummary;
  /** Null until the preview lease manager fills it. */
  lease: { state: 'waiting' | 'held' | 'none'; queuePosition: number | null } | null;
}

export interface BuildEventView {
  id: string;
  occurredAt: string;
  kind: string;
  message: string;
  taskKey: string | null;
}

export interface BuildEventsResponse {
  events: BuildEventView[];
  total: number;
}
