import { and, desc, eq, inArray } from 'drizzle-orm';
import type { BuildPlan } from '../../../shared/buildPlanSchema';
import {
  taskBranchName,
  type BuildRequirement,
  type BuildRiskDecision,
} from '../../../shared/types/build';
import type { BuildStepOutput } from '../../../shared/types/playbook';
import { db } from '../../db/drizzle';
import {
  agentRuns,
  buildRevisions,
  buildRuns,
  buildTasks,
} from '../../db/schema';
import { applyFinalCheckCompletion } from '../build/finalCheck';
import { appendBuildEvent } from '../buildEventsService';
import {
  getCloudAgentRun,
  type CloudAgentRunObservation,
} from '../cursorCloudAgentClient';
import { advanceRun } from '../playbookAdvanceService';
import { resumeStepRun } from '../playbookSteps/stepRuns';
import { beginPlanningRow, loadBuild } from './store';
import { buildTaskLaunchCandidate } from './taskCandidateBuilder';
import { createTaskLauncher } from './taskLauncher';
import {
  approveBuildBrief,
  draftBuildBrief,
  getRedactedBuildBrief,
} from '../buildBriefService';
import {
  createSingleAgentPlan,
  startSingleAgentBuild,
} from './singleAgentBuild';

const activeOrchestrations = new Set<string>();
const activeIntakeConfirmations = new Set<string>();
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ITERATIONS = 720;

export interface OrchestrationDriverDeps {
  observeAgent?: (input: {
    project: string;
    cloudAgentId: string;
    cursorRunId: string;
  }) => Promise<CloudAgentRunObservation>;
  sleep?: (ms: number) => Promise<void>;
}

export async function beginPlanning(
  buildRunId: string,
  stepRunId: string
): Promise<boolean> {
  const row = await loadBuild(buildRunId);
  if (!row || (row.status !== 'intake' && row.status !== 'planning')) return false;
  const started = await beginPlanningRow(buildRunId, stepRunId);
  if (started && process.env.NODE_ENV !== 'test') {
    void driveBuildOrchestration(buildRunId);
  }
  return started;
}

/** Compatibility export for tests and callers that need the retained internal plan. */
export function synthesizeFallbackBuildPlan(
  buildRunId: string,
  requirements: BuildRequirement[],
  riskDecisions: BuildRiskDecision[]
): BuildPlan {
  return createSingleAgentPlan(buildRunId, requirements, riskDecisions);
}

async function markOrchestrationFailed(
  buildRunId: string,
  error: unknown
): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : 'The repository build agent did not start.';
  const now = new Date().toISOString();
  const [failed] = await db
    .update(buildRuns)
    .set({
      status: 'failed',
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(buildRuns.id, buildRunId),
        inArray(buildRuns.status, ['planning', 'building'])
      )
    )
    .returning({ id: buildRuns.id });
  if (!failed) return;

  await appendBuildEvent({
    buildRunId,
    eventType: 'build.failed',
    severity: 'error',
    message,
    detail: { stage: 'repository_agent_start' },
    dedupeKey: `${buildRunId}:repository-agent-start-failed`,
  });
  await reportBuildTerminal(buildRunId, {
    buildRunId,
    status: 'failed',
  });
}

export async function confirmAndStartPlanning(
  buildRunId: string,
  actorId: string
): Promise<boolean> {
  const row = await loadBuild(buildRunId);
  if (!row?.interviewId) return false;
  const started = await beginPlanningRow(buildRunId);
  if (!started) return false;

  if (process.env.NODE_ENV !== 'test') {
    void finalizeIntakeAndDrive(row.id, row.interviewId, actorId);
  }
  return true;
}

async function finalizeIntakeAndDrive(
  buildRunId: string,
  interviewId: string,
  actorId: string
): Promise<void> {
  if (activeIntakeConfirmations.has(buildRunId)) return;
  activeIntakeConfirmations.add(buildRunId);
  try {
    const existingBrief = await getRedactedBuildBrief(interviewId);
    if (!existingBrief) {
      await draftBuildBrief({
        interviewId,
        actorId,
        mode: 'manual',
      });
    }
    if (existingBrief?.status !== 'approved') {
      await approveBuildBrief({
        interviewId,
        actorId,
      });
    }
  } catch (error) {
    console.error(
      '[build-orchestrator] intake confirmation background step failed:',
      error instanceof Error ? error.message : String(error)
    );
    await markOrchestrationFailed(buildRunId, error);
    return;
  } finally {
    activeIntakeConfirmations.delete(buildRunId);
  }
  await driveBuildOrchestration(buildRunId);
}

/**
 * The Playbook `build` step delegates to one durable repository-agent run.
 * Scheduling, terminal events, retries, and recovery remain owned by the
 * shared agent lifecycle rather than by a process-local planner loop.
 */
