/**
 * Cloud Agent deep module. Owns eligibility, one-live-run start/resume,
 * status projection, and cancel. Durable transitions go through
 * agentRunLifecycleService.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, devSessions } from '../db/schema';
import { MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import type { ProjectSkillConfig, SkillProvider } from '../../shared/types/projectSettings';
import {
  evaluateDevStartEligibility,
  isAppNativeRequirementsProject,
  type AssignedWorkItem,
  type CloudAgentEligibility,
  type CloudAgentRunSummary,
  type HostAgnosticPrStatus,
  type StartCloudAgentRunResponse,
} from '../../shared/types/devWorkbench';
import { isAgentRunTerminalStatus } from '../../shared/types/agentRunLifecycle';
import type {
  AgentRunStatus,
  AgentRunTerminalReason,
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
  type LaunchCloudAgentResult,
} from './cursorCloudAgentClient';
import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';
import {
  buildWorkItemReferenceText,
  linkWorkItemToPullRequest,
  parsePullRequestNumber,
  transitionWorkItemForPullRequest,
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
  CloudAgentPullRequestDeferred,
  openCloudAgentPullRequest,
  type OpenCloudAgentPullRequestInput,
} from './cloudAgentPullRequest';
import {
  CLOUD_AGENT_QUEUE_WAIT_MS,
  CLOUD_AGENT_USER_TOKEN_CLAIM_MS,
  cloudAgentLaunchSlots,
  resolveCloudAgentMaxConcurrent,
  resolveCloudAgentRunLimitMs,
} from './cloudAgentQueue';

export const CLOUD_AGENT_PRE_IDENTITY_TTL_MS = 2 * 60_000;
const CLOUD_AGENT_DISPATCH_LOCK = 'cloud-agent-dispatch';
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
    cloudJobName?: string | null;
    cloudJobExecutionName?: string | null;
    cloudBranchName?: string | null;
    createdAt?: string;
  },
  prUrl: string | null,
  prStatus: HostAgnosticPrStatus,
  expectsPullRequest = true,
  queuePosition: number | null = null,
): CloudAgentRunSummary {
  const status = run.status as AgentRunStatus;
  return {
    runId: run.id,
    status,
    jobName: run.cloudJobName ?? process.env.CURSOR_CONTAINER_JOB_NAME?.trim() ?? null,
    executionName: run.cloudJobExecutionName ?? null,
    branchName: run.cloudBranchName ?? null,
    createdAt: run.createdAt ?? new Date(0).toISOString(),
    prUrl,
    prStatus,
    finishedWithoutPr: expectsPullRequest && status === 'completed' && !prUrl,
    terminalReason: run.terminalReason,
    checkResults: run.checkResults,
    failingChecks: deriveFailingChecks(run.checkResults),
    lastError: status === 'failed' ? (run.lastError ?? null) : null,
    queuePosition,
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
  transitionWorkItemForPullRequest: (
    project: string,
    workItemId: number,
  ) => Promise<void>;
  getAdoPullRequestStatus: (
    repo: string,
    project: string,
    pullRequestId: number,
  ) => Promise<'open' | 'abandoned' | 'merged'>;
  getGithubPullRequestStatus: typeof getGithubPullRequestStatus;
  retryWithBackoff: typeof retryWithBackoff;
  buildPrompt: (input: { project: string; workItemId: number }) => Promise<string>;
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
  transitionWorkItemForPullRequest: async (project, workItemId) => {
    await transitionWorkItemForPullRequest(new AzureDevOpsService(project), workItemId);
  },
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
}): Promise<string> {
  const [pack, skillConfig] = await Promise.all([
    buildLocalDevContext({
      project: input.project,
      workItemId: input.workItemId,
    }),
    getSkillConfig(input.project).catch(() => null),
  ]);
  const development = resolveDevelopmentSettings(skillConfig);
  const files = pack.files
    .map((file) => `### ${file.name}\n\n${file.content}`)
    .join('\n\n');
  const body = [
    `Implement this Azure DevOps work item in the project's configured repository.`,
    `Work item id: ${input.workItemId}.`,
    buildCloudDevelopmentKickoffSection(development),
    `Do not wait for Apex. Open a pull request when the implementation is ready.`,
    `When the repository is hosted on GitHub, include ${buildWorkItemReferenceText(input.workItemId)} in the pull request title or body. Azure Repos work-item linking is handled by Apex.`,
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

  const started = await persistQueuedRun(input, skillConfig, deps);
  if (input.adoUserToken) pendingCloudAgentUserTokens.set(started.runId, input.adoUserToken);
  const queuePosition = await lookupCloudAgentQueuePosition(started.runId);
  scheduleCloudAgentDispatch();
  trackEvent('cloud_agent_run.started', {
    project: input.project,
    sessionId: started.sessionId,
    runId: started.runId,
  });
  logMyWorkSession('cloud_agent.started', {
    sessionId: started.sessionId,
    project: input.project,
    workItemId: input.workItemId,
    status: 'queued',
  });
  return { sessionId: started.sessionId, runId: started.runId, queuePosition };
}

interface PersistedCloudAgentRun {
  sessionId: string;
  runId: string;
  executionPrompt: string;
}

async function persistQueuedRun(
  input: StartCloudAgentRunInput,
  skillConfig: ProjectSkillConfig,
  deps: CloudAgentServiceDeps,
): Promise<PersistedCloudAgentRun> {
  const lockKey = `cloud-agent:${input.project}:${input.workItemId}:${input.userId}`;
  const nowIso = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + CLOUD_AGENT_QUEUE_WAIT_MS).toISOString();
  const basePrompt = await deps.buildPrompt({
    project: input.project,
    workItemId: input.workItemId,
  });
  const development = resolveDevelopmentSettings(skillConfig);
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
      console.error('[cloud-agent] queue dispatch failed', err instanceof Error ? err.message : err);
    });
  });
}

function takeCloudAgentUserToken(runId: string): string | null {
  const token = pendingCloudAgentUserTokens.get(runId) ?? null;
  pendingCloudAgentUserTokens.delete(runId);
  return token;
}

/** 1-based place among cloud-agent runs still waiting for a container. */
export async function lookupCloudAgentQueuePosition(runId: string): Promise<number | null> {
  const [row] = await db
    .select({
      position: sql<number>`count(*)::int`,
    })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.lane, 'cloud-agent'),
      eq(agentRuns.status, 'queued'),
      sql`${agentRuns.cloudAgentIdentity} IS NULL`,
      eq(agentRuns.cancelRequested, false),
      sql`(${agentRuns.queuedAt}, ${agentRuns.id}) <= (
        (SELECT queued_at FROM agent_runs WHERE id = ${runId}),
        ${runId}
      )`,
    ));
  const position = Number(row?.position ?? 0);
  return position > 0 ? position : null;
}

