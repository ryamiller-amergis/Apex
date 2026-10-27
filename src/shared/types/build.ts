/**
 * Shared build contract for App Builder (FEAT-001).
 * Epic 1 and Epic 2 import these vocabularies. A pin test fails if a list changes.
 */
import type { ArtifactRef } from './loadTest';

export type { ArtifactRef };

/** Counts as an active build for the per-project and platform caps. */
export const BUILD_RUN_SLOT_STATUSES = [
  'intake',
  'planning',
  'building',
  'checking',
  'deploying',
] as const;

/** Same set as the slot list. Named for callers that talk about active builds. */
export const BUILD_ACTIVE_STATUSES = BUILD_RUN_SLOT_STATUSES;

export const BUILD_CONCURRENCY_LIMITS = { perProject: 3, platform: 10 } as const;

export const BUILD_PROMPT_MAX_LENGTH = 8000;
export const BUILD_CLIENT_REQUEST_ID_MAX_LENGTH = 128;

/** Badge and list "in progress" include the queue. The queue does not hold a slot. */
export const BUILD_IN_PROGRESS_STATUSES = ['queued', ...BUILD_RUN_SLOT_STATUSES] as const;

/** Stages a suspended run may return to. Same five as the slot list. */
export const BUILD_RUN_STAGE_STATUSES = BUILD_RUN_SLOT_STATUSES;

export const BUILD_RUN_TERMINAL_STATUSES = ['accepted', 'cancelled', 'failed'] as const;

export const BUILD_RUN_STATUSES = [
  'queued',
  'intake',
  'planning',
  'building',
  'checking',
  'deploying',
  'preview_ready',
  'suspended',
  'deployment_failed',
  'needs_developer',
  'accepted',
  'cancelled',
  'failed',
] as const;

/** `cap_reached` is split so each cap can be told apart. */
export const BUILD_SUSPEND_REASONS = [
  'cost_cap',
  'elapsed_cap',
  'repair_cap',
  'flag_disabled',
  'permission_revoked',
  'configuration',
  'plan_invalid',
] as const;

export const BUILD_TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'merged',
  'failed',
  'omitted',
] as const;

export const BUILD_TASK_ROLES = ['planner', 'implementer', 'qa', 'check', 'sync'] as const;

/** Roles a plan may list. The orchestrator inserts planner, check, and sync. */
export const BUILD_PLAN_TASK_ROLES = ['implementer', 'qa'] as const;

export const BUILD_TASK_RUN_MODES = ['own_agent', 'chain'] as const;

export const BUILD_VERIFICATION_KINDS = ['ac', 'dod', 'br', 'nfr', 'risk_decision'] as const;

/** `pending` is the default for a row that exists before evidence is recorded. */
export const BUILD_VERIFICATION_STATUSES = [
  'pending',
  'pass',
  'fail',
  'deferred',
  'retired',
] as const;

export const BUILD_DEPLOYMENT_STATUSES = [
  'not_started',
  'queued',
  'deploying',
  'succeeded',
  'failed',
] as const;

export const BUILD_CLASSIFICATIONS = ['small', 'full'] as const;

export const BUILD_RISK_RATINGS = ['low', 'medium', 'high'] as const;

export const BUILD_RISK_CATEGORIES = ['data', 'access', 'integration', 'destructive'] as const;

export const BUILD_REQUIREMENT_KINDS = ['ac', 'dod', 'br', 'nfr'] as const;

export const BUILD_TEST_TIERS = ['unit', 'integration', 'e2e'] as const;

export const BUILD_EVENT_SEVERITIES = ['info', 'warn', 'error'] as const;

export const BUILD_CORRELATION_KINDS = [
  'agent_run',
  'pipeline_run',
  'pull_request',
  'commit',
] as const;

export const BUILD_PROFILE_ROLES = ['intake', 'planner', 'implementer', 'qa', 'check'] as const;

export const BUILD_SCAFFOLD_KINDS = [
  'shared_types',
  'migration',
  'schema',
  'router_mount',
  'route_entry',
  'navigation_entry',
  'empty_component',
  'empty_test',
] as const;

