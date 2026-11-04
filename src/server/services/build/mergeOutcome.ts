/**
 * Applies the outcome of `mergeTaskBranch`: dispatches newly unblocked tasks,
 * triggers `onAllTasksMerged`, or handles merge conflicts / policy blocks (FEAT-012, TBI-022 / S4).
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  BUILD_PLAN_TASK_ROLES,
  taskBranchName,
  type BuildSupportContact,
  type BuildSuspendReason,
} from '../../../shared/types/build';
import { formatSupportContacts } from '../../../shared/buildPlanCopy';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { appendBuildEvent } from '../buildEventsService';
import type { MergeOutcome } from './buildMergeService';
import { onAllTasksMerged } from './finalCheck';
import { requestRepairAttempt } from './repairAttempts';

export type MergeSuspendReason = 'cap_reached' | 'configuration';

export interface MergeOutcomeContext {
  taskId: string;
  taskKey: string;
  attempt: number;
  revisionId: string;
  buildRunId: string;
  integrationBranch: string;
  supportContacts: BuildSupportContact[];
  allNonOmittedPlanTasksMerged: boolean;
}

export interface MergeOutcomeDeps {
  loadContext: (taskId: string) => Promise<MergeOutcomeContext | null>;
  requestRepairAttempt: (
    revisionId: string
  ) => Promise<{ granted: boolean; used: number }>;
  requeueTaskForConflict: (
    taskId: string,
    nextAttempt: number,
    branchName: string
  ) => Promise<void>;
  markTaskFailed: (taskId: string) => Promise<void>;
  suspendRun: (
    runId: string,
    reason: MergeSuspendReason,
    message: string
  ) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  dispatchNext: (buildRunId: string) => Promise<void>;
  onAllTasksMerged: (revisionId: string) => Promise<void>;
}

function formatContactNames(contacts: readonly BuildSupportContact[]): string {
  const labels = contacts.map((c) =>
    c.email ? `${c.displayName} (${c.email})` : c.displayName
  );
  return formatSupportContacts(labels);
}

export function buildCapReachedMessage(
  contacts: readonly BuildSupportContact[]
): string {
  const names = formatContactNames(contacts);
  return `Your feature was built, but Apex could not get every check to pass after 2 repair attempts. The build is paused so a developer can look at it. Contact ${names}.`;
}

export function buildBranchPolicyMessage(
  branch: string,
  contacts: readonly BuildSupportContact[]
): string {
  const names = formatContactNames(contacts);
  return `Apex could not merge part of your feature because branch ${branch} has a branch policy. Contact ${names}.`;
}

function createDefaultMergeOutcomeDeps(
  dispatchNextFn?: (buildRunId: string) => Promise<unknown>
): MergeOutcomeDeps {
  return {
    async loadContext(taskId) {
      const [row] = await db
        .select({
          task: buildTasks,
          revision: buildRevisions,
          run: buildRuns,
        })
        .from(buildTasks)
        .innerJoin(
          buildRevisions,
          eq(buildRevisions.id, buildTasks.buildRevisionId)
        )
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildTasks.id, taskId));
      if (!row) return null;

      const planTasks = await db
        .select({ status: buildTasks.status })
        .from(buildTasks)
        .where(
          and(
            eq(buildTasks.buildRevisionId, row.revision.id),
            inArray(buildTasks.role, [...BUILD_PLAN_TASK_ROLES])
          )
        );
      const nonOmitted = planTasks.filter((t) => t.status !== 'omitted');
      const allNonOmittedPlanTasksMerged =
        nonOmitted.length > 0 && nonOmitted.every((t) => t.status === 'merged');

      return {
        taskId: row.task.id,
        taskKey: row.task.taskKey,
        attempt: row.task.attempt,
        revisionId: row.revision.id,
        buildRunId: row.run.id,
        integrationBranch:
          row.run.integrationBranch ?? `apex/build/${row.run.id}`,
        supportContacts: row.run.supportContacts ?? [],
        allNonOmittedPlanTasksMerged,
      };
    },
    requestRepairAttempt: (revisionId) =>
      requestRepairAttempt(revisionId, 'merge_conflict'),
    async requeueTaskForConflict(taskId, nextAttempt, branchName) {
      const now = new Date().toISOString();
      await db
        .update(buildTasks)
        .set({
          status: 'ready',
          attempt: nextAttempt,
          branchName,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(buildTasks.id, taskId));
    },
    async markTaskFailed(taskId) {
      const now = new Date().toISOString();
      await db
        .update(buildTasks)
        .set({ status: 'failed', completedAt: now, updatedAt: now })
        .where(eq(buildTasks.id, taskId));
    },
    async suspendRun(runId, reason, message) {
      const dbReason: BuildSuspendReason =
        reason === 'cap_reached' ? 'repair_cap' : 'configuration';
      const now = new Date().toISOString();
      await db
        .update(buildRuns)
        .set({
          status: 'suspended',
          suspendReason: dbReason,
          suspendedFromStatus: 'building',
          updatedAt: now,
        })
        .where(eq(buildRuns.id, runId));
      await appendBuildEvent({
        buildRunId: runId,
        eventType: 'run.suspended',
        severity: 'warn',
        message,
        detail: { reason, dbReason },
      });
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
    async dispatchNext(buildRunId) {
      if (dispatchNextFn) {
        await dispatchNextFn(buildRunId);
        return;
      }
      const { dispatchNext: defaultDispatchNext } =
        await import('../buildOrchestrator/dispatchWiring');
      await defaultDispatchNext(buildRunId);
    },
    async onAllTasksMerged(revisionId) {
      await onAllTasksMerged(revisionId);
    },
  };
}

export async function applyMergeOutcome(
  taskId: string,
  outcome: MergeOutcome,
  deps?: MergeOutcomeDeps
): Promise<void> {
  const resolved = deps ?? createDefaultMergeOutcomeDeps();
  const context = await resolved.loadContext(taskId);
  if (!context) return;

  switch (outcome.outcome) {
    case 'merged':
    case 'already_merged': {
      await resolved.dispatchNext(context.buildRunId);
      if (context.allNonOmittedPlanTasksMerged) {
        await resolved.onAllTasksMerged(context.revisionId);
      }
      return;
    }

    case 'conflict': {
      const repair = await resolved.requestRepairAttempt(context.revisionId);
      if (repair.granted) {
        const nextAttempt = context.attempt + 1;
        const nextBranch = `${taskBranchName(context.buildRunId, context.taskKey)}-${nextAttempt}`;
        await resolved.requeueTaskForConflict(
          context.taskId,
          nextAttempt,
          nextBranch
        );
        await resolved.appendEvent({
          buildRunId: context.buildRunId,
          buildRevisionId: context.revisionId,
          eventType: 'repair.granted',
          message: `Repair attempt ${repair.used} of 2 granted for merge conflict on task ${context.taskKey}.`,
          detail: {
            reason: 'merge_conflict',
            used: repair.used,
            taskKey: context.taskKey,
            nextAttempt,
          },
        });
        await resolved.dispatchNext(context.buildRunId);
      } else {
        await resolved.markTaskFailed(context.taskId);
        const message = buildCapReachedMessage(context.supportContacts);
        await resolved.appendEvent({
          buildRunId: context.buildRunId,
          buildRevisionId: context.revisionId,
          eventType: 'repair.denied',
          severity: 'error',
          message,
          detail: {
            reason: 'merge_conflict',
            used: repair.used,
            taskKey: context.taskKey,
          },
        });
        await resolved.suspendRun(context.buildRunId, 'cap_reached', message);
      }
      return;
    }

    case 'blocked_by_policy': {
      const message = buildBranchPolicyMessage(
        outcome.branch,
        context.supportContacts
      );
      await resolved.suspendRun(context.buildRunId, 'configuration', message);
      return;
    }

    case 'source_missing': {
      await resolved.markTaskFailed(context.taskId);
      await resolved.appendEvent({
        buildRunId: context.buildRunId,
        buildRevisionId: context.revisionId,
        eventType: 'task.failed',
        severity: 'error',
        message: `Task ${context.taskKey} finished without a source branch to merge.`,
        detail: { taskKey: context.taskKey, reason: 'source_missing' },
      });
      return;
    }

    case 'pending':
    case 'skipped_run_inactive':
      return;

    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
