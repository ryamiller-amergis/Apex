/**
 * Production wiring. Tests pass their own store and launcher.
 * The execution snapshot is written before the Cloud Agent SDK call.
 */
import { eq } from 'drizzle-orm';
import { isAgentRunTerminalStatus } from '../../../shared/types/agentRunLifecycle';
import { integrationBranchName } from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { agentRuns } from '../../db/schema';
import { captureCloudAgentIdentity, enqueue, markTerminal } from '../agentRunLifecycleService';
import { readRepoFile } from '../buildPreflight/repoReader';
import { cancelCursorCloudAgentRun, launchCloudAgent } from '../cursorCloudAgentClient';
import { trackEvent } from '../telemetry';
import type { BuildPlanningDeps } from './buildPlanningService';
import { createDrizzlePlanningStore } from './drizzlePlanningStore';
import { assertBuildLaunchAllowed } from './launchGuard';
import type { AgentRunOutcome, PlannerLaunchRequest, PlannerLaunchResult, PlanningView } from './planningModel';
import { buildPlanFilePath } from './plannerResult';

const PLANNER_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The cloud-agent queue pump only claims rows whose owner is null, and it
 * fails rows without a My Work snapshot. Planner rows are launched here, so
 * they are created already owned.
 */
export const BUILD_PLANNER_OWNER = 'build-planner';

export function createPlanningDeps(): BuildPlanningDeps {
  const store = createDrizzlePlanningStore();
  return {
    store,
    assertLaunch: (input) => assertBuildLaunchAllowed(input, {
      loadRun: async (buildRunId) => {
        const row = await store.load(buildRunId);
        if (!row) return null;
        return { userId: row.requestedByUserId, project: row.project };
      },
    }),
    launch: launchPlanner,
    readPlanFile: readCommittedPlan,
    releaseAgentRun,
    track: (name, properties) => trackEvent(name, properties),
  };
}

async function launchPlanner(request: PlannerLaunchRequest): Promise<PlannerLaunchResult> {
  const threadId = `build:${request.buildRunId}`;
  const timeoutAt = new Date(Date.now() + PLANNER_TIMEOUT_MS).toISOString();
  const { runId } = await enqueue({
    threadId,
    projectId: request.project,
    timeoutAt,
    lane: 'cloud-agent',
    ownerInstance: BUILD_PLANNER_OWNER,
    buildTaskId: request.plannerTaskId,
    workflowClass: 'build-task',
    snapshot: {
      prompt: request.prompt,
      model: request.model,
      workspaceRef: request.repository,
      workflowClass: 'build-task',
      skillPath: request.skillPath,
      projectId: request.project,
      threadId,
      repository: request.repository,
      provider: 'ado',
    },
  });

  let launched: Awaited<ReturnType<typeof launchCloudAgent>>;
  try {
    launched = await launchCloudAgent({
      project: request.project,
      prompt: request.prompt,
      model: request.model,
      skillProvider: 'ado',
      skillRepo: request.repository,
      skillBranch: request.startingRef,
      workItemTitle: `Build plan ${request.buildRunId}`,
      skillName: 'build-planner',
      openPullRequest: false,
    });
  } catch (error) {
    await releaseAgentRun(runId, 'failed');
    throw error;
  }

  let captureError: string;
  try {
    const identity = await captureCloudAgentIdentity(runId, {
      cloudAgentIdentity: launched.cloudAgentId,
      cursorRunId: launched.cursorRunId,
      jobName: launched.jobName,
      branchName: launched.branchName ?? request.integrationBranch,
      timeoutAt,
    });
    if (identity.ok) return { agentRunId: runId };
    captureError = identity.reason;
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error);
  }
  await cancelQuietly(runId, {
    project: request.project,
    cloudAgentId: launched.cloudAgentId,
    cursorRunId: launched.cursorRunId,
  });
  await releaseAgentRun(runId, 'failed');
  throw new Error(`The planning agent run ${runId} could not be marked running: ${captureError}`);
}

async function releaseAgentRun(id: string, outcome: AgentRunOutcome): Promise<void> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, id),
    columns: { projectId: true, cloudAgentIdentity: true, dispatchMessageId: true, status: true },
  });
  if (!row || isAgentRunTerminalStatus(row.status)) return;
  if (outcome === 'cancelled' && row.projectId && row.cloudAgentIdentity && row.dispatchMessageId) {
    await cancelQuietly(id, {
      project: row.projectId,
      cloudAgentId: row.cloudAgentIdentity,
      cursorRunId: row.dispatchMessageId,
    });
  }
  const result = await markTerminal(id, {
    status: outcome,
    ...(outcome === 'cancelled' ? { terminalReason: 'forced_cancel' as const } : {}),
    ...(row.dispatchMessageId ? { dispatchMessageId: row.dispatchMessageId } : {}),
  });
  if (!result.ok) {
    console.warn('[build-planning] could not end the old planner agent run', JSON.stringify({
      agentRunId: id,
      reason: result.reason,
    }));
  }
}

async function cancelQuietly(
  id: string,
  target: { project: string; cloudAgentId: string; cursorRunId: string },
): Promise<void> {
  try {
    await cancelCursorCloudAgentRun(target);
  } catch (error) {
    console.warn('[build-planning] could not cancel the planner agent', JSON.stringify({
      agentRunId: id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function readCommittedPlan(view: PlanningView, reportedBranch: string | null): Promise<string | null> {
  const branch = reportedBranch?.trim()
    || view.integrationBranch
    || integrationBranchName(view.buildRunId);
  return readRepoFile(
    { adoProject: view.project, repo: view.repository, branch },
    buildPlanFilePath(view.buildRunId),
  );
}
