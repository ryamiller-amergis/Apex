import type {
  BuildClassification,
  BuildRunStatus,
  BuildSuspendReason,
  BuildTaskStatus,
} from '../../shared/types/build';
import {
  BUILD_DELIVERY_TARGET_SECONDS,
  type BuildStageView,
  type BuildTimingView,
} from '../../shared/types/buildView';

export interface DeriveBuildStageInput {
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  tasks: ReadonlyArray<{ status: BuildTaskStatus }>;
  queuePosition: number | null;
}

function countTasks(tasks: DeriveBuildStageInput['tasks']): BuildStageView['tasks'] {
  if (tasks.length === 0) return null;
  let merged = 0;
  let total = 0;
  for (const task of tasks) {
    if (task.status === 'omitted') continue;
    total += 1;
    if (task.status === 'merged') merged += 1;
  }
  return { merged, total };
}

export function deriveBuildStage(input: DeriveBuildStageInput): BuildStageView {
  const tasks = countTasks(input.tasks);
  const { status } = input;
  switch (status) {
    case 'queued':
      return { kind: 'stage', key: status, tasks, queuePosition: input.queuePosition, suspendReason: null };
    case 'intake':
    case 'planning':
    case 'building':
    case 'checking':
    case 'deploying':
    case 'preview_ready':
      return { kind: 'stage', key: status, tasks, queuePosition: null, suspendReason: null };
    case 'suspended':
      return { kind: 'exception', key: status, tasks, queuePosition: null, suspendReason: input.suspendReason };
    case 'deployment_failed':
    case 'needs_developer':
    case 'failed':
    case 'cancelled':
    case 'accepted':
      return { kind: 'exception', key: status, tasks, queuePosition: null, suspendReason: null };
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled build status: ${String(unhandled)}`);
    }
  }
}

export interface DeriveBuildTimingInput {
  classification: BuildClassification | null;
  startedAt: string | null;
  deployStartedAt: string | null;
  deployFinishedAt: string | null;
  endedAt: string | null;
  /** False when the revision has no deployment timestamps, so elapsed cannot exclude deployment. */
  deploymentTimesKnown: boolean;
  now: Date;
}

function seconds(fromIso: string, to: number): number {
  return Math.max(0, Math.floor((to - Date.parse(fromIso)) / 1000));
}

export function deriveBuildTiming(input: DeriveBuildTimingInput): BuildTimingView {
  const targetSeconds = input.classification ? BUILD_DELIVERY_TARGET_SECONDS[input.classification] : null;
  const includesDeployment = !input.deploymentTimesKnown;
  if (!input.startedAt) {
    return { elapsedSeconds: null, targetSeconds, state: 'none', includesDeployment };
  }
  const end = input.endedAt ? Date.parse(input.endedAt) : input.now.getTime();
  let elapsedSeconds = seconds(input.startedAt, end);
  if (input.deploymentTimesKnown && input.deployStartedAt) {
    const deployEnd = input.deployFinishedAt ? Date.parse(input.deployFinishedAt) : end;
    elapsedSeconds = Math.max(0, elapsedSeconds - seconds(input.deployStartedAt, deployEnd));
  }
  let state: BuildTimingView['state'] = 'none';
  if (targetSeconds !== null) state = elapsedSeconds > targetSeconds ? 'over' : 'within';
  return { elapsedSeconds, targetSeconds, state, includesDeployment };
}
