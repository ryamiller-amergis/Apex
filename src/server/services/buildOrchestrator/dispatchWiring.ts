/**
 * Production wiring for the dispatcher, the completion handler, and the sweep.
 * Tests build their own with the factories; later features swap a port with
 * `registerBuildDispatchPorts`.
 */
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { BuildSuspendReason } from '../../../shared/types/build';
import type { CloudAgentActivityEvent } from '../../../shared/types/devWorkbench';
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
import { DISPATCH_EVENT_TYPES } from './dispatchEvents';
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
  let anyRefused = false;
  for (const taskId of input.taskIds) {
    try {
      const currentAgent = await store.currentAgentRunForTask(taskId);
      if (currentAgent && canObserveAgentRun(currentAgent)) {
        const observed = await getCloudAgentRun({
          project: currentAgent.projectId,
          cloudAgentId: currentAgent.cloudAgentIdentity,
          cursorRunId: currentAgent.dispatchMessageId,
        });
        let recordedOutcome: 'done' | 'refused' | 'escalate' | null = null;
        if (observed.resultText) {
          const [taskRow] = await db
            .select({ attempt: buildTasks.attempt })
            .from(buildTasks)
            .where(eq(buildTasks.id, taskId))
            .limit(1);
          const recorded = await recordTaskEvidence({
            buildTaskId: taskId,
            attemptNumber: taskRow?.attempt ?? 1,
            message: observed.resultText,
            agentRunId: currentAgent.id,
          });
          if (!recorded.stale) {
            recordedOutcome = recorded.outcome;
          }
        }
        // Never allow an agent that stopped with a red-only escalation to merge as a finished feature.
        if (
          recordedOutcome === 'escalate' ||
          (observed.resultText &&
            /stopped before building|does not fit the small path/i.test(
              observed.resultText
            ))
        ) {
          return false;
        }
        if (recordedOutcome === 'refused') anyRefused = true;
      }
    } catch (error) {
      console.warn('[build-dispatch] could not record task evidence', JSON.stringify({
        buildRunId: input.buildRunId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  if (await baseMayReportDone(input)) return true;
  // A refused evidence block means the agent's own checks failed; a pushed branch does not override that.
  if (anyRefused) return false;

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

  const lastActivityAtByAgent = new Map<string, number>();
  const ACTIVITY_THROTTLE_MS = 30_000;

  const describeAgentActivity = (event: unknown): string | null => {
    if (!event || typeof event !== 'object') return null;
    const item = event as Partial<CloudAgentActivityEvent>;
    if (item.kind === 'tool' && typeof item.title === 'string') {
      const tool = item.title.toLowerCase();
      if (tool.includes('edit') || tool.includes('write')) {
        return 'Building and testing — updating repository files.';
      }
      if (tool.includes('terminal') || tool.includes('cmd') || tool.includes('bash')) {
        return 'Building and testing — running repository checks and tests.';
      }
      if (tool.includes('read') || tool.includes('grep') || tool.includes('search')) {
        return 'Building and testing — inspecting repository code.';
      }
      return 'Building and testing — working in the repository.';
    }
    if (item.kind === 'task' && typeof item.title === 'string' && item.title.trim()) {
      return `Building and testing — ${item.title.trim().slice(0, 120)}`;
    }
    if (item.kind === 'assistant' && typeof item.detail === 'string' && item.detail.trim()) {
      const firstLine = item.detail
        .trim()
        .split(/\r?\n/)[0]
        ?.replace(/^[#*>-]+\s*/, '')
        .trim();
      if (firstLine && !firstLine.startsWith('```') && !firstLine.startsWith('{')) {
        return `Building and testing — ${firstLine.slice(0, 120)}`;
      }
    }
    return null;
  };

  const watcher = createCompletionWatcher({
    stream: streamCloudAgentRun,
    apply: applyCompletion,
    onActivity: async (target, rawEvent) => {
      const nowMs = Date.now();
      const lastMs = lastActivityAtByAgent.get(target.agentRunId) ?? 0;
      if (nowMs - lastMs < ACTIVITY_THROTTLE_MS) return;
      const message = describeAgentActivity(rawEvent);
      if (!message) return;
      lastActivityAtByAgent.set(target.agentRunId, nowMs);
      const agentRun = await store.loadAgentRun(target.agentRunId);
      if (!agentRun) return;
      const context = await store.loadTaskContext(agentRun.buildTaskId);
      if (!context) return;
      await store.appendEvent({
        buildRunId: context.buildRunId,
        buildRevisionId: context.revisionId,
        eventType: 'task.progress',
        message,
        detail: { taskKey: context.task.key },
        correlation: { kind: 'agent_run', id: target.agentRunId },
      });
    },
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
    or(
      and(
        eq(buildRuns.status, 'checking'),
        isNotNull(buildRuns.acceptedRevisionNumber),
        isNull(buildRuns.pullRequestUrl)
      ),
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

/**
 * Resume of a build stopped on a refused report: re-read the stopped `build-feature`
 * agent's last report under the current rules. A passing report merges; otherwise the
 * task goes back to ready and the next launch is the fix-up pass on the same agent.
 */
export async function recheckStoppedBuildFeature(
  buildRunId: string
): Promise<'merged' | 'fix_up' | 'none'> {
  const store = current().store;
  const run = await store.loadRun(buildRunId);
  if (!run || run.status !== 'building' || !run.revisionId) return 'none';
  const head = (await store.loadPlanTasks(run.revisionId)).find(
    (task) => task.key === 'build-feature' && task.status === 'failed'
  );
  if (!head) return 'none';

  const reopened = await db
    .update(buildTasks)
    .set({ status: 'running', updatedAt: new Date().toISOString() })
    .where(and(eq(buildTasks.id, head.id), eq(buildTasks.status, 'failed')))
    .returning({ id: buildTasks.id });
  if (reopened.length === 0) return 'none';

  if (await ports.mayReportDone({ buildRunId, taskIds: [head.id] })) {
    await store.appendEvent({
      buildRunId,
      buildRevisionId: run.revisionId,
      eventType: DISPATCH_EVENT_TYPES.taskCompleted,
      message: 'The feature passed its checks.',
      detail: { taskKeys: [head.key], recheck: true },
      dedupeKey: `recheck:${head.id}:${head.attempt}`,
    });
    await ports.requestMerge({ buildRunId, headTaskId: head.id, taskIds: [head.id] });
    return 'merged';
  }
  await store.resetToReady([head.id]);
  return 'fix_up';
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