/** Starter set. The database checks the format, not this closed list. */
export const BUILD_EVENT_TYPES = [
  'build.queued',
  'build.started',
  'intake.brief_approved',
  'plan.validated',
  'plan.invalid',
  'task.launched',
  'task.completed',
  'task.merged',
  'task.failed',
  'check.passed',
  'deploy.queued',
  'deploy.started',
  'deploy.succeeded',
  'deploy.failed',
  'revision.requested',
  'pull_request.opened',
  'run.suspended',
  'run.resumed',
  'run.cap_extended',
  'run.cancelled',
  'run.failed',
] as const;

export type BuildRunStatus = (typeof BUILD_RUN_STATUSES)[number];
export type BuildRunStageStatus = (typeof BUILD_RUN_STAGE_STATUSES)[number];
export type BuildSuspendReason = (typeof BUILD_SUSPEND_REASONS)[number];
export type BuildTaskStatus = (typeof BUILD_TASK_STATUSES)[number];
export type BuildTaskRole = (typeof BUILD_TASK_ROLES)[number];
export type BuildPlanTaskRole = (typeof BUILD_PLAN_TASK_ROLES)[number];
export type BuildTaskRunMode = (typeof BUILD_TASK_RUN_MODES)[number];
export type BuildVerificationKind = (typeof BUILD_VERIFICATION_KINDS)[number];
export type BuildVerificationStatus = (typeof BUILD_VERIFICATION_STATUSES)[number];
export type BuildDeploymentStatus = (typeof BUILD_DEPLOYMENT_STATUSES)[number];
export type BuildClassification = (typeof BUILD_CLASSIFICATIONS)[number];
export type BuildRiskRating = (typeof BUILD_RISK_RATINGS)[number];
export type BuildRiskCategory = (typeof BUILD_RISK_CATEGORIES)[number];
export type BuildRequirementKind = (typeof BUILD_REQUIREMENT_KINDS)[number];
export type BuildTestTier = (typeof BUILD_TEST_TIERS)[number];
export type BuildEventSeverity = (typeof BUILD_EVENT_SEVERITIES)[number];
export type BuildCorrelationKind = (typeof BUILD_CORRELATION_KINDS)[number];
export type BuildProfileRole = (typeof BUILD_PROFILE_ROLES)[number];
export type BuildScaffoldKind = (typeof BUILD_SCAFFOLD_KINDS)[number];
export type BuildEventType = (typeof BUILD_EVENT_TYPES)[number];

/** Positive integer, no leading zero. Changed criteria keep their id. */
export const BUILD_REQUIREMENT_ID_PATTERN = /^(AC|DOD|BR|NFR)-[1-9]\d*$/;
export const BUILD_RISK_DECISION_ID_PATTERN = /^RD-[1-9]\d*$/;
export const BUILD_TASK_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const BUILD_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

const BUILD_RUN_TRANSITIONS: Record<BuildRunStatus, readonly BuildRunStatus[]> = {
  queued: ['intake', 'suspended', 'cancelled', 'failed'],
  intake: ['planning', 'building', 'suspended', 'cancelled', 'failed'],
  planning: ['building', 'suspended', 'cancelled', 'failed'],
  building: ['checking', 'deploying', 'suspended', 'cancelled', 'failed'],
  checking: ['building', 'deploying', 'suspended', 'cancelled', 'failed'],
  deploying: ['preview_ready', 'deployment_failed', 'suspended', 'cancelled', 'failed'],
  preview_ready: ['intake', 'accepted', 'needs_developer', 'cancelled', 'failed'],
  deployment_failed: ['deploying', 'cancelled', 'failed'],
  needs_developer: ['cancelled'],
  suspended: ['cancelled', 'failed'],
  accepted: [],
  cancelled: [],
  failed: [],
};

const BUILD_TASK_TRANSITIONS: Record<BuildTaskStatus, readonly BuildTaskStatus[]> = {
  pending: ['ready', 'omitted'],
  ready: ['running', 'omitted'],
  running: ['merged', 'failed', 'ready'],
  failed: ['ready'],
  merged: [],
  omitted: [],
};

const BUILD_DEPLOYMENT_TRANSITIONS: Record<BuildDeploymentStatus, readonly BuildDeploymentStatus[]> = {
  not_started: ['queued'],
  queued: ['deploying'],
  deploying: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['queued'],
};

/** A suspended queued build records `queued` so a later resume can put it back. */
export type BuildSuspendedFromStatus = BuildRunStageStatus | 'queued';

