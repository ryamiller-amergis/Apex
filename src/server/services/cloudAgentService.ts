/**
 * Cloud Agent deep module. Owns eligibility, one-live-run start/resume,
 * status projection, and cancel. Durable transitions go through
 * agentRunLifecycleService.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, devSessions } from '../db/schema';
import { MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import {
  buildGuidedCloudAgentPrompt,
  guidedSiteIssueBranchName,
  recommendGuidedSiteSkill,
  type SiteIssueImage,
  guidedCloudJobById,
  recommendImplementationSkill,
  resolveCloudAgentLaunchSelection,
  type CloudAgentLaunchIntent,
} from '../../shared/utils/cloudAgentLaunch';
import { DEFAULT_DEVELOPMENT_MODEL } from '../../shared/utils/developmentKickoff';
import { skillNameFromPath } from '../../shared/skillPaths';
import * as skillCatalog from './skillCatalogFacade';
import type { ProjectSkillConfig, SkillProvider } from '../../shared/types/projectSettings';
import {
  evaluateDevStartEligibility,
  isAppNativeRequirementsProject,
  type AssignedWorkItem,
  type CloudAgentEligibility,
  type CloudAgentLaunchOptions,
  type CloudAgentRunSummary,
  type CloudAgentSkillChoice,
  type GuidedCloudAgentSession,
  type HostAgnosticPrStatus,
  type StartCloudAgentRunResponse,
} from '../../shared/types/devWorkbench';
import { isAgentRunTerminalStatus } from '../../shared/types/agentRunLifecycle';
import type {
  AgentRunExecutionSnapshot,
  AgentRunStatus,
  AgentRunTerminalReason,
  ExecutionSnapshot,
  RunCheckResult,
} from '../../shared/types/agentRunLifecycle';
import { deriveFailingChecks } from '../../shared/utils/runCheckResults';
import { isFeatureEnabled } from './featureFlagService';
import { getSkillConfig } from './projectSettingsService';
import { buildLocalDevContext } from './localDevContextService';
import { logMyWorkSession } from './myWorkSessionLogger';
import { trackEvent } from './telemetry';
import {
  captureCloudAgentIdentity,
  enqueue,
  markTerminal,
  requestCancel,
} from './agentRunLifecycleService';
import {
  cancelCursorCloudAgentRun,
  getCloudAgentRun,
  launchCloudAgent,
  streamCloudAgentRun,
  type CloudAgentRunObservation,
  type LaunchCloudAgentResult,
} from './cursorCloudAgentClient';
import { recordCloudAgentUsage, type RecordCloudAgentUsageInput } from './cloudAgentUsageService';
import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';
import {
  buildWorkItemReferenceText,
  linkWorkItemToPullRequest,
  parsePullRequestNumber,
} from './workItemPrLinkService';
import { AzureDevOpsService } from './azureDevOps';
import { getPullRequestStatus as getGithubPullRequestStatus } from './skillCatalogGitHub';
import { retryWithBackoff } from '../utils/retry';
import {
  computeLeftoverWorkSummary,
  formatLeftoverWorkForResumePrompt,
  persistLeftoverWork,
  writeLeftoverWorkToAdo,
} from './cloudAgentLeftoverWorkService';
import {
  buildCloudDevelopmentKickoffSection,
  developmentCliSkillName,
  prefixDevelopmentSkillInvocation,
  resolveDevelopmentSettings,
} from '../../shared/utils/developmentKickoff';
import {
  alignCloudAgentPullRequest,
  CLOUD_AGENT_PULL_REQUEST_LABEL,
  CloudAgentPullRequestDeferred,
  openCloudAgentPullRequest,
  type OpenCloudAgentPullRequestInput,
} from './cloudAgentPullRequest';
import { prepareCloudAgentKickoff, type CloudAgentKickoffInput } from './cloudAgentKickoff';
import {
  buildPullRequestDescriptionInstructions,
  implementationBranchName,
} from './implementationDelivery';
import {
  CLOUD_AGENT_QUEUE_WAIT_MS,
  CLOUD_AGENT_USER_TOKEN_CLAIM_MS,
  resolveCloudAgentRunLimitMs,
} from './cloudAgentQueue';

export const CLOUD_AGENT_PRE_IDENTITY_TTL_MS = 2 * 60_000;

/**
 * Deadline for a claimed run that still has `position` launches ahead of it.
 * Position 0 is the run whose Cursor start is about to begin. Later runs
 * get their own two-minute window so one slow start does not expire them
 * while they are waiting.
 */
export function cloudAgentPreIdentityTimeoutAt(position: number, nowMs = Date.now()): string {
  const place = Number.isInteger(position) && position >= 0 ? position : 0;
  return new Date(nowMs + (place + 1) * CLOUD_AGENT_PRE_IDENTITY_TTL_MS).toISOString();
}
const pendingCloudAgentUserTokens = new Map<string, string>();
let cloudAgentQueuePumpRunning = false;
let cloudAgentReconcileRunning = false;
export const LIVE_CLOUD_AGENT_STATUSES = ['queued', 'dispatched', 'running'] as const;

function cloudAgentInstanceId(): string {
  return process.env.WEBSITE_INSTANCE_ID?.trim() || 'apex-cloud-agent';
}

export class CloudAgentEligibilityError extends Error {
  readonly statusCode = 403;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CloudAgentEligibilityError';
  }
}

export class CloudAgentLaunchError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CloudAgentLaunchError';
  }
}

export class CloudAgentConflictError extends Error {
  readonly statusCode = 409;
  constructor(message = 'A Cloud Agent run is already in progress on this work item.') {
    super(message);
    this.name = 'CloudAgentConflictError';
  }
}

export interface EvaluateCloudAgentEligibilityInput {
  flagEnabled: boolean;
  project: string;
  item: Pick<AssignedWorkItem, 'workItemType' | 'state' | 'tags'>;
  isSuperAdmin: boolean;
  skillProvider?: string | null;
  skillRepo?: string | null;
  skillBranch?: string | null;
  hasLiveRun: boolean;
}

export function evaluateCloudAgentEligibility(
  input: EvaluateCloudAgentEligibilityInput,
): CloudAgentEligibility {
  if (!input.flagEnabled) {
    return { allowed: false, reason: 'Cloud Development is not enabled for this project.' };
  }
  if (isAppNativeRequirementsProject(input.project)) {
    return {
      allowed: false,
      reason: 'Cloud Development is only available on Azure DevOps-configured projects.',
    };
  }
  const startEligibility = evaluateDevStartEligibility(input.item, {
    isSuperAdmin: input.isSuperAdmin,
  });
  if (!startEligibility.allowed) {
    return startEligibility;
  }
  const missingField = missingSkillField(input);
  if (missingField) {
    return {
      allowed: false,
      reason: `Skill settings are incomplete: ${missingField} is not set.`,
    };
  }
  if (input.hasLiveRun) {
    return {
      allowed: false,
      reason: 'A Cloud Agent run is already in progress on this work item.',
    };
  }
  if (input.skillProvider?.trim() === 'github') {
    return {
      allowed: false,
      reason: 'Cloud Development supports Azure Repos only. GitHub repositories are not supported yet.',
    };
  }
  return { allowed: true };
}

function missingSkillField(input: EvaluateCloudAgentEligibilityInput): string | null {
  if (!input.skillProvider?.trim()) return 'skillProvider';
  if (!input.skillRepo?.trim()) return 'skillRepo';
  if (!input.skillBranch?.trim()) return 'skillBranch';
  return null;
}

function isInteractiveTurnSnapshot(
  snapshot: AgentRunExecutionSnapshot,
): snapshot is Exclude<AgentRunExecutionSnapshot, ExecutionSnapshot> {
  return 'kind' in snapshot && snapshot.kind === 'interactive-turn';
}

/** Cloud-agent runs carry a background snapshot, never an interactive-turn specification. */
function backgroundSnapshot(
  snapshot: AgentRunExecutionSnapshot | null | undefined,
): ExecutionSnapshot | null {
  if (!snapshot || isInteractiveTurnSnapshot(snapshot)) return null;
  return snapshot;
}

/** Older guided runs omit opensPullRequest and do not wait for a pull request. */
function guidedSkipsPullRequest(snapshot: AgentRunExecutionSnapshot | null | undefined): boolean {
  const cloud = backgroundSnapshot(snapshot)?.cloudAgent;
  return cloud?.delivery === 'guided' && cloud.opensPullRequest !== true;
}

function metaBranchName(
  snapshot: AgentRunExecutionSnapshot | null | undefined,
): string | null {
  const branchName = backgroundSnapshot(snapshot)?.cloudAgent?.branchName?.trim();
  return branchName || null;
}

/** How long a finished run waits for Cursor's autoCreatePR url before it completes without one. */
export const CLOUD_AGENT_PULL_REQUEST_WAIT_MS = 10 * 60_000;

/**
 * True while Cursor has finished the run and pushed a branch but its
 * autoCreatePR url has not arrived. Completing on this observation is final:
 * it stores a run with no pull request, skips the work-item link, and writes
 * leftover work saying none was opened, so the poll and the background sweep
 * both wait instead.
 */
function awaitingCloudAgentPullRequest(input: {
  status: AgentRunStatus | null;
  prUrl: string | null;
  noChanges?: boolean;
  branchName?: string | null;
}): boolean {
  return input.status === 'completed'
    && !input.prUrl
    && !input.noChanges
    && Boolean(input.branchName);
}

/**
 * Starts the wait for Cursor's pull request on the first such observation and
 * reports whether it has run past CLOUD_AGENT_PULL_REQUEST_WAIT_MS. Both
 * callers read the same stored timestamp, so neither can wait forever.
 */
