/**
 * Orchestrator apply-completion adapter for build task verification (PBI-022, S8).
 *
 * Connects `recordTaskEvidence` to FEAT-010's completion flow (`mayReportDone` and
 * `applyTaskVerificationCompletion`), `RepairAttemptPort`, and small-to-full escalation.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { BuildTaskStatus, BuildVerificationStatus } from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRevisions, buildTasks, buildVerificationRows } from '../../db/schema';
import type { CompletionDeps } from '../buildOrchestrator/applyCompletion';
import { createDrizzleRepairAttemptPort, type RepairAttemptPort } from './ports';
import type { Violation } from './verificationEvidenceChecker';
import {
  createDrizzleVerificationRecorderStore,
  recordTaskEvidence,
  resolveTaskOwnedSpecs,
  type RecordTaskEvidenceDeps,
} from './verificationEvidenceRecorder';

export interface TaskRelaunchEnvelope {
  taskKey: string;
  attemptNumber: number;
  violations: Violation[];
}

export type ApplyTaskVerificationResult =
  | {
      stale: true;
      outcome: 'stale';
      mayReportDone: false;
      relaunchEnvelope: null;
    }
  | {
      stale: false;
      outcome: 'done' | 'refused' | 'escalate';
      mayReportDone: boolean;
      relaunchEnvelope: TaskRelaunchEnvelope | null;
      repairAttempt?: { consumed: boolean; remaining: number };
      escalation?: { reason: string; planPath: string } | null;
    };

export interface EscalateToFullPathInput {
  buildRunId: string;
  revisionId: string;
  taskId: string;
  reason: string;
  planPath: string;
}

export interface BuildVerificationApplyDeps {
  recorderDeps?: RecordTaskEvidenceDeps;
  repairAttemptPort?: RepairAttemptPort;
  updateTaskStatus?: (taskId: string, status: BuildTaskStatus) => Promise<void>;
  escalateToFullPath?: (input: EscalateToFullPathInput) => Promise<void>;
}

async function defaultUpdateTaskStatus(taskId: string, status: BuildTaskStatus): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(buildTasks)
    .set({
      status,
      updatedAt: now,
      ...(status === 'failed' || status === 'merged' ? { completedAt: now } : {}),
    })
    .where(eq(buildTasks.id, taskId));
}

async function defaultEscalateToFullPath(input: EscalateToFullPathInput): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(buildRevisions)
    .set({
      classification: 'full',
      updatedAt: now,
    })
    .where(eq(buildRevisions.id, input.revisionId));
}

/**
 * Records an agent run's verification evidence and applies the completion outcome:
 * - `done`: marks the task done (`merged`), calls `repairAttemptPort.consume` 0 times.
 * - `refused`: marks the task `failed`, calls `repairAttemptPort.consume(revisionId)` once,
 *   and returns a relaunch envelope with violation codes and requirement IDs only (never output text).
 * - `escalate`: keeps committed red evidence rows (`fail`), calls `repairAttemptPort.consume` 0 times,
 *   and switches the revision from `'small'` to `'full'`.
 */