export function isBuildInProgress(status: BuildRunStatus): boolean {
  return (BUILD_IN_PROGRESS_STATUSES as readonly string[]).includes(status);
}

export function buildStatusLabel(status: BuildRunStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'intake':
      return 'Intake';
    case 'planning':
      return 'Planning';
    case 'building':
      return 'Building';
    case 'checking':
      return 'Checking';
    case 'deploying':
      return 'Deploying';
    case 'preview_ready':
      return 'Preview ready';
    case 'suspended':
      return 'Suspended';
    case 'deployment_failed':
      return 'Deployment failed';
    case 'needs_developer':
      return 'Needs a developer';
    case 'accepted':
      return 'Accepted';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function isLegalBuildRunTransition(
  from: BuildRunStatus,
  to: BuildRunStatus,
  suspendedFromStatus?: BuildSuspendedFromStatus | null,
): boolean {
  if (from === 'suspended') {
    if (to === 'cancelled' || to === 'failed') return true;
    return suspendedFromStatus != null && to === suspendedFromStatus;
  }
  return BUILD_RUN_TRANSITIONS[from].includes(to);
}

export function isLegalBuildTaskTransition(from: BuildTaskStatus, to: BuildTaskStatus): boolean {
  return BUILD_TASK_TRANSITIONS[from].includes(to);
}

export function isLegalBuildDeploymentTransition(
  from: BuildDeploymentStatus,
  to: BuildDeploymentStatus,
): boolean {
  return BUILD_DEPLOYMENT_TRANSITIONS[from].includes(to);
}

/** `apex/build/<runId>`. Not a prefix of a task branch. */
export function integrationBranchName(runId: string): string {
  return `apex/build/${runId}`;
}

/** `apex/build-task/<runId>/<taskKey>`. Sits beside the integration branch, not under it. */
export function taskBranchName(runId: string, taskKey: string): string {
  return `apex/build-task/${runId}/${taskKey}`;
}

export interface BuildSkillRoleSnapshot {
  model: string;
  skillPath: string;
  contentHash: string;
}

export interface BuildHashedPath {
  path: string;
  hash: string;
}

export interface BuildSkillSnapshot {
  intake: BuildSkillRoleSnapshot;
  planner: BuildSkillRoleSnapshot;
  implementer: BuildSkillRoleSnapshot;
  qa: BuildSkillRoleSnapshot;
  check: BuildSkillRoleSnapshot;
  designSystemFile: BuildHashedPath;
  codingRules: BuildHashedPath;
  codeMap: BuildHashedPath;
}

export interface BuildSupportContact {
  userId: string;
  displayName: string;
  email: string;
}

export interface BuildQualityManifestSnapshot {
  typeCheck: string;
  lint: string;
  relatedTests: string;
  unitSuite: string;
}

export interface BuildRequirement {
  id: string;
  kind: BuildRequirementKind;
  text: string;
  retired: boolean;
}

export interface BuildRiskDecision {
  id: string;
  category: BuildRiskCategory;
  rating: BuildRiskRating;
  decision: string;
  rationale: string;
}

/** Null means "not set": the resolver falls back for models; skill paths have no fallback. */
export interface BuildProfileRoleSetting {
  skillPath: string | null;
  model: string | null;
}

export interface BuildProfileCaps {
  costUsd: number | null;
  elapsedMinutesPerRevision: number | null;
  /** Change requests, not counting the first build. */
  maxRevisions: number | null;
  maxParallelism: number | null;
}

/** Stored on `project_skill_settings.build_profile`, one per repository configuration. */
export interface BuildProfile {
  roles: Record<BuildProfileRole, BuildProfileRoleSetting>;
  caps: BuildProfileCaps;
  qualityManifestPath: string | null;
  deployPipelineId: number | null;
  supportContactUserIds: string[];
}

export interface BuildReuseEntry {
  path: string;
  symbol?: string;
  reason?: string;
}

export interface BuildTestRef {
  path: string;
  name: string;
}

export interface BuildTestEvidence {
  commit: string;
  recordedAt: string;
  command: string;
  exitCode: number;
  passed: number;
  failed: number;
  summary: string;
}

export interface BuildRun {
  id: string;
  project: string;
  repository: string;
  requestedByUserId: string;
  clientRequestId: string;
  modelOverride: string | null;
  prompt: string;
  /** Null while the build is queued and has not started a Playbook run. */
  playbookRunId: string | null;
  playbookStepRunId: string | null;
  skillSettingsId: string | null;
  queuedAt: string | null;
  interviewId: string | null;
  briefId: string | null;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  suspendedFromStatus: BuildSuspendedFromStatus | null;
  currentRevisionNumber: number;
  revisionsUsed: number;
  revisionCap: number;
  integrationBranch: string | null;
  baseCommit: string | null;
  skillSnapshot: BuildSkillSnapshot;
  supportContacts: BuildSupportContact[];
  qualityManifestSnapshot: BuildQualityManifestSnapshot;
  costCapUsd: string;
  costUsedUsd: string;
  elapsedCapSeconds: number;
  parallelismCap: number;
  parallelismUsed: number;
  pullRequestUrl: string | null;
  pullRequestId: number | null;
  acceptedRevisionNumber: number | null;
  integrationBranchDeletedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildRevision {
  id: string;
  buildRunId: string;
  revisionNumber: number;
  feedback: string | null;
  briefVersion: number | null;
  requirements: BuildRequirement[];
  assumptions: string[];
  exclusions: string[];
  riskDecisions: BuildRiskDecision[];
  classification: BuildClassification | null;
  plan: unknown | null;
  planValidation: { status: 'pass' | 'fail'; violations: unknown[] } | null;
  contextNotesPath: string | null;
  repairAttempts: number;
  elapsedSecondsUsed: number;
  validatedCommit: string | null;
  pipelineRunId: string | null;
  deploymentStatus: BuildDeploymentStatus;
  deploymentQueuedAt: string | null;
  deployedAt: string | null;
  deploymentFailedStage: string | null;
  deploymentPipelineUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildTask {
  id: string;
  buildRevisionId: string;
  taskKey: string;
  role: BuildTaskRole;
  dependsOn: string[];
  ownedFiles: string[];
  covers: string[];
  reuse: BuildReuseEntry[];
  runMode: BuildTaskRunMode;
  /**
   * Set on every `chain` task to the head task key, including the head itself.
   * Null on `own_agent`. The agent run still links to the head task.
   */
  chainHeadKey: string | null;
  branchName: string | null;
  status: BuildTaskStatus;
  attempt: number;
  omittedReason: string | null;
  mergePullRequestId: number | null;
  mergeCommit: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildVerificationRow {
  id: string;
  buildRevisionId: string;
  requirementId: string;
  kind: BuildVerificationKind;
  testTier: BuildTestTier | null;
  testRefs: BuildTestRef[];
  redEvidence: BuildTestEvidence | null;
  greenEvidence: BuildTestEvidence | null;
  evidenceBlobRef: ArtifactRef | null;
  status: BuildVerificationStatus;
  deferralReason: string | null;
  carriedFromRevisionNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuildPreviewLease {
  id: string;
  project: string;
  repository: string;
  buildRunId: string;
  buildRevisionId: string;
  grantedAt: string;
  expiresAt: string;
}

export interface BuildEvent {
  id: string;
  ordinal: number;
  buildRunId: string;
  buildRevisionId: string | null;
  eventType: string;
  severity: BuildEventSeverity;
  message: string;
  detail: Record<string, unknown> | null;
  correlationKind: BuildCorrelationKind | null;
  correlationId: string | null;
  actorUserId: string | null;
  dedupeKey: string | null;
  createdAt: string;
}

export interface StartBuildRequest {
  project: string;
  repository: string;
  prompt: string;
  model?: string;
  clientRequestId: string;
}

export interface StartBuildResponse {
  buildRunId: string;
  playbookRunId: string | null;
  status: 'queued' | 'intake' | 'failed';
  queuePosition: number | null;
  queueReason: 'project_limit' | 'platform_limit' | null;
  replayed: boolean;
}

export interface BuildListItem {
  id: string;
  repository: string;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  requesterUserId: string;
  requesterDisplayName: string;
  createdAt: string;
  queuePosition: number | null;
  interviewId: string | null;
  playbookRunId: string | null;
}

export interface BuildListResponse {
  builds: BuildListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface BuildRepositoryOption {
  repository: string;
  label: string;
}

export type { BuildPlan } from '../buildPlanSchema';