async function cloudAgentPullRequestWaitExpired(run: {
  id: string;
  executionSnapshot: AgentRunExecutionSnapshot | null | undefined;
}): Promise<boolean> {
  const pendingSince = backgroundSnapshot(run.executionSnapshot)?.cloudAgent?.pullRequestPendingSince;
  const startedMs = pendingSince ? Date.parse(pendingSince) : Number.NaN;
  if (Number.isNaN(startedMs)) {
    const nowIso = new Date().toISOString();
    await db
      .update(agentRuns)
      .set({
        executionSnapshot: sql`jsonb_set(${agentRuns.executionSnapshot}, '{cloudAgent,pullRequestPendingSince}', to_jsonb(${nowIso}::text), true)`,
        updatedAt: nowIso,
      })
      .where(eq(agentRuns.id, run.id));
    return false;
  }
  return Date.now() - startedMs >= CLOUD_AGENT_PULL_REQUEST_WAIT_MS;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as { code?: string }).code === '23505',
  );
}

function toRunSummary(
  run: {
    id: string;
    status: string;
    terminalReason: AgentRunTerminalReason | null;
    checkResults: RunCheckResult[] | null;
    lastError?: string | null;
    cloudAgentIdentity?: string | null;
    cloudBranchName?: string | null;
    createdAt?: string;
  },
  prUrl: string | null,
  prStatus: HostAgnosticPrStatus,
  expectsPullRequest = true,
): CloudAgentRunSummary {
  const status = run.status as AgentRunStatus;
  return {
    runId: run.id,
    status,
    cloudAgentId: run.cloudAgentIdentity ?? null,
    branchName: run.cloudBranchName ?? null,
    createdAt: run.createdAt ?? new Date(0).toISOString(),
    prUrl,
    prStatus,
    finishedWithoutPr: expectsPullRequest && status === 'completed' && !prUrl,
    terminalReason: run.terminalReason,
    checkResults: run.checkResults,
    failingChecks: deriveFailingChecks(run.checkResults),
    lastError: status === 'failed' ? (run.lastError ?? null) : null,
  };
}

function mapObservedStatus(status: string): AgentRunStatus | null {
  const normalized = status.toLowerCase();
  if (normalized === 'creating') return 'dispatched';
  if (normalized === 'running') return 'running';
  if (normalized === 'finished' || normalized === 'completed') return 'completed';
  if (normalized === 'error' || normalized === 'failed') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return null;
}

export interface CloudAgentServiceDeps {
  isFeatureEnabled: typeof isFeatureEnabled;
  getSkillConfig: typeof getSkillConfig;
  launchCloudAgent: typeof launchCloudAgent;
  getCloudAgentRun: typeof getCloudAgentRun;
  streamCloudAgentRun: typeof streamCloudAgentRun;
  cancelCursorCloudAgentRun: typeof cancelCursorCloudAgentRun;
  linkWorkItemToPullRequest: typeof linkWorkItemToPullRequest;
  addAdoWorkItemHyperlink: (
    project: string,
    workItemId: number,
    prUrl: string,
    comment: string,
  ) => Promise<void>;
  prepareCloudAgentKickoff: (input: CloudAgentKickoffInput) => Promise<void>;
  alignCloudAgentPullRequest: typeof alignCloudAgentPullRequest;
  getAdoPullRequestStatus: (
    repo: string,
    project: string,
    pullRequestId: number,
  ) => Promise<'open' | 'abandoned' | 'merged'>;
  getGithubPullRequestStatus: typeof getGithubPullRequestStatus;
  retryWithBackoff: typeof retryWithBackoff;
  buildPrompt: (input: {
    project: string;
    workItemId: number;
    workItemTitle?: string;
    branchName?: string;
    skillPath?: string;
    model?: string;
  }) => Promise<string>;
  persistLeftoverWork: typeof persistLeftoverWork;
  writeLeftoverWorkToAdo: typeof writeLeftoverWorkToAdo;
  openCloudAgentPullRequest: (input: OpenCloudAgentPullRequestInput) => Promise<string>;
}

const defaultDeps: CloudAgentServiceDeps = {
  isFeatureEnabled,
  getSkillConfig,
  launchCloudAgent,
  getCloudAgentRun,
  streamCloudAgentRun,
  cancelCursorCloudAgentRun,
  linkWorkItemToPullRequest,
  addAdoWorkItemHyperlink: async (project, workItemId, prUrl, comment) => {
    await new AzureDevOpsService(project).addWorkItemHyperlink(workItemId, prUrl, comment);
  },
  prepareCloudAgentKickoff,
  alignCloudAgentPullRequest,
  getAdoPullRequestStatus: async (repo, project, pullRequestId) =>
    new AzureDevOpsService(project).getPullRequestStatus(repo, project, pullRequestId),
  getGithubPullRequestStatus,
  retryWithBackoff,
  buildPrompt: buildCloudAgentPrompt,
  persistLeftoverWork,
  writeLeftoverWorkToAdo,
  openCloudAgentPullRequest,
};

export async function buildCloudAgentPrompt(input: {
  project: string;
  workItemId: number;
  workItemTitle?: string;
  branchName?: string;
  skillPath?: string;
  model?: string;
}): Promise<string> {
  const [pack, skillConfig] = await Promise.all([
    buildLocalDevContext({
      project: input.project,
      workItemId: input.workItemId,
    }),
    getSkillConfig(input.project).catch(() => null),
  ]);
  const configured = resolveDevelopmentSettings(skillConfig);
  const chosenSkillPath = input.skillPath?.trim();
  const development = chosenSkillPath
    ? {
        skillPath: chosenSkillPath,
        skillName: skillNameFromPath(chosenSkillPath),
        model: input.model?.trim() || configured.model,
        configuredSkillPath: chosenSkillPath,
        configuredModel: input.model?.trim() || null,
      }
    : configured;
  const workItemTitle = input.workItemTitle?.trim() || `wi-${input.workItemId}`;
  const branchName = input.branchName?.trim()
    || implementationBranchName(input.workItemId, workItemTitle);
  const pullRequestTitle = `[APEX] ${branchName.replace('feature/', '')}`;
  const files = pack.files
    .map((file) => `### ${file.name}\n\n${file.content}`)
    .join('\n\n');
  const descriptionInstructions = buildPullRequestDescriptionInstructions({
    workItemId: input.workItemId,
    pullRequestTitle,
    pullRequestLabel: CLOUD_AGENT_PULL_REQUEST_LABEL,
  });
  const body = [
    `Implement this Azure DevOps work item in the project's configured repository.`,
    `Work item id: ${input.workItemId}.`,
    buildCloudDevelopmentKickoffSection(development),
    `Work on branch \`${branchName}\` and no other branch.`,
    descriptionInstructions
      ?? `Open a pull request titled \`${pullRequestTitle}\`. Write ${buildWorkItemReferenceText(input.workItemId)} in the description. Add the pull request label \`${CLOUD_AGENT_PULL_REQUEST_LABEL}\`.`,
    `Do not change Azure DevOps work item state, due date, or due date reason.`,
    `Do not move this work item or its backlog items to In Pull Request.`,
    files,
  ].join('\n\n');
  return prefixDevelopmentSkillInvocation(body, development);
}

export async function attachCloudAgentEligibility(
  items: AssignedWorkItem[],
  opts: { userId: string; project: string; isSuperAdmin: boolean },
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<AssignedWorkItem[]> {
  const flagEnabled = await deps.isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, {
    userId: opts.userId,
    project: opts.project,
  });
  if (!flagEnabled) {
    return items.map((item) => ({
      ...item,
      cloudAgentEligibility: {
        allowed: false,
        reason: 'Cloud Development is not enabled for this project.',
      },
    }));
  }

  const skillConfig = await deps.getSkillConfig(opts.project);
  const liveByWorkItem = await loadLiveRunWorkItemIds(opts.userId, opts.project);

  return items.map((item) => ({
    ...item,
    cloudAgentEligibility: evaluateCloudAgentEligibility({
      flagEnabled: true,
      project: opts.project,
      item,
      isSuperAdmin: opts.isSuperAdmin,
      skillProvider: skillConfig?.skillProvider,
      skillRepo: skillConfig?.skillRepo,
      skillBranch: skillConfig?.skillBranch,
      hasLiveRun: liveByWorkItem.has(item.id),
    }),
  }));
}

async function loadLiveRunWorkItemIds(userId: string, project: string): Promise<Set<number>> {
  const sessions = await db
    .select({
      workItemId: devSessions.workItemId,
      currentRunId: devSessions.currentRunId,
    })
    .from(devSessions)
    .where(and(eq(devSessions.authorId, userId), eq(devSessions.project, project)));

  const runIds = sessions
    .map((row) => row.currentRunId)
    .filter((id): id is string => Boolean(id));
  if (runIds.length === 0) return new Set();

  const liveRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      inArray(agentRuns.id, runIds),
      eq(agentRuns.workflowClass, 'implementation'),
      inArray(agentRuns.status, [...LIVE_CLOUD_AGENT_STATUSES]),
    ));
  const liveIds = new Set(liveRuns.map((row) => row.id));
  const workItemIds = new Set<number>();
  for (const session of sessions) {
    if (session.workItemId && session.currentRunId && liveIds.has(session.currentRunId)) {
      workItemIds.add(session.workItemId);
    }
  }
  return workItemIds;
}