export async function applyTaskVerificationCompletion(
  input: {
    buildTaskId: string;
    attemptNumber: number;
    agentRunId?: string | null;
    message: string;
  },
  deps?: BuildVerificationApplyDeps,
): Promise<ApplyTaskVerificationResult> {
  const recorderStore =
    deps?.recorderDeps?.store ?? createDrizzleVerificationRecorderStore();
  const repairAttemptPort = deps?.repairAttemptPort ?? createDrizzleRepairAttemptPort();
  const updateTaskStatus = deps?.updateTaskStatus ?? defaultUpdateTaskStatus;
  const escalateToFullPath = deps?.escalateToFullPath ?? defaultEscalateToFullPath;

  const context = await recorderStore.loadContext(input.buildTaskId);
  if (!context) {
    return {
      stale: true,
      outcome: 'stale',
      mayReportDone: false,
      relaunchEnvelope: null,
    };
  }

  const recorded = await recordTaskEvidence(
    {
      buildTaskId: input.buildTaskId,
      attemptNumber: input.attemptNumber,
      message: input.message,
      agentRunId: input.agentRunId ?? null,
    },
    {
      ...deps?.recorderDeps,
      store: recorderStore,
    },
  );

  if (recorded.stale) {
    return {
      stale: true,
      outcome: 'stale',
      mayReportDone: false,
      relaunchEnvelope: null,
    };
  }

  if (recorded.outcome === 'done') {
    await updateTaskStatus(context.task.id, 'merged');
    return {
      stale: false,
      outcome: 'done',
      mayReportDone: true,
      relaunchEnvelope: null,
      escalation: null,
    };
  }

  if (recorded.outcome === 'escalate') {
    if (recorded.escalation) {
      await escalateToFullPath({
        buildRunId: context.run.id,
        revisionId: context.revision.id,
        taskId: context.task.id,
        reason: recorded.escalation.reason,
        planPath: recorded.escalation.planPath,
      });
    }
    return {
      stale: false,
      outcome: 'escalate',
      mayReportDone: false,
      relaunchEnvelope: null,
      escalation: recorded.escalation,
    };
  }

  await updateTaskStatus(context.task.id, 'failed');
  const repairAttempt = await repairAttemptPort.consume(context.revision.id);

  // Violation codes and requirement IDs only — never raw output text.
  const sanitizedViolations: Violation[] = recorded.violations.map((v) => ({
    code: v.code,
    requirementId: v.requirementId,
  }));

  return {
    stale: false,
    outcome: 'refused',
    mayReportDone: false,
    relaunchEnvelope: {
      taskKey: context.task.taskKey,
      attemptNumber: input.attemptNumber + 1,
      violations: sanitizedViolations,
    },
    repairAttempt,
    escalation: null,
  };
}

export interface CreateMayReportDoneDeps {
  loadTaskStatus?: (
    taskIds: string[],
  ) => Promise<
    Array<{
      taskId: string;
      revisionId: string;
      ownedIds: Array<{ id: string; retired: boolean }>;
      rowStatuses: Map<string, BuildVerificationStatus>;
    }>
  >;
}

async function defaultLoadTaskVerificationState(taskIds: string[]) {
  if (taskIds.length === 0) return [];
  const recorderStore = createDrizzleVerificationRecorderStore();
  const results: Array<{
    taskId: string;
    revisionId: string;
    ownedIds: Array<{ id: string; retired: boolean }>;
    rowStatuses: Map<string, BuildVerificationStatus>;
  }> = [];

  for (const taskId of taskIds) {
    const context = await recorderStore.loadContext(taskId);
    if (!context) continue;
    const { ownedIds } = resolveTaskOwnedSpecs(context);
    const activeIds = ownedIds.filter((spec) => !spec.retired).map((spec) => spec.id);
    const rowStatuses = new Map<string, BuildVerificationStatus>();

    if (activeIds.length > 0) {
      const rows = await db
        .select({
          requirementId: buildVerificationRows.requirementId,
          status: buildVerificationRows.status,
        })
        .from(buildVerificationRows)
        .where(
          and(
            eq(buildVerificationRows.buildRevisionId, context.revision.id),
            inArray(buildVerificationRows.requirementId, activeIds),
          ),
        );
      for (const row of rows) {
        rowStatuses.set(row.requirementId, row.status);
      }
    }

    results.push({
      taskId,
      revisionId: context.revision.id,
      ownedIds: ownedIds.map((spec) => ({ id: spec.id, retired: spec.retired })),
      rowStatuses,
    });
  }

  return results;
}

/**
 * Adapter for `CompletionDeps['mayReportDone']` in `dispatchWiring.ts`.
 * Returns `true` only when every non-retired requirement and risk decision owned by
 * each task in `taskIds` has a recorded verification row with status `'pass'` or `'deferred'`.
 */
export function createMayReportDone(
  deps?: CreateMayReportDoneDeps,
): CompletionDeps['mayReportDone'] {
  const loadState = deps?.loadTaskStatus ?? defaultLoadTaskVerificationState;

  return async ({ taskIds }): Promise<boolean> => {
    if (taskIds.length === 0) return false;
    const states = await loadState(taskIds);
    if (states.length !== taskIds.length) return false;

    for (const state of states) {
      const activeSpecs = state.ownedIds.filter((spec) => !spec.retired);
      if (activeSpecs.length === 0) return false;
      for (const spec of activeSpecs) {
        const status = state.rowStatuses.get(spec.id);
        if (status !== 'pass' && status !== 'deferred') {
          return false;
        }
      }
    }

    return true;
  };
}