async function claimCloudAgentRunIds(cap: number): Promise<string[]> {
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${CLOUD_AGENT_DISPATCH_LOCK}))`);
    const active = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.lane, 'cloud-agent'),
        inArray(agentRuns.status, ['dispatched', 'running']),
      ));
    const starting = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(
        eq(agentRuns.lane, 'cloud-agent'),
        eq(agentRuns.status, 'queued'),
        sql`${agentRuns.ownerInstance} IS NOT NULL`,
        sql`${agentRuns.cloudAgentIdentity} IS NULL`,
      ));
    const slots = cloudAgentLaunchSlots(active.length + starting.length, cap);
    if (slots <= 0) return [];

    const instance = cloudAgentInstanceId();
    const tokenClaimCutoff = new Date(Date.now() - CLOUD_AGENT_USER_TOKEN_CLAIM_MS).toISOString();
    const tokenInstance = sql`${agentRuns.executionSnapshot}->'cloudAgent'->>'userTokenInstance'`;
    const waiting = await tx
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
      .orderBy(asc(agentRuns.queuedAt), asc(agentRuns.id))
      .limit(slots);

    const nowIso = new Date().toISOString();
    const claimUntil = new Date(Date.now() + CLOUD_AGENT_PRE_IDENTITY_TTL_MS).toISOString();
    const ids: string[] = [];
    for (const candidate of waiting) {
      const updated = await tx
        .update(agentRuns)
        .set({
          ownerInstance: instance,
          timeoutAt: claimUntil,
          updatedAt: nowIso,
        })
        .where(and(
          eq(agentRuns.id, candidate.id),
          eq(agentRuns.status, 'queued'),
          sql`${agentRuns.ownerInstance} IS NULL`,
        ))
        .returning({ id: agentRuns.id });
      if (updated[0]) ids.push(updated[0].id);
    }
    return ids;
  });
  return Array.isArray(claimed) ? claimed : [];
}

async function launchClaimedCloudAgentRun(
  runId: string,
  deps: CloudAgentServiceDeps,
): Promise<void> {
  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
  });
  const snapshot = run?.executionSnapshot;
  const cloud = snapshot?.cloudAgent;
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
    || !cloud.workItemId
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
  if (!adoUserToken) {
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
      workItemTitle: cloud.workItemTitle ?? `Work item ${cloud.workItemId}`,
      initiatorName: cloud.initiatorName,
      initiatorEmail: cloud.initiatorEmail,
      skillName: cloud.skillName,
      adoUserToken,
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
  const captured = await captureCloudAgentIdentity(runId, {
    cloudAgentIdentity: launched.cloudAgentId,
    cursorRunId: launched.cursorRunId,
    jobName: launched.jobName,
    branchName: launched.branchName,
    timeoutAt,
  });
  if (!captured.ok && captured.reason === 'run_cancelled') {
    console.warn('[cloud-agent] run was cancelled while its job was starting; stopping the job', JSON.stringify({
      runId,
      jobExecution: launched.cursorRunId,
    }));
    try {
      await deps.cancelCursorCloudAgentRun({
        project: snapshot.projectId,
        cloudAgentId: launched.cloudAgentId,
        cursorRunId: launched.cursorRunId,
      });
    } catch (err) {
      console.error('[cloud-agent] could not stop the job for a cancelled run', JSON.stringify({
        runId,
        jobExecution: launched.cursorRunId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    scheduleCloudAgentDispatch();
    return;
  }
  if (launched.branchName) {
    await db
      .update(devSessions)
      .set({
        branchName: launched.branchName,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(devSessions.id, sessionId));
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
        // The worker pushed the branch and exited 0 after the pull-request
        // call failed. Leave the run open so the page poll can open the pull
        // request. Marking it completed here is final, and this sweep does
        // not have the developer's token.
        if (
          mapped === 'completed'
          && !observed.prUrl
          && !observed.noChanges
          && observed.branchName
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

/** Starts queued cloud-agent runs until the container cap is full. */
export async function pumpCloudAgentQueue(
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<void> {
  if (cloudAgentQueuePumpRunning) return;
  cloudAgentQueuePumpRunning = true;
  try {
    const claimed = await claimCloudAgentRunIds(resolveCloudAgentMaxConcurrent());
    for (const runId of claimed) {
      await launchClaimedCloudAgentRun(runId, deps);
    }
  } catch (err) {
    console.error('[cloud-agent] queue dispatch failed', err instanceof Error ? err.message : err);
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

  try {
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
    } else {
      await deps.retryWithBackoff(
        () => deps.linkWorkItemToPullRequest(linkInput),
        { maxRetries: 3, initialDelay: 250, shouldRetry: () => true, jitter: true },
      );
    }
  } finally {
    await deps.transitionWorkItemForPullRequest(input.project, input.workItemId);
  }
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

  const provider = terminal.run.executionSnapshot?.provider;
  const repository = terminal.run.executionSnapshot?.repository;
  let prStatus: HostAgnosticPrStatus = input.prUrl ? 'open' : 'none';
  if (input.prUrl && provider && repository) {
    try {
      prStatus = await lookupPullRequestStatus({
        prUrl: input.prUrl,
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
      cloudPrUrl: input.prUrl,
      cloudPrStatus: prStatus,
      updatedAt: nowIso,
    })
    .where(eq(agentRuns.id, input.runId));

  await db
    .update(devSessions)
    .set({
      currentRunPrUrl: input.prUrl,
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
    prUrl: input.prUrl,
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

  if (!input.prUrl) return;
  try {
    if (!session.workItemId || !provider || !repository) {
      throw new Error('Cloud Agent run is missing work-item repository context');
    }
    await writeWorkItemPullRequest({
      provider,
      project: input.project,
      repository,
      prUrl: input.prUrl,
      workItemId: session.workItemId,
      runId: input.runId,
      sessionId,
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
  adoUserToken: string | null = null,
): Promise<CloudAgentRunSummary | null> {
  const session = await db.query.devSessions.findFirst({
    where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
  });
  if (!session?.currentRunId) return null;

  const run = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, session.currentRunId),
  });
  if (!run) return null;

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
      let mapped = mapObservedStatus(observed.status);
      let prUrl = observed.prUrl;
      const sourceBranch = observed.noChanges
        ? null
        : observed.branchName ?? run.cloudBranchName;
      // While the job is still running, wait for APEX_RUN_SETTLED. That line
      // follows the CLI exit, so a pushed branch cannot be recorded as success
      // before a non-zero exit fails the run.
      const readyForPullRequest = mapped !== 'running' || observed.settled === true;
      if (!prUrl && sourceBranch && readyForPullRequest && mapped !== 'failed' && mapped !== 'cancelled') {
        if (!adoUserToken && process.env.NODE_ENV === 'production') {
          mapped = 'running';
        } else {
          const meta = run.executionSnapshot?.cloudAgent;
          const repository = run.executionSnapshot?.repository;
          let targetBranch = meta?.baseBranch || observed.baseBranch || null;
          if (!targetBranch) {
            const skill = await deps.getSkillConfig(session.project);
            targetBranch = skill?.skillBranch ?? null;
          }
          const workItemId = session.workItemId ?? meta?.workItemId;
          if (!repository || !targetBranch || !workItemId) {
            throw new Error('Cloud Agent run is missing pull request context');
          }
          if (run.executionSnapshot?.provider !== 'github') {
            prUrl = await deps.openCloudAgentPullRequest({
              project: session.project,
              repo: repository,
              sourceBranch,
              targetBranch,
              workItemId,
              workItemTitle: meta?.workItemTitle,
              authorName: meta?.initiatorName,
              authorEmail: meta?.initiatorEmail,
              summary: observed.summary,
              adoUserToken,
            });
            mapped = 'completed';
          }
        }
      }
      if (mapped && isAgentRunTerminalStatus(mapped)) {
        await applyCloudAgentCompletion({
          runId: run.id,
          sessionId,
          project: session.project,
          status: mapped,
          prUrl,
          dispatchMessageId: run.dispatchMessageId,
          detail: mapped === 'failed' ? (observed.resultText ?? undefined) : undefined,
        }, deps);
        return toRunSummary(
          {
            id: run.id,
            status: mapped,
            terminalReason: run.terminalReason as AgentRunTerminalReason | null,
            checkResults: run.checkResults ?? null,
            lastError: mapped === 'failed' ? observed.resultText : run.lastError,
            cloudJobName: run.cloudJobName,
            cloudJobExecutionName: run.cloudJobExecutionName,
            cloudBranchName: run.cloudBranchName,
            createdAt: run.createdAt,
          },
          prUrl,
          cachedPullRequestStatus(prUrl, null),
          true,
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
          },
          null,
          'none',
          true,
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
      const provider = run.executionSnapshot?.provider;
      const repository = run.executionSnapshot?.repository;
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

  const queuePosition = run.status === 'queued' && !run.cloudAgentIdentity
    ? await lookupCloudAgentQueuePosition(run.id)
    : null;
  return toRunSummary(
    {
      id: run.id,
      status: run.status,
      terminalReason: run.terminalReason as AgentRunTerminalReason | null,
      checkResults: run.checkResults ?? null,
      lastError: run.lastError,
      cloudJobName: run.cloudJobName,
      cloudJobExecutionName: run.cloudJobExecutionName,
      cloudBranchName: run.cloudBranchName,
      createdAt: run.createdAt,
    },
    prUrl,
    prStatus,
    true,
    queuePosition,
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
        const provider = run.executionSnapshot?.provider;
        const repository = run.executionSnapshot?.repository;
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

    const queuePosition = run.status === 'queued' && !run.cloudAgentIdentity
      ? await lookupCloudAgentQueuePosition(run.id)
      : null;
    return toRunSummary(run, prUrl, prStatus, true, queuePosition);
  }));
}

export async function getCloudAgentActivityStream(
  sessionId: string,
  userId: string,
  expectedRunId?: string,
  deps: CloudAgentServiceDeps = defaultDeps,
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

  return deps.streamCloudAgentRun({
    project: session.project,
    cloudAgentId: run.cloudAgentIdentity,
    cursorRunId: run.dispatchMessageId,
  });
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
  // already terminal here lost a race to another writer.
  if (isAgentRunTerminalStatus(requested.run.status)) {
    if (requested.run.status !== 'cancelled') {
      throw cancelConflictError(requested.run);
    }
    emitTerminal(
      { sessionId, runId: run.id },
      session.project,
      'cancelled',
      requested.run.terminalReason,
    );
    scheduleCloudAgentDispatch();
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
  return { ok: true, status: 'cancelled' };
}