export interface StartCloudAgentRunInput {
  userId: string;
  project: string;
  workItemId: number;
  workItemTitle?: string;
  initiatorName?: string;
  initiatorEmail?: string;
  adoUserToken?: string | null;
  isSuperAdmin: boolean;
  item: Pick<AssignedWorkItem, 'workItemType' | 'state' | 'tags'>;
  /** Set by the route when cloud-agent-guided-launch is on. */
  launchChooser?: boolean;
  intent?: CloudAgentLaunchIntent;
  skillPath?: string;
  model?: string;
  availableSkills?: CloudAgentSkillChoice[];
  allowedModelIds?: string[];
}

export async function startCloudAgentRun(
  input: StartCloudAgentRunInput,
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<StartCloudAgentRunResponse> {
  const flagEnabled = await deps.isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, {
    userId: input.userId,
    project: input.project,
  });
  const skillConfig = await deps.getSkillConfig(input.project);
  const liveByWorkItem = await loadLiveRunWorkItemIds(input.userId, input.project);
  const eligibility = evaluateCloudAgentEligibility({
    flagEnabled,
    project: input.project,
    item: input.item,
    isSuperAdmin: input.isSuperAdmin,
    skillProvider: skillConfig?.skillProvider,
    skillRepo: skillConfig?.skillRepo,
    skillBranch: skillConfig?.skillBranch,
    hasLiveRun: liveByWorkItem.has(input.workItemId),
  });
  if (!eligibility.allowed) {
    if (liveByWorkItem.has(input.workItemId)) {
      throw new CloudAgentConflictError(eligibility.reason);
    }
    throw new CloudAgentEligibilityError(eligibility.reason ?? 'Cloud Development is not available.');
  }
  if (!skillConfig) {
    throw new CloudAgentEligibilityError('Skill settings are incomplete: skillRepo is not set.');
  }

  const launchSettings = input.launchChooser
    ? await resolveChooserLaunch(input, skillConfig)
    : null;

  try {
    await deps.prepareCloudAgentKickoff({
      project: input.project,
      workItemId: input.workItemId,
      workItemType: input.item.workItemType,
      state: input.item.state,
      ...(launchSettings ? { tagAiCode: true } : {}),
    });
  } catch (err) {
    console.warn(
      '[cloud-agent] kickoff work-item update failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  const started = await persistQueuedRun(input, skillConfig, deps, launchSettings);
  if (input.adoUserToken) pendingCloudAgentUserTokens.set(started.runId, input.adoUserToken);
  if (await claimCloudAgentRun(started.runId)) {
    try {
      await launchClaimedCloudAgentRun(started.runId, deps);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Cloud Agent launch failed';
      console.error('[cloud-agent] launch failed after claim', JSON.stringify({
        runId: started.runId,
        error: detail,
      }));
      try {
        await markTerminal(started.runId, { status: 'failed', detail });
      } catch (markErr) {
        console.error('[cloud-agent] could not record launch failure', JSON.stringify({
          runId: started.runId,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        }));
      }
    }
  }
  trackEvent('cloud_agent_run.started', {
    project: input.project,
    sessionId: started.sessionId,
    runId: started.runId,
  });
  logMyWorkSession('cloud_agent.started', {
    sessionId: started.sessionId,
    project: input.project,
    workItemId: input.workItemId,
    status: 'launched',
  });
  return { sessionId: started.sessionId, runId: started.runId };
}

export async function loadCloudAgentSkillChoices(project: string): Promise<CloudAgentSkillChoice[]> {
  const skillConfig = await getSkillConfig(project).catch(() => null);
  if (!skillConfig?.skillRepo?.trim() || !skillConfig.skillProvider) return [];
  try {
    const skills = await skillCatalog.listSkills(
      project,
      skillConfig.skillRepo,
      skillConfig.skillBranch ?? undefined,
      skillConfig.skillProvider,
    );
    return skills.map((skill) => ({
      name: skill.name,
      path: skill.path,
      description: skill.description ?? '',
    }));
  } catch (err) {
    console.warn(
      '[cloud-agent] skill list failed',
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

export async function getImplementationLaunchOptions(input: {
  userId: string;
  project: string;
  workItemId: number;
  workItemType: string;
  skills: CloudAgentSkillChoice[];
  models: { id: string; displayName: string }[];
}): Promise<CloudAgentLaunchOptions> {
  const skillConfig = await getSkillConfig(input.project).catch(() => null);
  const recommendation = recommendImplementationSkill({
    workItemType: input.workItemType,
    skills: input.skills,
    configuredSkillPath: skillConfig?.developmentSkillPath,
  });
  const prior = await loadPriorCloudAgentSettings({
    userId: input.userId,
    project: input.project,
    workItemId: input.workItemId,
  });
  return {
    recommendedSkillPath: recommendation.skillPath,
    recommendedModel: skillConfig?.developmentModel?.trim() || DEFAULT_DEVELOPMENT_MODEL,
    reason: recommendation.reason,
    skills: input.skills,
    models: input.models,
    priorSkillPath: prior?.skillPath ?? null,
    priorModel: prior?.model ?? null,
  };
}

export async function listGuidedCloudAgentRuns(
  userId: string,
  project: string,
): Promise<GuidedCloudAgentSession[]> {
  const sessions = await db
    .select()
    .from(devSessions)
    .where(and(
      eq(devSessions.authorId, userId),
      eq(devSessions.project, project),
      isNull(devSessions.workItemId),
    ))
    .orderBy(desc(devSessions.updatedAt))
    .limit(10);

  const runs: GuidedCloudAgentSession[] = [];
  for (const session of sessions) {
    if (!session.currentRunId) continue;
    const run = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, session.currentRunId),
    });
    const snapshot = backgroundSnapshot(run?.executionSnapshot);
    if (snapshot?.cloudAgent?.delivery !== 'guided') continue;
    const summary = await getCloudAgentRunStatus(session.id, userId);
    runs.push({
      sessionId: session.id,
      jobId: snapshot.cloudAgent.guidedJobId ?? '',
      title: snapshot.cloudAgent.workItemTitle ?? 'Guided job',
      task: snapshot.cloudAgent.task ?? '',
      skillPath: snapshot.skillPath,
      model: snapshot.model,
      updatedAt: session.updatedAt,
      run: summary,
    });
  }
  return runs;
}

export interface StartGuidedCloudAgentInput {
  userId: string;
  project: string;
  jobId: string;
  task: string;
  intent?: CloudAgentLaunchIntent;
  sessionId?: string;
  skillPath?: string;
  model?: string;
  images?: SiteIssueImage[];
  availableSkills: CloudAgentSkillChoice[];
  allowedModelIds: string[];
  initiatorName?: string;
  initiatorEmail?: string;
}

export async function startGuidedCloudAgentRun(
  input: StartGuidedCloudAgentInput,
): Promise<StartCloudAgentRunResponse> {
  const job = guidedCloudJobById(input.jobId);
  if (!job) throw new CloudAgentLaunchError('Choose a guided job.');
  const task = input.task?.trim() ?? '';
  if (!task || task.length > 4000) {
    throw new CloudAgentLaunchError('Describe the task in 4000 characters or fewer.');
  }
  const skillConfig = await getSkillConfig(input.project);
  const skillProvider = skillConfig?.skillProvider?.trim() ?? '';
  const skillRepo = skillConfig?.skillRepo?.trim() ?? '';
  const skillBranch = skillConfig?.skillBranch?.trim() ?? '';
  if (!skillProvider || !skillRepo || !skillBranch) {
    throw new CloudAgentEligibilityError('Skill settings are incomplete: skillRepo is not set.');
  }
  if (skillProvider === 'github') {
    throw new CloudAgentEligibilityError(
      'Cloud Development supports Azure Repos only. GitHub repositories are not supported yet.',
    );
  }

  const intent = input.intent ?? 'start';
  const prior = intent === 'resume' || intent === 'retry'
    ? await loadPriorCloudAgentSettings({
      userId: input.userId,
      project: input.project,
      sessionId: input.sessionId,
    })
    : null;
  if ((intent === 'resume' || intent === 'retry') && !input.sessionId) {
    throw new CloudAgentLaunchError('Resume and retry need the original guided job.');
  }
  const recommendedPath = recommendGuidedSiteSkill({
    skills: input.availableSkills,
    configuredSkillPath: skillConfig?.developmentSkillPath,
  }).skillPath;
  const selection = resolveCloudAgentLaunchSelection({
    intent,
    recommendedSkillPath: recommendedPath,
    recommendedModel: skillConfig?.developmentModel?.trim() || DEFAULT_DEVELOPMENT_MODEL,
    requestedSkillPath: input.skillPath,
    requestedModel: input.model,
    allowedSkillPaths: input.availableSkills.map((skill) => skill.path),
    allowedModelIds: input.allowedModelIds,
    priorSkillPath: prior?.skillPath,
    priorModel: prior?.model,
  });
  if (!selection.ok) throw new CloudAgentLaunchError(selection.error);

  const taskText = intent === 'resume' && prior?.task ? prior.task : task;
  const images = intent === 'start'
    ? (input.images ?? [])
    : (input.images?.length ? input.images : (prior?.images ?? []));
  const sessionId = intent === 'start' ? uuidv4() : input.sessionId!;
  const branchName = prior?.branchName?.trim()
    || guidedSiteIssueBranchName(sessionId, taskText);
  const skillName = skillNameFromPath(selection.skillPath);
  const prompt = buildGuidedCloudAgentPrompt({
    title: job.title,
    skillPath: selection.skillPath,
    skillName,
    task: taskText,
    branchName,
    imageCount: images.length,
  });
  const nowIso = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + CLOUD_AGENT_QUEUE_WAIT_MS).toISOString();
  const lockKey = `cloud-agent-guided:${input.project}:${sessionId}`;

  const started = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    if (intent !== 'start') {
      const existing = await tx
        .select()
        .from(devSessions)
        .where(and(
          eq(devSessions.id, sessionId),
          eq(devSessions.authorId, input.userId),
          eq(devSessions.project, input.project),
          isNull(devSessions.workItemId),
        ))
        .limit(1);
      const session = existing[0];
      if (!session) throw new CloudAgentLaunchError('Guided job not found.');
      if (session.currentRunId) {
        const current = await tx
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, session.currentRunId))
          .limit(1);
        if (current[0] && LIVE_CLOUD_AGENT_STATUSES.includes(current[0].status as typeof LIVE_CLOUD_AGENT_STATUSES[number])) {
          throw new CloudAgentConflictError('A guided job is already running.');
        }
      }
    } else {
      await tx.insert(devSessions).values({
        id: sessionId,
        project: input.project,
        authorId: input.userId,
        status: 'in_progress',
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    const { runId } = await enqueue({
      threadId: sessionId,
      projectId: input.project,
      timeoutAt,
      lane: 'cloud-agent',
      workflowClass: 'implementation',
      devSessionId: sessionId,
      executor: tx,
      snapshot: {
        prompt,
        model: selection.model,
        workspaceRef: sessionId,
        workflowClass: 'cloud-agent-implementation',
        skillPath: selection.skillPath,
        projectId: input.project,
        threadId: sessionId,
        provider: skillProvider as SkillProvider,
        repository: skillRepo,
        cloudAgent: {
          workItemTitle: guidedTaskTitle(taskText),
          branchName,
          baseBranch: skillBranch,
          initiatorName: input.initiatorName,
          initiatorEmail: input.initiatorEmail,
          delivery: 'guided',
          opensPullRequest: true,
          guidedJobId: job.id,
          task: taskText,
          ...(images.length ? { images } : {}),
          ...(skillName ? { skillName } : {}),
        },
      },
    });

    await tx
      .update(devSessions)
      .set({
        currentRunId: runId,
        currentRunPrUrl: null,
        currentRunPrStatus: 'none',
        branchName,
        status: 'in_progress',
        leftoverWork: null,
        updatedAt: nowIso,
      })
      .where(eq(devSessions.id, sessionId));

    return { sessionId, runId };
  });

  if (await claimCloudAgentRun(started.runId)) {
    try {
      await launchClaimedCloudAgentRun(started.runId, defaultDeps);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Cloud Agent launch failed';
      try {
        await markTerminal(started.runId, { status: 'failed', detail });
      } catch (markErr) {
        console.error('[cloud-agent] could not record guided launch failure', JSON.stringify({
          runId: started.runId,
          error: markErr instanceof Error ? markErr.message : String(markErr),
        }));
      }
    }
  }
  return started;
}