export async function driveBuildOrchestration(
  buildRunId: string,
  _deps: OrchestrationDriverDeps = {}
): Promise<{ status: string }> {
  if (
    activeOrchestrations.has(buildRunId) ||
    activeIntakeConfirmations.has(buildRunId)
  ) {
    return { status: 'already_running' };
  }
  activeOrchestrations.add(buildRunId);

  try {
    const [revision] = await db
      .select({ id: buildRevisions.id })
      .from(buildRevisions)
      .where(
        and(
          eq(buildRevisions.buildRunId, buildRunId),
          eq(buildRevisions.revisionNumber, 1)
        )
      )
      .limit(1);
    if (!revision) {
      const row = await loadBuild(buildRunId);
      if (row?.interviewId) {
        const existingBrief = await getRedactedBuildBrief(row.interviewId);
        if (!existingBrief) {
          await draftBuildBrief({
            interviewId: row.interviewId,
            actorId: row.requestedByUserId,
            mode: 'manual',
          });
        }
        if (existingBrief?.status !== 'approved') {
          await approveBuildBrief({
            interviewId: row.interviewId,
            actorId: row.requestedByUserId,
          });
        }
      }
    }
    return await startSingleAgentBuild(buildRunId);
  } catch (error) {
    console.error(
      '[build-orchestrator] repository agent start failed:',
      error instanceof Error ? error.message : String(error)
    );
    await markOrchestrationFailed(buildRunId, error);
    return { status: 'error' };
  } finally {
    activeOrchestrations.delete(buildRunId);
  }
}

/**
 * Compatibility path for revisions that genuinely need a separate final-check
 * agent. Single-agent builds normally skip this through `onAllTasksMerged`.
 */
export async function launchFinalCheckForRun(
  buildRunId: string,
  deps: OrchestrationDriverDeps = {}
): Promise<void> {
  const [run] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run || run.status !== 'checking') return;

  const [revision] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.buildRunId, buildRunId),
        eq(buildRevisions.revisionNumber, run.currentRevisionNumber)
      )
    )
    .limit(1);
  if (!revision) return;

  const [checkTask] = await db
    .select()
    .from(buildTasks)
    .where(
      and(
        eq(buildTasks.buildRevisionId, revision.id),
        eq(buildTasks.taskKey, 'final-check')
      )
    )
    .limit(1);
  if (!checkTask || checkTask.status !== 'ready') return;

  const branchName = `${taskBranchName(run.id, 'final-check')}-${checkTask.attempt}`;
  const now = new Date().toISOString();
  const claimed = await db
    .update(buildTasks)
    .set({
      status: 'running',
      branchName,
      startedAt: now,
      updatedAt: now,
    })
    .where(and(eq(buildTasks.id, checkTask.id), eq(buildTasks.status, 'ready')))
    .returning();
  if (claimed.length === 0) return;

  const launcher = createTaskLauncher({
    buildCandidate: buildTaskLaunchCandidate,
  });
  const launched = await launcher({
    run: {
      id: run.id,
      status: run.status,
      suspendReason: run.suspendReason ?? null,
      project: run.project,
      requesterUserId: run.requestedByUserId,
      parallelismCap: run.parallelismCap,
      revisionId: revision.id,
    },
    unit: {
      mode: 'own_agent',
      headKey: 'final-check',
      taskKeys: ['final-check'],
    },
    tasks: [
      {
        id: checkTask.id,
        key: checkTask.taskKey,
        role: checkTask.role,
        status: 'running',
        attempt: checkTask.attempt,
        blockers: checkTask.dependsOn,
        chainHeadKey: null,
        branchName,
      },
    ],
    attempt: checkTask.attempt,
    branchName,
  });
  if (launched.kind !== 'launched') return;

  const observe = deps.observeAgent ?? getCloudAgentRun;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  void (async () => {
    for (let iteration = 0; iteration < MAX_POLL_ITERATIONS; iteration += 1) {
      const observation = await observe({
        project: run.project,
        cloudAgentId: launched.cloudAgentId,
        cursorRunId: launched.cursorRunId,
      });
      if (observation.settled) {
        await applyFinalCheckCompletion(checkTask.id, observation);
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  })().catch((error) => {
    console.warn(
      '[build-orchestrator] final-check watcher error:',
      error instanceof Error ? error.message : String(error)
    );
  });
}

export async function reportBuildTerminal(
  buildRunId: string,
  result: BuildStepOutput
): Promise<void> {
  const row = await loadBuild(buildRunId);
  if (!row?.playbookStepRunId) return;
  const resumed = await resumeStepRun({
    stepRunId: row.playbookStepRunId,
    output: {
      buildRunId: result.buildRunId,
      status: result.status,
      ...(result.pullRequestUrl
        ? { pullRequestUrl: result.pullRequestUrl }
        : {}),
    },
  });
  if (!resumed || !row.playbookRunId) return;
  await advanceRun(row.playbookRunId);
}

/** Finds the one repository agent so the workspace can show live progress. */
export async function getActiveBuildAgentSummary(buildRunId: string): Promise<{
  agentRunId: string;
  taskKey: string;
  role: string;
  status: string;
  branchName: string | null;
  startedAt: string | null;
} | null> {
  const [run] = await db
    .select({ currentRevisionNumber: buildRuns.currentRevisionNumber })
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!run) return null;

  const [revision] = await db
    .select({ id: buildRevisions.id })
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.buildRunId, buildRunId),
        eq(buildRevisions.revisionNumber, run.currentRevisionNumber)
      )
    )
    .limit(1);
  if (!revision) return null;

  const [activeTask] = await db
    .select()
    .from(buildTasks)
    .where(
      and(
        eq(buildTasks.buildRevisionId, revision.id),
        eq(buildTasks.status, 'running')
      )
    )
    .orderBy(desc(buildTasks.updatedAt))
    .limit(1);
  if (!activeTask) return null;

  const [agent] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.buildTaskId, activeTask.id))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);

  return {
    agentRunId: agent?.id ?? activeTask.id,
    taskKey: activeTask.taskKey,
    role: activeTask.role,
    status: agent?.status ?? activeTask.status,
    branchName: activeTask.branchName ?? null,
    startedAt: activeTask.startedAt ?? null,
  };
}
