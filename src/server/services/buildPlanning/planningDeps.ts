/**
 * Production wiring. Tests pass their own store and launcher.
 * The execution snapshot is written before the Cloud Agent SDK call.
 */
import { integrationBranchName } from '../../../shared/types/build';
import { enqueue, captureCloudAgentIdentity } from '../agentRunLifecycleService';
import { readRepoFile } from '../buildPreflight/repoReader';
import { launchCloudAgent } from '../cursorCloudAgentClient';
import { trackEvent } from '../telemetry';
import type { BuildPlanningDeps } from './buildPlanningService';
import { createDrizzlePlanningStore } from './drizzlePlanningStore';
import { assertBuildLaunchAllowed } from './launchGuard';
import type { PlannerLaunchRequest, PlannerLaunchResult, PlanningView } from './planningModel';
import { buildPlanFilePath } from './plannerResult';

const PLANNER_TIMEOUT_MS = 60 * 60 * 1000;

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
  const launched = await launchCloudAgent({
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
  await captureCloudAgentIdentity(runId, {
    cloudAgentIdentity: launched.cloudAgentId,
    cursorRunId: launched.cursorRunId,
    jobName: launched.jobName,
    branchName: launched.branchName ?? request.integrationBranch,
    timeoutAt,
  });
  return { agentRunId: runId };
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