interface PersistedCloudAgentRun {
  sessionId: string;
  runId: string;
  executionPrompt: string;
}

async function resolveChooserLaunch(
  input: StartCloudAgentRunInput,
  skillConfig: ProjectSkillConfig,
): Promise<{ skillPath: string; model: string }> {
  const intent = input.intent ?? 'start';
  const prior = intent === 'resume'
    ? await loadPriorCloudAgentSettings({
      userId: input.userId,
      project: input.project,
      workItemId: input.workItemId,
    })
    : null;
  const recommendation = recommendImplementationSkill({
    workItemType: input.item.workItemType,
    skills: input.availableSkills ?? [],
    configuredSkillPath: skillConfig.developmentSkillPath,
  });
  const selection = resolveCloudAgentLaunchSelection({
    intent,
    recommendedSkillPath: recommendation.skillPath,
    recommendedModel: skillConfig.developmentModel?.trim() || DEFAULT_DEVELOPMENT_MODEL,
    requestedSkillPath: input.skillPath,
    requestedModel: input.model,
    allowedSkillPaths: (input.availableSkills ?? []).map((skill) => skill.path),
    allowedModelIds: input.allowedModelIds ?? [],
    priorSkillPath: prior?.skillPath,
    priorModel: prior?.model,
  });
  if (!selection.ok) throw new CloudAgentLaunchError(selection.error);
  return { skillPath: selection.skillPath, model: selection.model };
}

async function loadPriorCloudAgentSettings(input: {
  userId: string;
  project: string;
  workItemId?: number | null;
  sessionId?: string | null;
}): Promise<{
  skillPath: string;
  model: string;
  task: string | null;
  guidedJobId: string | null;
  branchName: string | null;
  images: SiteIssueImage[];
} | null> {
  const rows = input.sessionId
    ? await db
      .select({ currentRunId: devSessions.currentRunId })
      .from(devSessions)
      .where(and(
        eq(devSessions.id, input.sessionId),
        eq(devSessions.authorId, input.userId),
        eq(devSessions.project, input.project),
      ))
      .limit(1)
    : await db
      .select({ currentRunId: devSessions.currentRunId })
      .from(devSessions)
      .where(and(
        eq(devSessions.authorId, input.userId),
        eq(devSessions.project, input.project),
        eq(devSessions.workItemId, input.workItemId ?? -1),
      ))
      .orderBy(desc(devSessions.createdAt))
      .limit(1);
  const runId = rows[0]?.currentRunId;
  if (!runId) return null;
  const run = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, runId) });
  const snapshot = backgroundSnapshot(run?.executionSnapshot);
  const skillPath = snapshot?.skillPath?.trim();
  const model = snapshot?.model?.trim();
  if (!skillPath || !model) return null;
  return {
    skillPath,
    model,
    task: snapshot?.cloudAgent?.task?.trim() || null,
    guidedJobId: snapshot?.cloudAgent?.guidedJobId ?? null,
    branchName: snapshot?.cloudAgent?.branchName?.trim() || null,
    images: (snapshot?.cloudAgent?.images ?? []).flatMap((image) => {
      if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg' && image.mimeType !== 'image/webp') {
        return [];
      }
      return [{ name: image.name, mimeType: image.mimeType, data: image.data }];
    }),
  };
}

