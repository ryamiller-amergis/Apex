/**
 * Production wiring for the dispatcher, the completion handler, and the sweep.
 * Tests build their own with the factories; later features swap a port with
 * `registerBuildDispatchPorts`.
 */
import type { BuildSuspendReason } from '../../../shared/types/build';
import { markTerminal, requestCancel } from '../agentRunLifecycleService';
import { cancelCursorCloudAgentRun, getCloudAgentRun, streamCloudAgentRun } from '../cursorCloudAgentClient';
import { trackEvent } from '../telemetry';
import {
  createCompletionHandler,
  createCompletionWatcher,
  type CompletionDeps,
  type CompletionOutcome,
} from './applyCompletion';
import { createDispatchNext, type DispatchOutcome } from './dispatchRun';
import { createDrizzleDispatchStore, type BuildAgentRunRow } from './dispatchStore';
import { checkTaskLaunch, defaultLaunchGuardDeps, readBuildFlag } from './launchGuard';
import { createBuildReconciler, type BuildSweepOutcome } from './reconcile';
import { createTaskFailurePolicy } from './taskFailure';
import { candidateBuilderUnavailable, createTaskLauncher, type BuildLaunchCandidateBuilder } from './taskLauncher';

export interface BuildDispatchPorts {
  buildCandidate: BuildLaunchCandidateBuilder;
  mayReportDone: CompletionDeps['mayReportDone'];
  requestMerge: CompletionDeps['requestMerge'];
}

const unavailablePorts: BuildDispatchPorts = {
  buildCandidate: candidateBuilderUnavailable,
  mayReportDone: async () => false,
  requestMerge: async () => {
    throw new Error('The build merge step is not available.');
  },
};

let ports: BuildDispatchPorts = unavailablePorts;
let services: ReturnType<typeof createServices> | null = null;

export function registerBuildDispatchPorts(overrides: Partial<BuildDispatchPorts>): void {
  ports = { ...ports, ...overrides };
  services = null;
}

async function cancelAgent(agentRun: BuildAgentRunRow): Promise<void> {
  await requestCancel(agentRun.id);
  if (agentRun.projectId && agentRun.cloudAgentIdentity && agentRun.dispatchMessageId) {
    await cancelCursorCloudAgentRun({
      project: agentRun.projectId,
      cloudAgentId: agentRun.cloudAgentIdentity,
      cursorRunId: agentRun.dispatchMessageId,
    });
  }
  await markTerminal(agentRun.id, {
    status: 'cancelled',
    terminalReason: 'forced_cancel',
    ...(agentRun.dispatchMessageId ? { dispatchMessageId: agentRun.dispatchMessageId } : {}),
  });
}

function createServices() {
  const store = createDrizzleDispatchStore();
  const guardDeps = defaultLaunchGuardDeps((userId) => store.loadUserEmail(userId));
  const failTask = createTaskFailurePolicy({ store, track: trackEvent });

  let dispatchNext: (buildRunId: string) => Promise<DispatchOutcome> = async () => {
    throw new Error('Build dispatch is not ready.');
  };

  const applyCompletion = createCompletionHandler({
    store,
    observe: getCloudAgentRun,
    markTerminal: async (agentRunId, status, dispatchMessageId) => {
      await markTerminal(agentRunId, { status, ...(dispatchMessageId ? { dispatchMessageId } : {}) });
    },
    mayReportDone: (input) => ports.mayReportDone(input),
    requestMerge: (input) => ports.requestMerge(input),
    failTask,
    dispatchNext: (buildRunId) => dispatchNext(buildRunId),
    track: trackEvent,
  });

  const watcher = createCompletionWatcher({ stream: streamCloudAgentRun, apply: applyCompletion });

  dispatchNext = createDispatchNext({
    store,
    guard: (run) => checkTaskLaunch(run, guardDeps),
    launch: createTaskLauncher({ buildCandidate: (request) => ports.buildCandidate(request) }),
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

export function applyAgentCompletion(input: { agentRunId: string }): Promise<CompletionOutcome> {
  return current().applyCompletion(input);
}

export function reconcileBuildRuns(): Promise<BuildSweepOutcome> {
  return current().reconcile();
}

/** The one place that suspends an active run and writes its timeline event. */
export async function suspendRun(buildRunId: string, reason: BuildSuspendReason): Promise<boolean> {
  const suspended = await current().store.suspend(buildRunId, reason);
  if (suspended) trackEvent('build_run.suspended', { buildRunId, reason });
  return suspended;
}
