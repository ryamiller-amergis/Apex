/**
 * Production wiring for the dispatcher, the completion handler, and the sweep.
 * Tests build their own with the factories; later features swap a port with
 * `registerBuildDispatchPorts`.
 */
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { BuildSuspendReason } from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRuns, buildTasks, playbookStepRuns } from '../../db/schema';
import { markTerminal, requestCancel } from '../agentRunLifecycleService';
import { AzureDevOpsService } from '../azureDevOps';
import { mergeTaskBranch } from '../build/buildMergeService';
import { applyMergeOutcome } from '../build/mergeOutcome';
import { createMayReportDone } from '../builds/buildVerificationApply';
import { recordTaskEvidence } from '../builds/verificationEvidenceRecorder';
import {
  cancelCursorCloudAgentRun,
  getCloudAgentRun,
  streamCloudAgentRun,
} from '../cursorCloudAgentClient';
import { trackEvent } from '../telemetry';
import {
  createCompletionHandler,
  createCompletionWatcher,
  type CompletionDeps,
  type CompletionOutcome,
} from './applyCompletion';
import { createDispatchNext, type DispatchOutcome } from './dispatchRun';
import {
  canObserveAgentRun,
  createDrizzleDispatchStore,
  type BuildAgentRunRow,
} from './dispatchStore';
import {
  checkTaskLaunch,
  defaultLaunchGuardDeps,
  readBuildFlag,
} from './launchGuard';
import { createBuildReconciler, type BuildSweepOutcome } from './reconcile';
import { buildTaskLaunchCandidate } from './taskCandidateBuilder';
import { createTaskFailurePolicy } from './taskFailure';
import {
  createTaskLauncher,
  type BuildLaunchCandidateBuilder,
} from './taskLauncher';

export interface BuildDispatchPorts {
  buildCandidate: BuildLaunchCandidateBuilder;
  mayReportDone: CompletionDeps['mayReportDone'];
  requestMerge: CompletionDeps['requestMerge'];
}

const baseMayReportDone = createMayReportDone();

const defaultMayReportDone: CompletionDeps['mayReportDone'] = async (input) => {
  if (await baseMayReportDone(input)) return true;

  const store = createDrizzleDispatchStore();
  for (const taskId of input.taskIds) {
    try {
      const currentAgent = await store.currentAgentRunForTask(taskId);
      if (currentAgent && canObserveAgentRun(currentAgent)) {
        const observed = await getCloudAgentRun({
          project: currentAgent.projectId,
          cloudAgentId: currentAgent.cloudAgentIdentity,
          cursorRunId: currentAgent.dispatchMessageId,
        });
        if (observed.resultText) {
          const [taskRow] = await db
            .select({ attempt: buildTasks.attempt })
            .from(buildTasks)
            .where(eq(buildTasks.id, taskId))
            .limit(1);
          await recordTaskEvidence({
            buildTaskId: taskId,
            attemptNumber: taskRow?.attempt ?? 1,
            message: observed.resultText,
            agentRunId: currentAgent.id,
          });
        }
      }
    } catch {
      // Ignore evidence parse errors and fall through to check
    }
  }

  if (await baseMayReportDone(input)) return true;

  // Fallback for POC runs: if the agent pushed its task branch to Azure DevOps, allow merge
  try {
    const [headTask] = await db
      .select({ branchName: buildTasks.branchName })
      .from(buildTasks)
      .where(eq(buildTasks.id, input.taskIds[0]))
      .limit(1);
    const [runRow] = await db
      .select({ project: buildRuns.project, repository: buildRuns.repository })
      .from(buildRuns)
      .where(eq(buildRuns.id, input.buildRunId))
      .limit(1);
    if (headTask?.branchName && runRow) {
      const ado = new AzureDevOpsService(runRow.project);
      const branchHead = await ado.getBranchHeadCommit(
        runRow.repository,
        runRow.project,
        headTask.branchName
      );
      if (branchHead) return true;
    }
  } catch {
    // Fall through
  }

  return false;
};

const defaultPorts: BuildDispatchPorts = {
  buildCandidate: buildTaskLaunchCandidate,
  mayReportDone: defaultMayReportDone,
  requestMerge: async ({ headTaskId }) => {
    const outcome = await mergeTaskBranch(headTaskId);
    await applyMergeOutcome(headTaskId, outcome);
  },
};

let ports: BuildDispatchPorts = defaultPorts;
let services: ReturnType<typeof createServices> | null = null;