function guidedTaskTitle(task: string): string {
  const trimmed = task.replace(/\s+/g, ' ').trim();
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79)}…`;
}

async function persistQueuedRun(
  input: StartCloudAgentRunInput,
  skillConfig: ProjectSkillConfig,
  deps: CloudAgentServiceDeps,
  launchSettings: { skillPath: string; model: string } | null = null,
): Promise<PersistedCloudAgentRun> {
  const lockKey = `cloud-agent:${input.project}:${input.workItemId}:${input.userId}`;
  const nowIso = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + CLOUD_AGENT_QUEUE_WAIT_MS).toISOString();
  const workItemTitle = input.workItemTitle?.trim() || `wi-${input.workItemId}`;
  const branchName = implementationBranchName(input.workItemId, workItemTitle);
  const basePrompt = await deps.buildPrompt({
    project: input.project,
    workItemId: input.workItemId,
    workItemTitle,
    branchName,
    ...(launchSettings
      ? { skillPath: launchSettings.skillPath, model: launchSettings.model }
      : {}),
  });
  const configuredDevelopment = resolveDevelopmentSettings(skillConfig);
  const development = launchSettings
    ? {
        ...configuredDevelopment,
        skillPath: launchSettings.skillPath,
        skillName: skillNameFromPath(launchSettings.skillPath),
        model: launchSettings.model,
        configuredSkillPath: launchSettings.skillPath,
        configuredModel: launchSettings.model,
      }
    : configuredDevelopment;
  const { model, skillPath } = development;
  const skillName = developmentCliSkillName(development);

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const existingRows = await tx
        .select()
        .from(devSessions)
        .where(and(
          eq(devSessions.authorId, input.userId),
          eq(devSessions.project, input.project),
          eq(devSessions.workItemId, input.workItemId),
        ))
        .orderBy(desc(devSessions.createdAt))
        .limit(1);
      const existing = existingRows[0];

      if (existing?.currentRunId) {
        const currentRows = await tx
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, existing.currentRunId))
          .limit(1);
        const current = currentRows[0];
        if (current && LIVE_CLOUD_AGENT_STATUSES.includes(current.status as typeof LIVE_CLOUD_AGENT_STATUSES[number])) {
          throw new CloudAgentConflictError();
        }
      }

      const sessionId = existing?.id ?? uuidv4();
      const priorWork = formatLeftoverWorkForResumePrompt(existing?.leftoverWork);
      const executionPrompt = priorWork
        ? `${basePrompt}\n\n${priorWork}`
        : basePrompt;
      if (!existing) {
        await tx.insert(devSessions).values({
          id: sessionId,
          workItemId: input.workItemId,
          project: input.project,
          authorId: input.userId,
          status: 'setting_up',
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }

      const { runId } = await enqueue({
        threadId: sessionId,
        projectId: input.project,
        timeoutAt,
        lane: 'cloud-agent',
        workflowClass: 'implementation',
        devSessionId: sessionId,
        executor: tx,
        snapshot: {
          prompt: executionPrompt,
          model,
          workspaceRef: sessionId,
          workflowClass: 'cloud-agent-implementation',
          skillPath,
          projectId: input.project,
          threadId: sessionId,
          provider: (skillConfig.skillProvider ?? 'ado') as SkillProvider,
          repository: skillConfig.skillRepo,
          cloudAgent: {
            workItemId: input.workItemId,
            workItemTitle: input.workItemTitle,
            branchName,
            baseBranch: skillConfig.skillBranch,
            initiatorName: input.initiatorName,
            initiatorEmail: input.initiatorEmail,
            ...(skillName ? { skillName } : {}),
            ...(input.adoUserToken ? { userTokenInstance: cloudAgentInstanceId() } : {}),
          },
        },
      });

      await tx
        .update(devSessions)
        .set({
          currentRunId: runId,
          currentRunPrUrl: null,
          currentRunPrStatus: 'none',
          branchName,
          status: 'in_progress',
          leftoverWork: null,
          updatedAt: nowIso,
        })
        .where(eq(devSessions.id, sessionId));

      return { sessionId, runId, executionPrompt };
    });
  } catch (err) {
    if (err instanceof CloudAgentConflictError) throw err;
    if (isUniqueViolation(err)) throw new CloudAgentConflictError();
    throw err;
  }
}

function scheduleCloudAgentDispatch(): void {
  setImmediate(() => {
    void pumpCloudAgentQueue().catch((err) => {
      console.error('[cloud-agent] launch recovery failed', err instanceof Error ? err.message : err);
    });
  });
}

function takeCloudAgentUserToken(runId: string): string | null {
  const token = pendingCloudAgentUserTokens.get(runId) ?? null;
  pendingCloudAgentUserTokens.delete(runId);
  return token;
}

/** Marks one saved run so this process can send it to Cursor. */
async function claimCloudAgentRun(runId: string): Promise<boolean> {
  const instance = cloudAgentInstanceId();
  const nowMs = Date.now();
  const updated = await db
    .update(agentRuns)
    .set({
      ownerInstance: instance,
      timeoutAt: cloudAgentPreIdentityTimeoutAt(0, nowMs),
      updatedAt: new Date(nowMs).toISOString(),
    })
    .where(and(
      eq(agentRuns.id, runId),
      eq(agentRuns.status, 'queued'),
      eq(agentRuns.cancelRequested, false),
      sql`${agentRuns.ownerInstance} IS NULL`,
      sql`${agentRuns.cloudAgentIdentity} IS NULL`,
    ))
    .returning({ id: agentRuns.id });
  return Array.isArray(updated) && updated.length > 0;
}

/** Claims saved runs that never reached Cursor. There is no launch cap. */
async function claimCloudAgentRunIds(): Promise<string[]> {
  const instance = cloudAgentInstanceId();
  const tokenClaimCutoff = new Date(Date.now() - CLOUD_AGENT_USER_TOKEN_CLAIM_MS).toISOString();
  const tokenInstance = sql`${agentRuns.executionSnapshot}->'cloudAgent'->>'userTokenInstance'`;
  const waiting = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.lane, 'cloud-agent'),
      eq(agentRuns.status, 'queued'),
      eq(agentRuns.cancelRequested, false),
      sql`${agentRuns.ownerInstance} IS NULL`,
      sql`${agentRuns.cloudAgentIdentity} IS NULL`,
      sql`(${tokenInstance} IS NULL OR ${tokenInstance} = ${instance} OR ${agentRuns.queuedAt} <= ${tokenClaimCutoff})`,
    ))
    .orderBy(asc(agentRuns.queuedAt), asc(agentRuns.id));

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ids: string[] = [];
  for (const [index, candidate] of waiting.entries()) {
    const updated = await db
      .update(agentRuns)
      .set({
        ownerInstance: instance,
        timeoutAt: cloudAgentPreIdentityTimeoutAt(index, nowMs),
        updatedAt: nowIso,
      })
      .where(and(
        eq(agentRuns.id, candidate.id),
        eq(agentRuns.status, 'queued'),
        sql`${agentRuns.ownerInstance} IS NULL`,
      ))
      .returning({ id: agentRuns.id });
    if (Array.isArray(updated) && updated[0]) ids.push(updated[0].id);
  }
  return ids;
}

async function launchClaimedCloudAgentRun(
  runId: string,
  deps: CloudAgentServiceDeps,
): Promise<void> {
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });
  const snapshot = backgroundSnapshot(run?.executionSnapshot);
  const cloud = snapshot?.cloudAgent;
  const guided = cloud?.delivery === 'guided';
  const sessionId = run?.devSessionId ?? snapshot?.threadId ?? null;
  if (!run || run.status !== 'queued' || run.cloudAgentIdentity) {
    pendingCloudAgentUserTokens.delete(runId);
    return;
  }
  if (
    !sessionId
    || !snapshot?.prompt
    || !snapshot.model
    || !snapshot.projectId
    || !snapshot.repository
    || !cloud?.baseBranch
    || (!guided && !cloud.workItemId)
  ) {
    pendingCloudAgentUserTokens.delete(runId);
    const detail = 'Cloud Agent run is missing its saved repository settings.';
    await markTerminal(runId, { status: 'failed', detail });
    if (sessionId && snapshot?.projectId) {
      emitTerminal({ sessionId, runId }, snapshot.projectId, 'failed', null);
    }
    scheduleCloudAgentDispatch();
    return;
  }

  const adoUserToken = takeCloudAgentUserToken(runId);
  if (!adoUserToken && !guided) {
    console.warn('[cloud-agent] queued run has no developer token; the pull request will be opened by the service account', JSON.stringify({
      runId,
    }));
  }

  let launched: LaunchCloudAgentResult;
  try {
    launched = await deps.launchCloudAgent({
      project: snapshot.projectId,
      prompt: snapshot.prompt,
      model: snapshot.model,
      skillProvider: (snapshot.provider ?? 'ado') as SkillProvider,
      skillRepo: snapshot.repository,
      skillBranch: cloud.baseBranch,
      workItemId: cloud.workItemId,
      workItemTitle: cloud.workItemTitle ?? (cloud.workItemId ? `Work item ${cloud.workItemId}` : 'Guided job'),
      initiatorName: cloud.initiatorName,
      initiatorEmail: cloud.initiatorEmail,
      skillName: cloud.skillName,
      adoUserToken,
      autoCreatePr: !guided || cloud.opensPullRequest === true,
      images: (cloud.images ?? []).flatMap((image) => (
        image.data && image.mimeType
          ? [{ data: image.data, mimeType: image.mimeType }]
          : []
      )),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Cloud Agent launch failed';
    console.error('[cloud-agent] launch failed', JSON.stringify({
      runId,
      sessionId,
      project: snapshot.projectId,
      workItemId: cloud.workItemId,
      model: snapshot.model,
      skillProvider: snapshot.provider ?? 'ado',
      skillRepo: snapshot.repository,
      skillBranch: cloud.baseBranch,
      error: detail,
    }));
    const terminal = await markTerminal(runId, { status: 'failed', detail });
    if (!terminal.ok) {
      console.error('[cloud-agent] could not record launch failure', JSON.stringify({
        runId,
        reason: terminal.reason,
        status: terminal.run?.status ?? null,
      }));
    }
    emitTerminal({ sessionId, runId }, snapshot.projectId, 'failed', null);
    scheduleCloudAgentDispatch();
    return;
  }

  const timeoutAt = new Date(Date.now() + resolveCloudAgentRunLimitMs()).toISOString();
  let identityStored = false;
  try {
    const captured = await captureCloudAgentIdentity(runId, {
      cloudAgentIdentity: launched.cloudAgentId,
      cursorRunId: launched.cursorRunId,
      jobName: launched.jobName,
      branchName: launched.branchName,
      timeoutAt,
    });
    if (!captured.ok) {
      if (captured.reason === 'run_cancelled') {
        console.warn('[cloud-agent] run was cancelled while its job was starting; stopping the job', JSON.stringify({
          runId,
          jobExecution: launched.cursorRunId,
        }));
        await stopUntrackedCloudAgent(deps, snapshot.projectId, launched, runId);
      } else if (
        captured.reason === 'identity_already_set'
        && captured.run?.cloudAgentIdentity !== launched.cloudAgentId
      ) {
        console.error('[cloud-agent] could not record the Cursor agent', JSON.stringify({
          runId,
          reason: captured.reason,
        }));
        await stopUntrackedCloudAgent(deps, snapshot.projectId, launched, runId);
      } else if (captured.reason !== 'identity_already_set') {
        const detail = captured.reason ?? 'Could not record the Cloud Agent';
        console.error('[cloud-agent] could not record the Cursor agent', JSON.stringify({
          runId,
          reason: captured.reason ?? null,
        }));
        await failLaunchAfterCursorCreate(
          deps,
          snapshot.projectId,
          sessionId,
          launched,
          runId,
          detail,
          captured.run,
        );
      }
      scheduleCloudAgentDispatch();
      return;
    }
    identityStored = true;
    if (launched.branchName) {
      await db
        .update(devSessions)
        .set({
          branchName: launched.branchName,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(devSessions.id, sessionId));
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Cloud Agent launch failed';
    console.error('[cloud-agent] launch failed after the Cursor agent was created', JSON.stringify({
      runId,
      sessionId,
      cloudAgentId: launched.cloudAgentId,
      error: detail,
    }));
    if (!identityStored) {
      const latest = await db.query.agentRuns.findFirst({
        where: eq(agentRuns.id, runId),
      });
      await failLaunchAfterCursorCreate(
        deps,
        snapshot.projectId,
        sessionId,
        launched,
        runId,
        detail,
        latest ?? null,
      );
    }
    scheduleCloudAgentDispatch();
  }
}

/**
 * Fails the Apex row after Cursor already created an agent. Identity capture
 * writes `dispatchMessageId` before the queued → running move, so a later
 * failure must present that fence or `markTerminal` leaves the row queued.
 */
async function failLaunchAfterCursorCreate(
  deps: CloudAgentServiceDeps,
  projectId: string,
  sessionId: string,
  launched: LaunchCloudAgentResult,
  runId: string,
  detail: string,
  recorded: { dispatchMessageId?: string | null; cloudAgentIdentity?: string | null } | null,
): Promise<void> {
  const ours = recorded?.cloudAgentIdentity === launched.cloudAgentId
    || recorded?.dispatchMessageId === launched.cursorRunId;
  const fence = ours
    ? (recorded?.dispatchMessageId ?? launched.cursorRunId)
    : null;
  await stopUntrackedCloudAgent(deps, projectId, launched, runId);
  const terminal = await markTerminal(runId, {
    status: 'failed',
    detail,
    ...(fence ? { dispatchMessageId: fence } : {}),
  });
  if (!terminal.ok) {
    console.error('[cloud-agent] could not record launch failure', JSON.stringify({
      runId,
      reason: terminal.reason,
      status: terminal.run?.status ?? null,
    }));
  }
  emitTerminal({ sessionId, runId }, projectId, 'failed', null);
}

async function stopUntrackedCloudAgent(
  deps: CloudAgentServiceDeps,
  project: string,
  launched: LaunchCloudAgentResult,
  runId: string,
): Promise<void> {
  try {
    await deps.cancelCursorCloudAgentRun({
      project,
      cloudAgentId: launched.cloudAgentId,
      cursorRunId: launched.cursorRunId,
    });
  } catch (err) {
    console.error('[cloud-agent] could not stop the job for a run that was not recorded', JSON.stringify({
      runId,
      jobExecution: launched.cursorRunId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Marks container executions that have already finished, failed, or been
 * cancelled. The My Work page poll does this too; this sweep covers a run
 * whose page is closed. It reads the execution status and the pull-request
 * line the container already wrote. It does not open a pull request.
 */
export async function reconcileRunningCloudAgentRuns(
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<void> {
  if (cloudAgentReconcileRunning) return;
  cloudAgentReconcileRunning = true;
  try {
    const rows = await db
      .select({
        id: agentRuns.id,
        projectId: agentRuns.projectId,
        threadId: agentRuns.threadId,
        devSessionId: agentRuns.devSessionId,
        cloudAgentIdentity: agentRuns.cloudAgentIdentity,
        dispatchMessageId: agentRuns.dispatchMessageId,
        executionSnapshot: agentRuns.executionSnapshot,
      })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.lane, 'cloud-agent'),
        eq(agentRuns.cloudAgentManaged, true),
        inArray(agentRuns.status, ['dispatched', 'running']),
        sql`${agentRuns.cloudAgentIdentity} IS NOT NULL`,
        sql`${agentRuns.dispatchMessageId} IS NOT NULL`,
      ));

    for (const row of rows) {
      const sessionId = row.devSessionId ?? row.threadId;
      if (!row.projectId || !row.cloudAgentIdentity || !row.dispatchMessageId || !sessionId) {
        console.warn('[cloud-agent] skipped reconciliation for an incomplete execution row', JSON.stringify({
          runId: row.id,
        }));
        continue;
      }
      try {
        const observed = await deps.getCloudAgentRun({
          project: row.projectId,
          cloudAgentId: row.cloudAgentIdentity,
          cursorRunId: row.dispatchMessageId,
        });
        const mapped = mapObservedStatus(observed.status);
        if (!mapped || !isAgentRunTerminalStatus(mapped)) continue;
        const skipPullRequest = guidedSkipsPullRequest(row.executionSnapshot);
        if (
          !skipPullRequest
          && awaitingCloudAgentPullRequest({
            status: mapped,
            prUrl: observed.prUrl,
            noChanges: observed.noChanges,
            branchName: observed.branchName,
          })
          && !(await cloudAgentPullRequestWaitExpired(row))
        ) {
          continue;
        }
        await applyCloudAgentCompletion({
          runId: row.id,
          sessionId,
          project: row.projectId,
          status: mapped,
          prUrl: observed.prUrl,
          dispatchMessageId: row.dispatchMessageId,
          detail: mapped === 'failed' ? (observed.resultText ?? undefined) : undefined,
          usage: usageFromObservation(observed),
          analysisOnly: skipPullRequest,
        }, deps);
      } catch (err) {
        console.warn('[cloud-agent] execution reconciliation failed', JSON.stringify({
          runId: row.id,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  } catch (err) {
    console.error('[cloud-agent] execution reconciliation failed', err instanceof Error ? err.message : err);
  } finally {
    cloudAgentReconcileRunning = false;
  }
}

async function extendCloudAgentLaunchTimeouts(runIds: string[]): Promise<void> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  for (let index = 0; index < runIds.length; index += 1) {
    await db
      .update(agentRuns)
      .set({
        timeoutAt: cloudAgentPreIdentityTimeoutAt(index, nowMs),
        updatedAt: nowIso,
      })
      .where(and(
        eq(agentRuns.id, runIds[index]),
        eq(agentRuns.status, 'queued'),
        sql`${agentRuns.cloudAgentIdentity} IS NULL`,
      ));
  }
}

/** Sends saved cloud-agent runs that never reached Cursor. */
export async function pumpCloudAgentQueue(
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<void> {
  if (cloudAgentQueuePumpRunning) return;
  cloudAgentQueuePumpRunning = true;
  try {
    const claimed = await claimCloudAgentRunIds();
    for (let index = 0; index < claimed.length; index += 1) {
      // A slow start must not leave the runs behind it on the deadline from
      // when this recovery batch was claimed.
      await extendCloudAgentLaunchTimeouts(claimed.slice(index));
      await launchClaimedCloudAgentRun(claimed[index], deps);
    }
  } catch (err) {
    console.error('[cloud-agent] launch recovery failed', err instanceof Error ? err.message : err);
  } finally {
    cloudAgentQueuePumpRunning = false;
  }
}

function emitTerminal(
  started: { sessionId: string; runId: string },
  project: string,
  status: string,
  terminalReason: string | null,
): void {
  trackEvent('cloud_agent_run.terminal', {
    project,
    sessionId: started.sessionId,
    runId: started.runId,
    status,
    ...(terminalReason ? { terminalReason } : {}),
  });
}

async function lookupPullRequestStatus(
  input: {
    prUrl: string;
    provider: SkillProvider;
    repository: string;
    project: string;
  },
  deps: CloudAgentServiceDeps,
): Promise<'open' | 'abandoned' | 'merged'> {
  const pullRequestId = parsePullRequestNumber(input.prUrl, input.provider);
  if (input.provider === 'github') {
    return deps.getGithubPullRequestStatus(input.repository, pullRequestId);
  }
  const repository = input.repository.split('/').filter(Boolean).pop() ?? input.repository;
  return deps.getAdoPullRequestStatus(repository, input.project, pullRequestId);
}

function cachedPullRequestStatus(
  prUrl: string | null,
  storedStatus: HostAgnosticPrStatus | null | undefined,
): HostAgnosticPrStatus {
  if (!prUrl) return 'none';
  if (storedStatus === 'merged' || storedStatus === 'abandoned') return storedStatus;
  return 'open';
}

async function writeWorkItemPullRequest(
  input: {
    provider: SkillProvider;
    project: string;
    repository: string;
    prUrl: string;
    workItemId: number;
    runId: string;
    sessionId: string;
    titleBranch?: string | null;
  },
  deps: CloudAgentServiceDeps,
): Promise<void> {
  const linkInput = {
    provider: input.provider,
    project: input.project,
    repo: input.repository,
    prUrl: input.prUrl,
    workItemId: input.workItemId,
    runId: input.runId,
    sessionId: input.sessionId,
  };

  if (input.provider !== 'github' && input.titleBranch) {
    try {
      await deps.alignCloudAgentPullRequest({
        project: input.project,
        repo: input.repository,
        prUrl: input.prUrl,
        workItemId: input.workItemId,
        sourceBranch: input.titleBranch,
        titleBranch: input.titleBranch,
      });
    } catch (err) {
      console.warn('[cloud-agent] could not set the pull request title', JSON.stringify({
        runId: input.runId,
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  if (input.provider === 'github') {
    try {
      await deps.linkWorkItemToPullRequest(linkInput);
    } catch (err) {
      console.warn('[cloud-agent] GitHub AB# verification failed', JSON.stringify({
        runId: input.runId,
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    await deps.retryWithBackoff(
      () => deps.addAdoWorkItemHyperlink(
        input.project,
        input.workItemId,
        input.prUrl,
        'Implementation PR',
      ),
      { maxRetries: 3, initialDelay: 250, shouldRetry: () => true, jitter: true },
    );
    return;
  }

  await deps.retryWithBackoff(
    () => deps.linkWorkItemToPullRequest(linkInput),
    { maxRetries: 3, initialDelay: 250, shouldRetry: () => true, jitter: true },
  );
}

function cloudAgentWasLaunched(run: {
  cloudAgentIdentity?: string | null;
  dispatchMessageId?: string | null;
}): boolean {
  return Boolean(run.cloudAgentIdentity?.trim() || run.dispatchMessageId?.trim());
}

function usageFromObservation(
  observed: CloudAgentRunObservation | null | undefined,
): Pick<RecordCloudAgentUsageInput, 'modelId' | 'durationMs' | 'resultText' | 'tokens'> {
  return {
    modelId: observed?.modelId ?? null,
    durationMs: observed?.durationMs ?? null,
    resultText: observed?.resultText ?? null,
    tokens: observed?.usage ?? null,
  };
}

async function trackCloudAgentSpend(input: RecordCloudAgentUsageInput): Promise<void> {
  try {
    await recordCloudAgentUsage(input);
  } catch (err) {
    console.warn('[cloud-agent] could not record AI cost', JSON.stringify({
      runId: input.runId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

async function trackLaunchedCloudAgentSpend(
  run: {
    id: string;
    cloudAgentIdentity?: string | null;
    dispatchMessageId?: string | null;
  },
  project: string,
  status: RecordCloudAgentUsageInput['status'],
  deps: CloudAgentServiceDeps,
): Promise<void> {
  if (!cloudAgentWasLaunched(run)) return;
  let observed: CloudAgentRunObservation | null = null;
  if (run.cloudAgentIdentity && run.dispatchMessageId) {
    try {
      observed = await deps.getCloudAgentRun({
        project,
        cloudAgentId: run.cloudAgentIdentity,
        cursorRunId: run.dispatchMessageId,
      });
    } catch (err) {
      console.warn('[cloud-agent] could not read usage before recording cost', JSON.stringify({
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
  await trackCloudAgentSpend({
    runId: run.id,
    project,
    status,
    ...usageFromObservation(observed),
  });
}

export async function applyCloudAgentCompletion(input: {
  runId: string;
  sessionId: string;
  project: string;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  prUrl: string | null;
  terminalReason?: AgentRunTerminalReason;
  detail?: string;
  dispatchMessageId?: string;
  /** Cursor token usage captured when the run was observed. */
  usage?: Pick<RecordCloudAgentUsageInput, 'modelId' | 'durationMs' | 'resultText' | 'tokens'> | null;
  /**
   * Suite-level outcomes when the run reported them through the structured
   * completion contract. Failing suites never gate PR creation or terminal state.
   */
  checkResults?: RunCheckResult[];
  incompleteAcceptanceCriteria?: string[];
  analysisOnly?: boolean;
}, deps: CloudAgentServiceDeps = defaultDeps): Promise<void> {
  const terminal = await markTerminal(input.runId, {
    status: input.status,
    terminalReason: input.terminalReason,
    detail: input.detail,
    ...(input.dispatchMessageId ? { dispatchMessageId: input.dispatchMessageId } : {}),
    ...(input.checkResults ? { checkResults: input.checkResults } : {}),
  });
  if (!terminal.ok) return;
  scheduleCloudAgentDispatch();
  await trackCloudAgentSpend({
    runId: input.runId,
    project: input.project,
    status: input.status,
    modelId: input.usage?.modelId,
    durationMs: input.usage?.durationMs,
    resultText: input.usage?.resultText ?? input.detail ?? null,
    tokens: input.usage?.tokens,
  });

  if (terminal.run.devSessionId && terminal.run.devSessionId !== input.sessionId) {
    console.warn('[cloud-agent] completion session mismatch', JSON.stringify({
      runId: input.runId,
      sessionId: input.sessionId,
    }));
    return;
  }

  // Cloud-Agent runs always own devSessionId. The input fallback preserves
  // compatibility for implementation runs created before that field existed.
  const sessionId = terminal.run.devSessionId ?? input.sessionId;
  const session = await db.query.devSessions.findFirst({
    where: and(
      eq(devSessions.id, sessionId),
      eq(devSessions.project, input.project),
    ),
  });
  if (!session) return;

  const terminalSnapshot = backgroundSnapshot(terminal.run.executionSnapshot);
  const provider = terminalSnapshot?.provider;
  const repository = terminalSnapshot?.repository;
  // markTerminal accepts a repeat completion of an already-completed run, so a
  // caller holding an older observation can arrive here with no pull request
  // after another one recorded it. Keep the recorded url rather than clear it.
  const prUrl = input.prUrl
    ?? (session.currentRunId === input.runId ? session.currentRunPrUrl : null);
  let prStatus: HostAgnosticPrStatus = prUrl ? 'open' : 'none';
  if (prUrl && provider && repository) {
    try {
      prStatus = await lookupPullRequestStatus({
        prUrl,
        provider,
        repository,
        project: input.project,
      }, deps);
    } catch (err) {
      console.warn('[cloud-agent] initial PR status lookup failed', JSON.stringify({
        runId: input.runId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const nowIso = new Date().toISOString();
  await db
    .update(agentRuns)
    .set({
      cloudPrUrl: prUrl,
      cloudPrStatus: prStatus,
      updatedAt: nowIso,
    })
    .where(eq(agentRuns.id, input.runId));

  await db
    .update(devSessions)
    .set({
      currentRunPrUrl: prUrl,
      currentRunPrStatus: prStatus,
      updatedAt: nowIso,
    })
    .where(eq(devSessions.id, sessionId));

  if (input.analysisOnly) {
    emitTerminal(
      { sessionId, runId: input.runId },
      input.project,
      input.status,
      input.terminalReason ?? null,
    );
    return;
  }

  const summary = computeLeftoverWorkSummary({
    checkResults: terminal.run.checkResults ?? input.checkResults,
    prUrl,
    incompleteAcceptanceCriteria: input.incompleteAcceptanceCriteria,
  });
  const persisted = await deps.persistLeftoverWork({
    sessionId,
    project: input.project,
    summary,
  });

  // ADO appends only when this callback won the leftover_work IS NULL write.
  // Resume clears leftoverWork to null at enqueue so the next terminal run
  // can win again. Clean summaries persist null and never set firstWrite.
  if (persisted.firstWrite && summary && session.workItemId) {
    await deps.writeLeftoverWorkToAdo({
      sessionId,
      project: input.project,
      workItemId: session.workItemId,
      runId: input.runId,
      summary,
    });
  }

  emitTerminal(
    { sessionId, runId: input.runId },
    input.project,
    input.status,
    input.terminalReason ?? null,
  );

  if (!prUrl || !session.workItemId) return;
  try {
    if (!provider || !repository) {
      throw new Error('Cloud Agent run is missing work-item repository context');
    }
    await writeWorkItemPullRequest({
      provider,
      project: input.project,
      repository,
      prUrl,
      workItemId: session.workItemId,
      runId: input.runId,
      sessionId,
      titleBranch: terminalSnapshot?.cloudAgent?.branchName ?? session.branchName ?? null,
    }, deps);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[cloud-agent] work-item PR write exhausted retries', JSON.stringify({
      runId: input.runId,
      sessionId,
      error,
    }));
    trackEvent('cloud_agent_run.work_item_reference_failed', {
      project: input.project,
      runId: input.runId,
      sessionId,
      error,
    });
  }
}

export async function getCloudAgentRunStatus(
  sessionId: string,
  userId: string,
  deps: CloudAgentServiceDeps = defaultDeps,
  _adoUserToken: string | null = null,
): Promise<CloudAgentRunSummary | null> {
  const session = await db.query.devSessions.findFirst({
    where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
  });
  if (!session?.currentRunId) return null;

  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, session.currentRunId),
  });
  if (!run) return null;
  const skipPullRequest = guidedSkipsPullRequest(run.executionSnapshot);

  if (
    run.lane === 'cloud-agent'
    && run.cloudAgentManaged
    && run.cloudAgentIdentity
    && run.dispatchMessageId
    && !isAgentRunTerminalStatus(run.status)
  ) {
    try {
      const observed = await deps.getCloudAgentRun({
        project: session.project,
        cloudAgentId: run.cloudAgentIdentity,
        cursorRunId: run.dispatchMessageId,
      });
      const mapped = mapObservedStatus(observed.status);
      const prUrl = observed.prUrl;
      const canonicalBranch = metaBranchName(run.executionSnapshot);
      const pushedBranch = observed.noChanges ? null : observed.branchName ?? run.cloudBranchName;
      if (canonicalBranch && pushedBranch && pushedBranch !== canonicalBranch) {
        console.warn('[cloud-agent] pushed branch does not match the required name', JSON.stringify({
          runId: run.id,
          required: canonicalBranch,
          pushed: pushedBranch,
        }));
      }
      const waitingForPullRequest = !skipPullRequest && awaitingCloudAgentPullRequest({
        status: mapped,
        prUrl,
        noChanges: observed.noChanges,
        branchName: pushedBranch,
      }) && !(await cloudAgentPullRequestWaitExpired(run));
      if (mapped && isAgentRunTerminalStatus(mapped) && !waitingForPullRequest) {
        await applyCloudAgentCompletion({
          runId: run.id,
          sessionId,
          project: session.project,
          status: mapped,
          prUrl,
          dispatchMessageId: run.dispatchMessageId,
          detail: mapped === 'failed' ? (observed.resultText ?? undefined) : undefined,
          usage: usageFromObservation(observed),
          analysisOnly: skipPullRequest,
        }, deps);
        return toRunSummary(
          {
            id: run.id,
            status: mapped,
            terminalReason: run.terminalReason as AgentRunTerminalReason | null,
            checkResults: run.checkResults ?? null,
            lastError: mapped === 'failed' ? observed.resultText : run.lastError,
            cloudAgentIdentity: run.cloudAgentIdentity,
            cloudBranchName: run.cloudBranchName,
            createdAt: run.createdAt,
          },
          prUrl,
          cachedPullRequestStatus(prUrl, null),
          !skipPullRequest,
        );
      }
    } catch (err) {
      if (err instanceof CloudAgentPullRequestDeferred) {
        return toRunSummary(
          {
            id: run.id,
            status: 'running',
            terminalReason: null,
            checkResults: run.checkResults ?? null,
            lastError: null,
            cloudAgentIdentity: run.cloudAgentIdentity,
          },
          null,
          'none',
          !skipPullRequest,
        );
      }
      console.warn('[cloud-agent] status refresh failed', JSON.stringify({
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const prUrl = run.cloudPrUrl ?? session.currentRunPrUrl ?? null;
  let prStatus = cachedPullRequestStatus(
    prUrl,
    run.cloudPrStatus ?? session.currentRunPrStatus,
  );
  if (prUrl && prStatus !== 'merged') {
    try {
      const provider = backgroundSnapshot(run.executionSnapshot)?.provider;
      const repository = backgroundSnapshot(run.executionSnapshot)?.repository;
      if (!provider || !repository) {
        throw new Error('Cloud Agent run is missing repository context for PR status');
      }
      const refreshedStatus = await lookupPullRequestStatus({
        prUrl,
        provider,
        repository,
        project: session.project,
      }, deps);
      if (refreshedStatus !== prStatus) {
        prStatus = refreshedStatus;
        const updatedAt = new Date().toISOString();
        await db
          .update(agentRuns)
          .set({ cloudPrStatus: refreshedStatus, updatedAt })
          .where(eq(agentRuns.id, run.id));
        await db
          .update(devSessions)
          .set({ currentRunPrStatus: refreshedStatus, updatedAt })
          .where(eq(devSessions.id, sessionId));
      }
    } catch (err) {
      console.warn('[cloud-agent] PR status refresh failed', JSON.stringify({
        runId: run.id,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return toRunSummary(
    {
      id: run.id,
      status: run.status,
      terminalReason: run.terminalReason as AgentRunTerminalReason | null,
      checkResults: run.checkResults ?? null,
      lastError: run.lastError,
      cloudAgentIdentity: run.cloudAgentIdentity,
      cloudBranchName: run.cloudBranchName,
      createdAt: run.createdAt,
    },
    prUrl,
    prStatus,
    !skipPullRequest,
  );
}

export async function getCloudAgentRunHistory(
  sessionId: string,
  userId: string,
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<CloudAgentRunSummary[]> {
  const session = await db.query.devSessions.findFirst({
    where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
  });
  if (!session) {
    throw Object.assign(new Error('Session not found'), { status: 404 });
  }

  const runs = await db
    .select()
    .from(agentRuns)
    .where(and(
      eq(agentRuns.devSessionId, sessionId),
      eq(agentRuns.workflowClass, 'implementation'),
    ))
    .orderBy(desc(agentRuns.createdAt));

  return Promise.all(runs.map(async (run) => {
    const isCurrent = session.currentRunId === run.id;
    const prUrl = run.cloudPrUrl ?? (isCurrent ? session.currentRunPrUrl : null) ?? null;
    let prStatus = cachedPullRequestStatus(
      prUrl,
      run.cloudPrStatus ?? (isCurrent ? session.currentRunPrStatus : null),
    );

    if (prUrl && prStatus !== 'merged') {
      try {
        const provider = backgroundSnapshot(run.executionSnapshot)?.provider;
        const repository = backgroundSnapshot(run.executionSnapshot)?.repository;
        if (!provider || !repository) {
          throw new Error('Cloud Agent run is missing repository context for PR status');
        }
        const refreshedStatus = await lookupPullRequestStatus({
          prUrl,
          provider,
          repository,
          project: session.project,
        }, deps);
        if (refreshedStatus !== prStatus) {
          prStatus = refreshedStatus;
          const updatedAt = new Date().toISOString();
          await db
            .update(agentRuns)
            .set({ cloudPrStatus: refreshedStatus, updatedAt })
            .where(eq(agentRuns.id, run.id));
          if (isCurrent) {
            await db
              .update(devSessions)
              .set({ currentRunPrStatus: refreshedStatus, updatedAt })
              .where(eq(devSessions.id, sessionId));
          }
        }
      } catch (err) {
        console.warn('[cloud-agent] history PR status refresh failed', JSON.stringify({
          runId: run.id,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    return toRunSummary(run, prUrl, prStatus, !guidedSkipsPullRequest(run.executionSnapshot));
  }));
}

export async function getCloudAgentActivityStream(
  sessionId: string,
  userId: string,
  expectedRunId?: string,
  deps: CloudAgentServiceDeps = defaultDeps,
  adoUserToken: string | null = null,
): Promise<AsyncIterable<CloudAgentActivityEvent>> {
  const session = await db.query.devSessions.findFirst({
    where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
  });
  if (!session) {
    throw Object.assign(new Error('Cloud Agent run not found'), { status: 404 });
  }
  const enabled = await deps.isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, {
    userId,
    project: session.project,
  });
  if (!enabled) {
    throw Object.assign(new Error('Cloud Agent run not found'), { status: 404 });
  }
  if (!session.currentRunId) {
    throw Object.assign(new Error('Cloud Agent run not found'), { status: 404 });
  }
  if (expectedRunId && session.currentRunId !== expectedRunId) {
    throw Object.assign(new Error('Cloud Agent run changed'), { status: 409 });
  }

  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, session.currentRunId),
  });
  if (
    !run
    || run.lane !== 'cloud-agent'
    || !run.cloudAgentIdentity
    || !run.dispatchMessageId
  ) {
    throw Object.assign(new Error('Cloud Agent run is not ready to stream'), { status: 409 });
  }

  const source = deps.streamCloudAgentRun({
    project: session.project,
    cloudAgentId: run.cloudAgentIdentity,
    cursorRunId: run.dispatchMessageId,
  });
  return openPullRequestWhenAgentCompletes(source, async () => {
    await getCloudAgentRunStatus(sessionId, userId, deps, adoUserToken);
  });
}

/**
 * The activity stream's completed status is the Cursor run finishing.
 * Cursor opens the pull request (autoCreatePR). This refresh records that
 * pull request after the completed event is yielded.
 */
async function* openPullRequestWhenAgentCompletes(
  source: AsyncIterable<CloudAgentActivityEvent>,
  openPullRequest: () => Promise<void>,
): AsyncGenerator<CloudAgentActivityEvent> {
  let agentCompleted = false;
  for await (const event of source) {
    if (event.kind === 'status' && event.status === 'completed') {
      agentCompleted = true;
    }
    yield event;
  }
  if (!agentCompleted) return;
  try {
    await openPullRequest();
  } catch (err) {
    console.warn(
      '[cloud-agent] could not open the pull request after the agent completed',
      err instanceof Error ? err.message : String(err),
    );
  }
}

const CANCEL_DETAIL = 'Cancelled by user';

/**
 * A cancel that cannot reach terminal `cancelled` is a no-op for the caller:
 * either another writer already finished the run, or the lifecycle row moved
 * under us. Never overwrite a completed or failed terminal result.
 */
function cancelConflictError(run: { status: string } | null): CloudAgentConflictError {
  if (run && isAgentRunTerminalStatus(run.status)) {
    return new CloudAgentConflictError('The Cloud Agent run is already finished.');
  }
  return new CloudAgentConflictError(
    'The Cloud Agent run could not be cancelled. Refresh and try again.',
  );
}

export async function cancelCloudAgentRun(
  sessionId: string,
  userId: string,
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<{ ok: true; status: AgentRunStatus }> {
  const session = await db.query.devSessions.findFirst({
    where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
  });
  if (!session) {
    const err = new Error('Session not found');
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (!session.currentRunId) {
    throw new CloudAgentConflictError('No Cloud Agent run to cancel.');
  }

  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, session.currentRunId),
  });
  if (!run) {
    const err = new Error('Session not found');
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  if (isAgentRunTerminalStatus(run.status)) {
    throw new CloudAgentConflictError('The Cloud Agent run is already finished.');
  }

  const requested = await requestCancel(run.id);
  if (!requested.ok) {
    throw cancelConflictError(requested.run);
  }

  // Queued runs are finalized synchronously inside requestCancel. A run that is
  // already terminal here lost a race to another writer. A queued row can
  // already hold a Cursor identity when the status move failed, so stop that
  // agent before returning.
  if (isAgentRunTerminalStatus(requested.run.status)) {
    if (requested.run.status !== 'cancelled') {
      throw cancelConflictError(requested.run);
    }
    if (requested.run.cloudAgentIdentity && requested.run.dispatchMessageId) {
      try {
        await deps.cancelCursorCloudAgentRun({
          project: session.project,
          cloudAgentId: requested.run.cloudAgentIdentity,
          cursorRunId: requested.run.dispatchMessageId,
        });
      } catch (err) {
        console.warn('[cloud-agent] vendor cancel request failed', JSON.stringify({
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
    emitTerminal(
      { sessionId, runId: run.id },
      session.project,
      'cancelled',
      requested.run.terminalReason,
    );
    scheduleCloudAgentDispatch();
    await trackLaunchedCloudAgentSpend(requested.run, session.project, 'cancelled', deps);
    return { ok: true, status: 'cancelled' };
  }

  // Dispatched or running: ask Cursor to stop, then finalize the Apex row
  // without waiting for vendor confirmation.
  let vendorCancelRequested = true;
  if (requested.run.cloudAgentIdentity && requested.run.dispatchMessageId) {
    try {
      await deps.cancelCursorCloudAgentRun({
        project: session.project,
        cloudAgentId: requested.run.cloudAgentIdentity,
        cursorRunId: requested.run.dispatchMessageId,
      });
    } catch (err) {
      vendorCancelRequested = false;
      console.warn('[cloud-agent] vendor cancel request failed', JSON.stringify({
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const terminal = await markTerminal(run.id, {
    status: 'cancelled',
    terminalReason: 'forced_cancel',
    detail: vendorCancelRequested
      ? CANCEL_DETAIL
      : `${CANCEL_DETAIL} (Cursor cancellation request failed)`,
    ...(requested.run.dispatchMessageId
      ? { dispatchMessageId: requested.run.dispatchMessageId }
      : {}),
  });
  if (!terminal.ok) {
    throw cancelConflictError(terminal.run);
  }

  emitTerminal(
    { sessionId, runId: run.id },
    session.project,
    terminal.run.status,
    terminal.run.terminalReason,
  );
  scheduleCloudAgentDispatch();
  await trackLaunchedCloudAgentSpend(terminal.run, session.project, 'cancelled', deps);
  return { ok: true, status: 'cancelled' };
}
