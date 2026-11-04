/**
 * Shared contract for Run Controls, Caps and Notifications (FEAT-016, S1).
 */
export type BuildSuspendReason =
  | 'cap_reached'
  | 'repair_cap'
  | 'cost_cap'
  | 'elapsed_cap'
  | 'parallelism_cap'
  | 'flag_disabled'
  | 'permission_revoked'
  | 'configuration'
  | 'plan_invalid';

export type BuildCapName = 'cost' | 'elapsed' | 'revisions' | 'parallelism';

export interface BuildCapSnapshot {
  costUsd: number;
  costLimitUsd: number;
  elapsedMs: number;
  elapsedLimitMs: number;
  revisionsUsed: number;
  revisionsLimit: number;
  runningAgents: number;
  parallelismLimit: number;
}

export interface CapCrossing {
  reason: 'cost_cap' | 'elapsed_cap' | 'parallelism_cap';
  capName: BuildCapName;
  used: number;
  limit: number;
}

export interface BuildAllowedActions {
  cancel: boolean;
  resume: boolean;
}

export interface BuildSuspensionView {
  reason: BuildSuspendReason;
  message: string;
  deadlineAt: string | null;
  capName: BuildCapName | null;
  used: number | null;
  limit: number | null;
  resumable: boolean;
}

export interface BuildRunControlResult {
  buildId: string;
  status: string;
  suspendReason: BuildSuspendReason | null;
  allowedActions: BuildAllowedActions;
  stoppedAgents: number;
  unconfirmedAgents: number;
  alreadyCancelled?: boolean;
}

export interface ResumeRefusal {
  code: 'RESUME_CAUSE_NOT_CLEARED' | 'RESUME_NOT_SUPPORTED';
  remainingCause: BuildSuspendReason;
  message: string;
}

export type BuildNotificationKind =
  | 'build_started'
  | 'preview_ready'
  | 'run_suspended'
  | 'deployment_failed'
  | 'pull_request_created';

export interface BuildNotifyInput {
  kind: BuildNotificationKind;
  buildRunId: string;
  revisionNumber?: number;
  suspendEventId?: string;
  pipelineRunId?: string;
  failedStage?: string;
  reason?: BuildSuspendReason;
  riskDecisionCount?: number;
}