export function registerBuildDispatchPorts(
  overrides: Partial<BuildDispatchPorts>
): void {
  ports = { ...ports, ...overrides };
  services = null;
}

async function cancelAgent(agentRun: BuildAgentRunRow): Promise<void> {
  await requestCancel(agentRun.id);
  if (
    agentRun.projectId &&
    agentRun.cloudAgentIdentity &&
    agentRun.dispatchMessageId
  ) {
    await cancelCursorCloudAgentRun({
      project: agentRun.projectId,
      cloudAgentId: agentRun.cloudAgentIdentity,
      cursorRunId: agentRun.dispatchMessageId,
    });
  }
  await markTerminal(agentRun.id, {
    status: 'cancelled',
    terminalReason: 'forced_cancel',
    ...(agentRun.dispatchMessageId
      ? { dispatchMessageId: agentRun.dispatchMessageId }
      : {}),
  });
}

function createServices() {
  const store = createDrizzleDispatchStore();
  const guardDeps = defaultLaunchGuardDeps((userId) =>
    store.loadUserEmail(userId)
  );
  const failTask = createTaskFailurePolicy({ store, track: trackEvent });

  let dispatchNext: (
    buildRunId: string
  ) => Promise<DispatchOutcome> = async () => {
    throw new Error('Build dispatch is not ready.');
  };

  const applyCompletion = createCompletionHandler({
    store,
    observe: getCloudAgentRun,
    markTerminal: async (agentRunId, status, dispatchMessageId) => {
      await markTerminal(agentRunId, {
        status,
        ...(dispatchMessageId ? { dispatchMessageId } : {}),
      });
    },
    mayReportDone: (input) => ports.mayReportDone(input),
    requestMerge: (input) => ports.requestMerge(input),
    failTask,
    dispatchNext: (buildRunId) => dispatchNext(buildRunId),
    track: trackEvent,
  });

  const watcher = createCompletionWatcher({
    stream: streamCloudAgentRun,
    apply: applyCompletion,
  });

  dispatchNext = createDispatchNext({
    store,
    guard: (run) => checkTaskLaunch(run, guardDeps),
    launch: createTaskLauncher({
      buildCandidate: (request) => ports.buildCandidate(request),
    }),
    failTask,
    onLaunched: (agent) => watcher.watch(agent),
    track: trackEvent,
  });

  const reconcile = createBuildReconciler({
    store,
    readFlag: (run) => readBuildFlag(run, guardDeps),
    applyCompletion,
    dispatchNext,
    cancelAgent,
    track: trackEvent,
  });

  return { store, dispatchNext, applyCompletion, reconcile };
}

function current(): ReturnType<typeof createServices> {
  services ??= createServices();
  return services;
}

/** Launches whatever the plan allows now. The merge step calls this right after a task merges. */
export function dispatchNext(buildRunId: string): Promise<DispatchOutcome> {
  return current().dispatchNext(buildRunId);
}

export function applyAgentCompletion(input: {
  agentRunId: string;
}): Promise<CompletionOutcome> {
  return current().applyCompletion(input);
}

async function reconcileAcceptedBuilds(): Promise<void> {
  const rows = await db
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .leftJoin(
      playbookStepRuns,
      eq(playbookStepRuns.id, buildRuns.playbookStepRunId)
    )
    .where(
      and(
        eq(buildRuns.status, 'accepted'),
        or(
          isNull(buildRuns.pullRequestUrl),
          and(
            isNotNull(buildRuns.playbookStepRunId),
            eq(playbookStepRuns.status, 'suspended')
          )
        )
      )
    )
    .limit(25);

  if (rows.length === 0) return;
  const { defaultBuildAcceptService } =
    await import('../build/buildAcceptService');
  for (const row of rows) {
    try {
      await defaultBuildAcceptService.continueAccept(row.id);
    } catch (error) {
      console.warn(
        '[build-reconciliation] accepted build retry failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

export async function reconcileBuildRuns(): Promise<BuildSweepOutcome> {
  const outcome = await current().reconcile();
  await reconcileAcceptedBuilds();
  return outcome;
}

/** The one place that suspends an active run and writes its timeline event. */
export async function suspendRun(
  buildRunId: string,
  reason: BuildSuspendReason
): Promise<boolean> {
  const suspended = await current().store.suspend(buildRunId, reason);
  if (suspended) trackEvent('build_run.suspended', { buildRunId, reason });
  return suspended;
}
