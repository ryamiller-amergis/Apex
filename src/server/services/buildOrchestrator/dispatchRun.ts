/**
 * The launch loop behind `dispatchNext`: select, guard, claim, launch.
 * The Cursor call happens after the claim commits, never inside the lock.
 */
import type { BuildSuspendReason } from '../../../shared/types/build';
import {
  DispatchInputError,
  selectNextLaunches,
  type DispatchDecision,
  type LaunchUnit,
} from './dispatcher';
import { DISPATCH_EVENT_TYPES } from './dispatchEvents';
import type { DispatchRunRow, DispatchStore, DispatchTaskRow } from './dispatchStore';
import type { GuardRun, LaunchGuardDecision } from './launchGuard';
import type { TaskFailurePolicy } from './taskFailure';
import type { BuildTaskLauncher } from './taskLauncher';

export type DispatchOutcome =
  | { kind: 'skipped'; reason: 'run_not_found' | 'not_building' | 'no_revision' }
  | { kind: 'suspended'; reason: BuildSuspendReason }
  | { kind: 'deferred'; headKey: string }
  | { kind: 'dispatched'; promoted: string[]; launched: string[]; waiting: string[] };

export interface LaunchedAgent {
  buildRunId: string;
  agentRunId: string;
  project: string;
  cloudAgentId: string;
  cursorRunId: string;
}

export interface DispatchDeps {
  store: DispatchStore;
  guard: (run: GuardRun) => Promise<LaunchGuardDecision>;
  launch: BuildTaskLauncher;
  failTask: TaskFailurePolicy;
  onLaunched?: (agent: LaunchedAgent) => void;
  track: (name: string, props: Record<string, string>, measurements?: Record<string, number>) => void;
}

export function createDispatchNext(deps: DispatchDeps): (buildRunId: string) => Promise<DispatchOutcome> {
  const { store, track } = deps;

  const suspend = async (run: DispatchRunRow, reason: BuildSuspendReason): Promise<DispatchOutcome> => {
    if (await store.suspend(run.id, reason)) {
      track('build_run.suspended', { buildRunId: run.id, reason });
    }
    return { kind: 'suspended', reason };
  };

  const membersOf = (unit: LaunchUnit, tasks: DispatchTaskRow[]): DispatchTaskRow[] =>
    unit.taskKeys.map((key) => tasks.find((task) => task.key === key)!);

  return async (buildRunId) => {
    const run = await store.loadRun(buildRunId);
    if (!run) return { kind: 'skipped', reason: 'run_not_found' };
    if (run.status !== 'building') return { kind: 'skipped', reason: 'not_building' };
    const revisionId = run.revisionId;
    if (!revisionId) return { kind: 'skipped', reason: 'no_revision' };

    const tasks = await store.loadPlanTasks(revisionId);
    let decision: DispatchDecision;
    try {
      decision = selectNextLaunches({
        tasks: tasks.map((task) => ({
          key: task.key,
          status: task.status,
          blockers: task.blockers,
          chainHeadKey: task.chainHeadKey,
        })),
        parallelismLimit: run.parallelismCap,
      });
    } catch (error) {
      if (!(error instanceof DispatchInputError)) throw error;
      return suspend(run, 'plan_invalid');
    }

    const idsFor = (keys: string[]) => keys.map((key) => tasks.find((task) => task.key === key)!.id);
    if (decision.promote.length > 0) await store.promote(idsFor(decision.promote));

    const launched: string[] = [];
    const waiting = decision.waiting.map((entry) => entry.headKey);
    for (const unit of decision.launch) {
      const verdict = await deps.guard({ requesterUserId: run.requesterUserId, project: run.project });
      if (verdict.outcome === 'refuse') {
        track('build_dispatch.refused', { buildRunId, reason: verdict.reason });
        return suspend(run, verdict.reason);
      }
      if (verdict.outcome === 'defer') {
        track('build_dispatch.refused', { buildRunId, reason: 'lookup_error' });
        const head = tasks.find((task) => task.key === unit.headKey)!;
        await store.appendEvent({
          buildRunId,
          buildRevisionId: revisionId,
          eventType: DISPATCH_EVENT_TYPES.taskLaunchDeferred,
          message: `Task ${unit.headKey} is waiting because Apex could not check access. It will try again shortly.`,
          detail: { taskKey: unit.headKey },
          dedupeKey: `launch_deferred:${head.id}:${head.attempt}`,
        });
        return { kind: 'deferred', headKey: unit.headKey };
      }

      const members = membersOf(unit, tasks);
      const claimed = await store.claim({
        buildRunId,
        revisionId,
        headTaskId: members[0].id,
        headKey: unit.headKey,
        taskIds: members.map((task) => task.id),
        parallelismLimit: run.parallelismCap,
      });
      if (!claimed) {
        waiting.push(unit.headKey);
        continue;
      }

      const result = await deps.launch({
        run: { ...run, revisionId },
        unit,
        tasks: members,
        attempt: claimed.attempt,
        branchName: claimed.branchName,
      });
      switch (result.kind) {
        case 'launched': {
          launched.push(unit.headKey);
          await store.appendEvent({
            buildRunId,
            buildRevisionId: revisionId,
            eventType: DISPATCH_EVENT_TYPES.taskLaunched,
            message: unit.mode === 'chain'
              ? `Tasks ${unit.taskKeys.join(', ')} started in one agent.`
              : `Task ${unit.headKey} started.`,
            detail: { taskKeys: unit.taskKeys, attempt: claimed.attempt },
            correlation: { kind: 'agent_run', id: result.agentRunId },
            dedupeKey: `launched:${result.agentRunId}`,
          });
          track('build_dispatch.launched', { buildRunId }, { unitSize: unit.taskKeys.length, attempt: claimed.attempt });
          deps.onLaunched?.({
            buildRunId,
            agentRunId: result.agentRunId,
            project: run.project,
            cloudAgentId: result.cloudAgentId,
            cursorRunId: result.cursorRunId,
          });
          break;
        }
        case 'refused': {
          track('build_dispatch.refused', { buildRunId, reason: 'configuration' });
          await store.resetToReady(members.map((task) => task.id));
          return suspend(run, 'configuration');
        }
        case 'failed': {
          const failure = await deps.failTask({
            buildRunId,
            revisionId,
            headKey: unit.headKey,
            taskIds: members.map((task) => task.id),
            detail: result.detail,
            dedupeKey: `launch_failed:${members[0].id}:${claimed.attempt}`,
          });
          if (failure === 'suspended') return { kind: 'suspended', reason: 'repair_cap' };
          break;
        }
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }

    return { kind: 'dispatched', promoted: decision.promote, launched, waiting };
  };
}
