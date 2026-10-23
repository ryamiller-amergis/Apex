/**
 * Project-owned Cloud Agent jobs. Each job is a saved prompt, skill, and
 * model. Someone can start it from Project Settings, or a daily UTC schedule
 * can start it while nobody is on the page.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, cloudBackgroundJobRuns, cloudBackgroundJobs, devSessions } from '../db/schema';
import { MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import type { AgentRunExecutionSnapshot, AgentRunStatus } from '../../shared/types/agentRunLifecycle';
import type {
  CloudBackgroundJob,
  CloudBackgroundJobRun,
  StartCloudBackgroundJobResponse,
} from '../../shared/types/cloudBackgroundJob';
import type { SkillProvider } from '../../shared/types/projectSettings';
import { skillNameFromPath } from '../../shared/skillPaths';
import {
  buildCloudBackgroundJobPrompt,
  cloudBackgroundJobBranchName,
  cloudBackgroundJobSchema,
  isDailyCloudBackgroundJobDue,
  type CloudBackgroundJobDraft,
} from '../../shared/utils/cloudBackgroundJob';
import { createNotification } from './notificationService';
import { isFeatureEnabled } from './featureFlagService';
import { getSkillConfig } from './projectSettingsService';
import { enqueue, markTerminal } from './agentRunLifecycleService';
import { claimAndLaunchCloudAgentRun } from './cloudAgentService';
import { CLOUD_AGENT_PULL_REQUEST_LABEL } from './cloudAgentPullRequest';
import { CLOUD_AGENT_QUEUE_WAIT_MS } from './cloudAgentQueue';
import { buildPullRequestDescriptionInstructions } from './implementationDelivery';
import { AzureDevOpsService } from './azureDevOps';

const LIVE_STATUSES = ['queued', 'dispatched', 'running'] as const;
const RUNS_PER_JOB = 10;

export class CloudBackgroundJobError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'CloudBackgroundJobError';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cloudAgentFields(snapshot: AgentRunExecutionSnapshot | null | undefined) {
  if (!snapshot || !('cloudAgent' in snapshot)) return null;
  return snapshot.cloudAgent ?? null;
}

async function createJobBug(input: {
  project: string;
  name: string;
  instructions: string;
}): Promise<{ workItemId: number; workItemUrl: string }> {
  const title = input.name.replace(/\s+/g, ' ').trim().slice(0, 250);
  const description = `<p>${escapeHtml(input.instructions).replace(/\n/g, '<br>')}</p>`;
  try {
    const created = await new AzureDevOpsService(input.project).createWorkItemForPrd({
      type: 'Bug',
      title,
      description,
      tags: ['apex-background-job'],
    });
    return { workItemId: created.id, workItemUrl: created.url };
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Azure DevOps could not create the Bug';
    throw new CloudBackgroundJobError(`Could not create the Bug work item. ${detail}`, 502);
  }
}

export async function listCloudBackgroundJobs(project: string): Promise<CloudBackgroundJob[]> {
  const jobs = await db
    .select()
    .from(cloudBackgroundJobs)
    .where(eq(cloudBackgroundJobs.project, project))
    .orderBy(desc(cloudBackgroundJobs.updatedAt));
  if (jobs.length === 0) return [];

  const runs = await db
    .select({
      id: cloudBackgroundJobRuns.id,
      jobId: cloudBackgroundJobRuns.jobId,
      trigger: cloudBackgroundJobRuns.trigger,
      startedBy: cloudBackgroundJobRuns.startedBy,
      createdAt: cloudBackgroundJobRuns.createdAt,
      agentRunId: cloudBackgroundJobRuns.agentRunId,
      status: agentRuns.status,
      prUrl: agentRuns.cloudPrUrl,
      lastError: agentRuns.lastError,
    })
    .from(cloudBackgroundJobRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, cloudBackgroundJobRuns.agentRunId))
    .where(eq(cloudBackgroundJobRuns.project, project))
    .orderBy(desc(cloudBackgroundJobRuns.createdAt));

  const runsByJob = new Map<string, CloudBackgroundJobRun[]>();
  for (const run of runs) {
    const list = runsByJob.get(run.jobId) ?? [];
    if (list.length >= RUNS_PER_JOB) {
      runsByJob.set(run.jobId, list);
      continue;
    }
    list.push({
      id: run.id,
      trigger: run.trigger,
      startedBy: run.startedBy,
      createdAt: run.createdAt,
      runId: run.agentRunId,
      status: (run.status ?? 'unknown') as AgentRunStatus | 'unknown',
      prUrl: run.prUrl,
      lastError: run.lastError,
    });
    runsByJob.set(run.jobId, list);
  }

  return jobs.map((job) => ({
    id: job.id,
    project: job.project,
    name: job.name,
    instructions: job.instructions,
    skillPath: job.skillPath,
    model: job.model,
    workItemMode: job.workItemMode,
    workItemId: job.workItemId,
    scheduleKind: job.scheduleKind,
    scheduleHour: job.scheduleHour,
    scheduleMinute: job.scheduleMinute,
    enabled: job.enabled,
    createdBy: job.createdBy,
    updatedAt: job.updatedAt,
    lastStartedAt: job.lastStartedAt,
    runs: runsByJob.get(job.id) ?? [],
  }));
}

export async function saveCloudBackgroundJob(input: {
  project: string;
  userId: string;
  jobId?: string;
  draft: CloudBackgroundJobDraft;
}): Promise<CloudBackgroundJob> {
  const draft = cloudBackgroundJobSchema.parse(input.draft);
  const nowIso = new Date().toISOString();
  if (input.jobId) {
    const updated = await db
      .update(cloudBackgroundJobs)
      .set({
        name: draft.name,
        instructions: draft.instructions,
        skillPath: draft.skillPath,
        model: draft.model,
        workItemMode: draft.workItemMode,
        workItemId: draft.workItemId,
        scheduleKind: draft.scheduleKind,
        scheduleHour: draft.scheduleHour,
        scheduleMinute: draft.scheduleMinute,
        enabled: draft.enabled,
        updatedBy: input.userId,
        updatedAt: nowIso,
      })
      .where(and(
        eq(cloudBackgroundJobs.id, input.jobId),
        eq(cloudBackgroundJobs.project, input.project),
      ))
      .returning({ id: cloudBackgroundJobs.id });
    if (!updated[0]) throw new CloudBackgroundJobError('Background job not found.', 404);
  } else {
    const inserted = await db.insert(cloudBackgroundJobs).values({
      project: input.project,
      name: draft.name,
      instructions: draft.instructions,
      skillPath: draft.skillPath,
      model: draft.model,
      workItemMode: draft.workItemMode,
      workItemId: draft.workItemId,
      scheduleKind: draft.scheduleKind,
      scheduleHour: draft.scheduleHour,
      scheduleMinute: draft.scheduleMinute,
      enabled: draft.enabled,
      createdBy: input.userId,
      updatedBy: input.userId,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).returning({ id: cloudBackgroundJobs.id });
    input.jobId = inserted[0]?.id;
  }
  const jobs = await listCloudBackgroundJobs(input.project);
  const saved = jobs.find((job) => job.id === input.jobId);
  if (!saved) throw new CloudBackgroundJobError('Background job not found.', 404);
  return saved;
}

export async function deleteCloudBackgroundJob(project: string, jobId: string): Promise<void> {
  const removed = await db
    .delete(cloudBackgroundJobs)
    .where(and(
      eq(cloudBackgroundJobs.id, jobId),
      eq(cloudBackgroundJobs.project, project),
    ))
    .returning({ id: cloudBackgroundJobs.id });
  if (!removed[0]) throw new CloudBackgroundJobError('Background job not found.', 404);
}

export async function startCloudBackgroundJob(input: {
  project: string;
  jobId: string;
  trigger: 'manual' | 'schedule';
  userId: string;
  displayName: string;
  email?: string;
  now?: Date;
}): Promise<StartCloudBackgroundJobResponse | null> {
  const now = input.now ?? new Date();
  const job = await db.query.cloudBackgroundJobs.findFirst({
    where: and(
      eq(cloudBackgroundJobs.id, input.jobId),
      eq(cloudBackgroundJobs.project, input.project),
    ),
  });
  if (!job) throw new CloudBackgroundJobError('Background job not found.', 404);

  const refuse = (message: string, status: number): null => {
    if (input.trigger === 'schedule') return null;
    throw new CloudBackgroundJobError(message, status);
  };

  if (!job.enabled) return refuse('Turn the job on before running it.', 409);
  const cloudEnabled = await isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, {
    userId: input.userId,
    project: input.project,
  });
  if (!cloudEnabled) {
    return refuse('Cloud Development is not enabled for this project.', 403);
  }
  const skillConfig = await getSkillConfig(input.project);
  const skillProvider = skillConfig?.skillProvider?.trim() ?? '';
  const skillRepo = skillConfig?.skillRepo?.trim() ?? '';
  const skillBranch = skillConfig?.skillBranch?.trim() ?? '';
  if (!skillProvider || !skillRepo || !skillBranch) {
    return refuse('Set the skill repository and branch in Project Settings before running this job.', 403);
  }
  if (skillProvider === 'github') {
    return refuse('Cloud Development supports Azure Repos only. GitHub repositories are not supported yet.', 403);
  }
  if (
    input.trigger === 'schedule'
    && !isDailyCloudBackgroundJobDue({
      scheduleKind: job.scheduleKind,
      scheduleHour: job.scheduleHour,
      scheduleMinute: job.scheduleMinute,
      lastStartedAt: job.lastStartedAt,
      now,
    })
  ) {
    return null;
  }

  const sessionId = uuidv4();
  const nowIso = now.toISOString();
  const lockKey = `cloud-bg-job:${job.id}`;
  const started = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const lockedRows = await tx
      .select()
      .from(cloudBackgroundJobs)
      .where(eq(cloudBackgroundJobs.id, job.id))
      .limit(1);
    const locked = lockedRows[0];
    if (!locked || !locked.enabled) {
      throw new CloudBackgroundJobError('Turn the job on before running it.', 409);
    }
    if (
      input.trigger === 'schedule'
      && !isDailyCloudBackgroundJobDue({
        scheduleKind: locked.scheduleKind,
        scheduleHour: locked.scheduleHour,
        scheduleMinute: locked.scheduleMinute,
        lastStartedAt: locked.lastStartedAt,
        now,
      })
    ) {
      throw new CloudBackgroundJobError('This job is not due.', 409);
    }
    const live = await tx
      .select({ id: agentRuns.id })
      .from(cloudBackgroundJobRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, cloudBackgroundJobRuns.agentRunId))
      .where(and(
        eq(cloudBackgroundJobRuns.jobId, locked.id),
        inArray(agentRuns.status, [...LIVE_STATUSES]),
      ))
      .limit(1);
    if (live[0]) {
      throw new CloudBackgroundJobError('This job already has a run in progress.', 409);
    }

    const workItem = locked.workItemMode === 'create_bug'
      ? await createJobBug({
        project: input.project,
        name: locked.name,
        instructions: locked.instructions,
      })
      : locked.workItemMode === 'attach' && locked.workItemId
        ? { workItemId: locked.workItemId, workItemUrl: null as string | null }
        : null;
    const branchName = cloudBackgroundJobBranchName({
      jobId: locked.id,
      name: locked.name,
      workItemId: workItem?.workItemId ?? null,
    });
    const skillName = skillNameFromPath(locked.skillPath);
    const pullRequestInstructions = workItem
      ? buildPullRequestDescriptionInstructions({
        workItemId: workItem.workItemId,
        pullRequestTitle: `[APEX] ${branchName.replace('feature/', '')}`,
        pullRequestLabel: CLOUD_AGENT_PULL_REQUEST_LABEL,
      })
      : null;
    const prompt = buildCloudBackgroundJobPrompt({
      name: locked.name,
      instructions: locked.instructions,
      skillPath: locked.skillPath,
      skillName,
      branchName,
      workItemId: workItem?.workItemId ?? null,
      workItemUrl: workItem?.workItemUrl ?? null,
      pullRequestInstructions,
    });

    await tx.insert(devSessions).values({
      id: sessionId,
      project: input.project,
      authorId: input.userId,
      status: 'in_progress',
      branchName,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const { runId } = await enqueue({
      threadId: sessionId,
      projectId: input.project,
      timeoutAt: new Date(now.getTime() + CLOUD_AGENT_QUEUE_WAIT_MS).toISOString(),
      lane: 'cloud-agent',
      workflowClass: 'implementation',
      devSessionId: sessionId,
      executor: tx,
      snapshot: {
        prompt,
        model: locked.model,
        workspaceRef: sessionId,
        workflowClass: 'cloud-agent-implementation',
        skillPath: locked.skillPath,
        projectId: input.project,
        threadId: sessionId,
        provider: skillProvider as SkillProvider,
        repository: skillRepo,
        cloudAgent: {
          workItemTitle: locked.name,
          branchName,
          baseBranch: skillBranch,
          initiatorName: input.displayName,
          ...(input.email ? { initiatorEmail: input.email } : {}),
          delivery: 'background-job',
          opensPullRequest: true,
          backgroundJobId: locked.id,
          backgroundJobName: locked.name,
          notifyUserId: input.userId,
          ...(skillName ? { skillName } : {}),
          ...(workItem
            ? { bugWorkItemId: workItem.workItemId, ...(workItem.workItemUrl ? { bugUrl: workItem.workItemUrl } : {}) }
            : {}),
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
    await tx.insert(cloudBackgroundJobRuns).values({
      jobId: locked.id,
      project: input.project,
      agentRunId: runId,
      sessionId,
      trigger: input.trigger,
      startedBy: input.userId,
      createdAt: nowIso,
    });
    await tx
      .update(cloudBackgroundJobs)
      .set({ lastStartedAt: nowIso })
      .where(eq(cloudBackgroundJobs.id, locked.id));
    return { sessionId, runId };
  }).catch((err) => {
    if (err instanceof CloudBackgroundJobError && input.trigger === 'schedule' && err.status === 409) {
      return null;
    }
    throw err;
  });

  if (!started) return null;
  try {
    await claimAndLaunchCloudAgentRun(started.runId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Cloud Agent launch failed';
    try {
      await markTerminal(started.runId, { status: 'failed', detail });
    } catch (markErr) {
      console.error('[cloud-background-job] could not record launch failure', JSON.stringify({
        runId: started.runId,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      }));
    }
    await notifyCloudBackgroundJobTerminal({
      runId: started.runId,
      status: 'failed',
      detail,
    });
  }
  return started;
}

export async function notifyCloudBackgroundJobTerminal(input: {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  prUrl?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    const run = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, input.runId),
    });
    const cloud = cloudAgentFields(run?.executionSnapshot);
    if (cloud?.delivery !== 'background-job' || !cloud.notifyUserId) return;
    const name = cloud.backgroundJobName?.trim() || 'Background job';
    const title = input.status === 'completed'
      ? `${name} finished`
      : input.status === 'cancelled'
        ? `${name} was cancelled`
        : `${name} failed`;
    const body = input.prUrl?.trim()
      || (input.status === 'failed' ? input.detail?.trim() : '')
      || (input.status === 'completed'
        ? 'The Cloud Agent finished.'
        : input.status === 'cancelled'
          ? 'The Cloud Agent was cancelled.'
          : 'The Cloud Agent did not finish the job.');
    await createNotification(cloud.notifyUserId, {
      type: 'background',
      title,
      body,
      link: '/admin/project-settings',
    }, { dedupeKey: `cloud-background-job:${input.runId}:${input.status}` });
  } catch (err) {
    console.error('[cloud-background-job] notification failed', JSON.stringify({
      runId: input.runId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function sweepDueCloudBackgroundJobs(now = new Date()): Promise<void> {
  const jobs = await db
    .select({
      id: cloudBackgroundJobs.id,
      project: cloudBackgroundJobs.project,
      createdBy: cloudBackgroundJobs.createdBy,
      scheduleKind: cloudBackgroundJobs.scheduleKind,
      scheduleHour: cloudBackgroundJobs.scheduleHour,
      scheduleMinute: cloudBackgroundJobs.scheduleMinute,
      lastStartedAt: cloudBackgroundJobs.lastStartedAt,
    })
    .from(cloudBackgroundJobs)
    .where(and(
      eq(cloudBackgroundJobs.enabled, true),
      eq(cloudBackgroundJobs.scheduleKind, 'daily'),
    ));

  for (const job of jobs) {
    if (!isDailyCloudBackgroundJobDue({
      scheduleKind: job.scheduleKind,
      scheduleHour: job.scheduleHour,
      scheduleMinute: job.scheduleMinute,
      lastStartedAt: job.lastStartedAt,
      now,
    })) continue;
    try {
      await startCloudBackgroundJob({
        project: job.project,
        jobId: job.id,
        trigger: 'schedule',
        userId: job.createdBy,
        displayName: 'Scheduled background job',
        now,
      });
    } catch (err) {
      const status = err instanceof CloudBackgroundJobError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) {
        console.error('[cloud-background-job] scheduled start failed', JSON.stringify({
          jobId: job.id,
          project: job.project,
          error: message,
        }));
      } else {
        console.warn('[cloud-background-job] scheduled start skipped', JSON.stringify({
          jobId: job.id,
          project: job.project,
          error: message,
        }));
      }
    }
  }
}
