/**
 * Cloud Agent deep module. Owns eligibility, one-live-run start/resume,
 * status projection, and cancel. Durable transitions go through
 * agentRunLifecycleService.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { resolveAgentRunHardLimitMs } from './agentRunReaperService';
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
  resolveDevelopmentSettings,
} from '../../shared/utils/developmentKickoff';

export const CLOUD_AGENT_PRE_IDENTITY_TTL_MS = 2 * 60_000;
export const LIVE_CLOUD_AGENT_STATUSES = ['queued', 'dispatched', 'running'] as const;

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
  },
  prUrl: string | null,
  prStatus: HostAgnosticPrStatus,
): CloudAgentRunSummary {
  const status = run.status as AgentRunStatus;
  return {
    runId: run.id,
    status,
    prUrl,
    prStatus,
    finishedWithoutPr: status === 'completed' && !prUrl,
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
  getAdoPullRequestStatus: (
    repo: string,
    project: string,
    pullRequestId: number,
  ) => Promise<'open' | 'merged'>;
  getGithubPullRequestStatus: typeof getGithubPullRequestStatus;
  retryWithBackoff: typeof retryWithBackoff;
  buildPrompt: (input: { project: string; workItemId: number }) => Promise<string>;
  persistLeftoverWork: typeof persistLeftoverWork;
  writeLeftoverWorkToAdo: typeof writeLeftoverWorkToAdo;
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
  getAdoPullRequestStatus: async (repo, project, pullRequestId) =>
    new AzureDevOpsService(project).getPullRequestStatus(repo, project, pullRequestId),
  getGithubPullRequestStatus,
  retryWithBackoff,
  buildPrompt: buildCloudAgentPrompt,
  persistLeftoverWork,
  writeLeftoverWorkToAdo,
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
  return [
    `Implement this Azure DevOps work item in the project's configured repository.`,
    `Work item id: ${input.workItemId}.`,
    buildCloudDevelopmentKickoffSection(development),
    `Do not wait for Apex. Open a pull request when the implementation is ready.`,
    `When the repository is hosted on GitHub, include ${buildWorkItemReferenceText(input.workItemId)} in the pull request title or body. Azure Repos work-item linking is handled by Apex.`,
    files,
  ].join('\n\n');
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
  isSuperAdmin: boolean;
  item: Pick<AssignedWorkItem, 'workItemType' | 'state' | 'tags'>;
}

export async function startCloudAgentRun(
  input: StartCloudAgentRunInput,
  deps: CloudAgentServiceDeps = defaultDeps,
): Promise<{ sessionId: string; runId: string }> {
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
  scheduleLaunch(started, input, skillConfig, deps);
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
  return { sessionId: started.sessionId, runId: started.runId };
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
  const timeoutAt = new Date(Date.now() + CLOUD_AGENT_PRE_IDENTITY_TTL_MS).toISOString();
  const basePrompt = await deps.buildPrompt({
    project: input.project,
    workItemId: input.workItemId,
  });
  const { model, skillPath } = resolveDevelopmentSettings(skillConfig);

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
        },
      });

      await tx
        .update(devSessions)
        .set({
          currentRunId: runId,
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

function scheduleLaunch(
  started: PersistedCloudAgentRun,
  input: StartCloudAgentRunInput,
  skillConfig: ProjectSkillConfig,
  deps: CloudAgentServiceDeps,
): void {
  setImmediate(() => {
    void dispatchLaunch(started, input, skillConfig, deps).catch((err) => {
      console.error('[cloud-agent] launch failed', JSON.stringify({
        runId: started.runId,
        sessionId: started.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }));
    });
  });
}

async function dispatchLaunch(
  started: PersistedCloudAgentRun,
  input: StartCloudAgentRunInput,
  skillConfig: ProjectSkillConfig,
  deps: CloudAgentServiceDeps,
): Promise<void> {
  const { model } = resolveDevelopmentSettings(skillConfig);
  let launched: LaunchCloudAgentResult;
  try {
    launched = await deps.launchCloudAgent({
      project: input.project,
      prompt: started.executionPrompt,
      model,
      skillProvider: (skillConfig.skillProvider ?? 'ado') as SkillProvider,
      skillRepo: skillConfig.skillRepo,
      skillBranch: skillConfig.skillBranch,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Cloud Agent launch failed';
    console.error('[cloud-agent] launch failed', JSON.stringify({
      runId: started.runId,
      sessionId: started.sessionId,
      project: input.project,
      workItemId: input.workItemId,
      model,
      skillProvider: skillConfig.skillProvider ?? 'ado',
      skillRepo: skillConfig.skillRepo,
      skillBranch: skillConfig.skillBranch,
      error: detail,
    }));
    const terminal = await markTerminal(started.runId, { status: 'failed', detail });
    if (!terminal.ok) {
      console.error('[cloud-agent] could not record launch failure', JSON.stringify({
        runId: started.runId,
        reason: terminal.reason,
        status: terminal.run?.status ?? null,
      }));
    }
    emitTerminal(started, input.project, 'failed', null);
    return;
  }

  const timeoutAt = new Date(Date.now() + resolveAgentRunHardLimitMs()).toISOString();
  await captureCloudAgentIdentity(started.runId, {
    cloudAgentIdentity: launched.cloudAgentId,
    cursorRunId: launched.cursorRunId,
    timeoutAt,
  });
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
): Promise<'open' | 'merged'> {
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
  return storedStatus === 'merged' ? 'merged' : 'open';
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
}, deps: CloudAgentServiceDeps = defaultDeps): Promise<void> {
  const terminal = await markTerminal(input.runId, {
    status: input.status,
    terminalReason: input.terminalReason,
    detail: input.detail,
    ...(input.dispatchMessageId ? { dispatchMessageId: input.dispatchMessageId } : {}),
    ...(input.checkResults ? { checkResults: input.checkResults } : {}),
  });
  if (!terminal.ok) return;

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
    .update(devSessions)
    .set({
      currentRunPrUrl: input.prUrl,
      currentRunPrStatus: prStatus,
      updatedAt: nowIso,
    })
    .where(eq(devSessions.id, sessionId));

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
      const mapped = mapObservedStatus(observed.status);
      if (mapped && isAgentRunTerminalStatus(mapped)) {
        await applyCloudAgentCompletion({
          runId: run.id,
          sessionId,
          project: session.project,
          status: mapped,
          prUrl: observed.prUrl,
          dispatchMessageId: run.dispatchMessageId,
        }, deps);
        return toRunSummary(
          {
            id: run.id,
            status: mapped,
            terminalReason: run.terminalReason as AgentRunTerminalReason | null,
            checkResults: run.checkResults ?? null,
            lastError: run.lastError,
          },
          observed.prUrl,
          cachedPullRequestStatus(observed.prUrl, null),
        );
      }
    } catch (err) {
      console.warn('[cloud-agent] status refresh failed', JSON.stringify({
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const prUrl = session.currentRunPrUrl ?? null;
  let prStatus = cachedPullRequestStatus(prUrl, session.currentRunPrStatus);
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
        await db
          .update(devSessions)
          .set({
            currentRunPrStatus: refreshedStatus,
            updatedAt: new Date().toISOString(),
          })
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
    },
    prUrl,
    prStatus,
  );
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
  return { ok: true, status: 'cancelled' };
}
