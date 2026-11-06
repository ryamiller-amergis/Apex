/**
 * Final check orchestration: `onAllTasksMerged`, `markValidated`, and
 * `applyFinalCheckCompletion` (FEAT-012, PBI-024, PBI-025, TBI-023 / S6).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  BUILD_PLAN_TASK_ROLES,
  type BuildRunStatus,
  type BuildSupportContact,
  type BuildSuspendReason,
  type BuildTaskRole,
  type BuildTaskRunMode,
  type BuildTaskStatus,
} from '../../../shared/types/build';
import { MAX_REPAIR_ATTEMPTS } from '../../../shared/types/buildFinalCheck';
import { formatSupportContacts } from '../../../shared/buildPlanCopy';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { AzureDevOpsService } from '../azureDevOps';
import { appendBuildEvent } from '../buildEventsService';
import { redactText } from '../buildRedactionService';
import type { CloudAgentRunObservation } from '../cursorCloudAgentClient';
import { mergeTaskBranch, type MergeOutcome } from './buildMergeService';
import {
  isCheckPassed,
  parseFinalCheckReport,
  shouldRunFinalCheck,
} from './finalCheckReport';
import { buildCapReachedMessage } from './mergeOutcome';
import { requestRepairAttempt } from './repairAttempts';

export { shouldRunFinalCheck };

export type FinalCheckSuspendReason =
  | 'cap_reached'
  | 'check_failed'
  | 'configuration';

export interface FinalCheckTaskItem {
  id: string;
  taskKey: string;
  role: BuildTaskRole;
  status: BuildTaskStatus;
  runMode: BuildTaskRunMode;
  attempt: number;
  dependsOn?: string[];
}

export interface FinalCheckState {
  runId: string;
  revisionId: string;
  runStatus: BuildRunStatus;
  suspendReason: FinalCheckSuspendReason | null;
  suspensionMessage: string | null;
  integrationBranch: string;
  integrationHeadCommit: string | null;
  validatedCommit: string | null;
  repairAttempts: number;
  supportContacts: BuildSupportContact[];
  tasks: FinalCheckTaskItem[];
}

export interface FinalCheckDeps {
  withRevisionLock: <T>(revisionId: string, fn: () => Promise<T>) => Promise<T>;
  loadRevisionState: (revisionId: string) => Promise<FinalCheckState | null>;
  loadStateByCheckTaskId: (
    checkTaskId: string
  ) => Promise<FinalCheckState | null>;
  getIntegrationBranchHead: (revisionId: string) => Promise<string | null>;
  insertFinalCheckTask: (
    revisionId: string,
    task: {
      dependsOn: string[];
      runMode: BuildTaskRunMode;
      attempt: number;
      status: BuildTaskStatus;
    }
  ) => Promise<{ inserted: boolean; taskId: string }>;
  setRunStatus: (runId: string, status: BuildRunStatus) => Promise<void>;
  markValidated: (revisionId: string, commit: string) => Promise<void>;
  compareAndSetCheckTask: (
    checkTaskId: string,
    expectedAttempt: number,
    nextStatus: BuildTaskStatus,
    nextAttempt?: number
  ) => Promise<boolean>;
  requestRepairAttempt: (
    revisionId: string
  ) => Promise<{ granted: boolean; used: number }>;
  mergeCheckBranch: (checkTaskId: string) => Promise<MergeOutcome>;
  suspendRun: (
    runId: string,
    reason: FinalCheckSuspendReason,
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
  writeEvidenceBlob: (
    revisionId: string,
    redactedReportJson: string
  ) => Promise<void>;
  dispatchNext: (runId: string) => Promise<void>;
}

function formatContactNames(contacts: readonly BuildSupportContact[]): string {
  const labels = contacts.map((c) =>
    c.email ? `${c.displayName} (${c.email})` : c.displayName
  );
  return formatSupportContacts(labels);
}

export function buildCheckFailedMessage(
  contacts: readonly BuildSupportContact[]
): string {
  const names = formatContactNames(contacts);
  return `Your feature was built, but its final check did not pass and Apex could not repair it. The build is paused so a developer can look at it. Contact ${names}.`;
}

export function buildUnreadableInputMessage(
  filePath: string,
  contacts: readonly BuildSupportContact[]
): string {
  const names = formatContactNames(contacts);
  return `Apex could not read ${filePath}, which it needs to review your feature against the project's standards. Contact ${names} to restore it, then resume the build.`;
}

function createDefaultFinalCheckDeps(): FinalCheckDeps {
  const loadByRevisionId = async (
    revisionId: string
  ): Promise<FinalCheckState | null> => {
    const [row] = await db
      .select({ revision: buildRevisions, run: buildRuns })
      .from(buildRevisions)
      .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
      .where(eq(buildRevisions.id, revisionId));
    if (!row) return null;

    const taskRows = await db
      .select()
      .from(buildTasks)
      .where(eq(buildTasks.buildRevisionId, revisionId));

    return {
      runId: row.run.id,
      revisionId: row.revision.id,
      runStatus: row.run.status,
      suspendReason: null,
      suspensionMessage: null,
      integrationBranch:
        row.run.integrationBranch ?? `apex/build/${row.run.id}`,
      integrationHeadCommit:
        row.revision.validatedCommit ?? row.run.baseCommit ?? null,
      validatedCommit: row.revision.validatedCommit ?? null,
      repairAttempts: row.revision.repairAttempts,
      supportContacts: row.run.supportContacts ?? [],
      tasks: taskRows.map((t) => ({
        id: t.id,
        taskKey: t.taskKey,
        role: t.role,
        status: t.status,
        runMode: t.runMode,
        attempt: t.attempt,
        dependsOn: t.dependsOn,
      })),
    };
  };

  return {
    async withRevisionLock(revisionId, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`build-merge:${revisionId}`}))`
        );
        return fn();
      });
    },
    loadRevisionState: loadByRevisionId,
    async loadStateByCheckTaskId(checkTaskId) {
      const [task] = await db
        .select({ revisionId: buildTasks.buildRevisionId })
        .from(buildTasks)
        .where(eq(buildTasks.id, checkTaskId));
      if (!task) return null;
      return loadByRevisionId(task.revisionId);
    },
    async getIntegrationBranchHead(revisionId) {
      const [row] = await db
        .select({ run: buildRuns })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildRevisions.id, revisionId));
      if (!row?.run.integrationBranch) return null;
      const svc = new AzureDevOpsService(row.run.project);
      return svc.getBranchHeadCommit(
        row.run.repository,
        row.run.project,
        row.run.integrationBranch
      );
    },
    async insertFinalCheckTask(revisionId, task) {
      const rows = await db
        .insert(buildTasks)
        .values({
          buildRevisionId: revisionId,
          taskKey: 'final-check',
          role: 'check',
          dependsOn: task.dependsOn,
          ownedFiles: [],
          covers: [],
          reuse: [],
          runMode: task.runMode,
          status: task.status,
          attempt: task.attempt,
        })
        .onConflictDoNothing({
          target: [buildTasks.buildRevisionId, buildTasks.taskKey],
        })
        .returning({ id: buildTasks.id });
      if (rows.length === 0) {
        const [existing] = await db
          .select({ id: buildTasks.id })
          .from(buildTasks)
          .where(
            and(
              eq(buildTasks.buildRevisionId, revisionId),
              eq(buildTasks.taskKey, 'final-check')
            )
          );
        return { inserted: false, taskId: existing?.id ?? '' };
      }
      return { inserted: true, taskId: rows[0].id };
    },
    async setRunStatus(runId, status) {
      await db
        .update(buildRuns)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(eq(buildRuns.id, runId));
    },
    async markValidated(revisionId, commit) {
      await markValidated(revisionId, commit);
    },
    async compareAndSetCheckTask(
      checkTaskId,
      expectedAttempt,
      nextStatus,
      nextAttempt
    ) {
      const now = new Date().toISOString();
      const rows = await db
        .update(buildTasks)
        .set({
          status: nextStatus,
          ...(nextAttempt !== undefined ? { attempt: nextAttempt } : {}),
          ...(nextStatus === 'merged' || nextStatus === 'failed'
            ? { completedAt: now }
            : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(buildTasks.id, checkTaskId),
            eq(buildTasks.status, 'running'),
            eq(buildTasks.attempt, expectedAttempt)
          )
        )
        .returning({ id: buildTasks.id });
      return rows.length > 0;
    },
    requestRepairAttempt: (revisionId) =>
      requestRepairAttempt(revisionId, 'final_check_fix'),
    mergeCheckBranch: (checkTaskId) => mergeTaskBranch(checkTaskId),
    async suspendRun(runId, reason, message) {
      const dbReason: BuildSuspendReason =
        reason === 'configuration' ? 'configuration' : 'repair_cap';
      await db
        .update(buildRuns)
        .set({
          status: 'suspended',
          suspendReason: dbReason,
          suspendedFromStatus: 'checking',
          updatedAt: new Date().toISOString(),
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
    async writeEvidenceBlob() {
      // Evidence blob storage hook (populated when Blob container writer is wired)
    },
    async dispatchNext(runId) {
      const { launchFinalCheckForRun } =
        await import('../buildOrchestrator/planning');
      await launchFinalCheckForRun(runId);
    },
  };
}

export async function autoOpenPullRequestForPoc(
  buildRunId: string
): Promise<void> {
  try {
    const { defaultBuildAcceptService } = await import('./buildAcceptService');
    await defaultBuildAcceptService.continueAccept(buildRunId);
  } catch (error) {
    console.warn(
      '[final-check] auto-PR creation skipped or deferred:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function markValidated(
  revisionId: string,
  commit: string
): Promise<void> {
  let targetBuildRunId: string | null = null;
  await db.transaction(async (tx) => {
    const [rev] = await tx
      .select({
        validatedCommit: buildRevisions.validatedCommit,
        buildRunId: buildRevisions.buildRunId,
        revisionNumber: buildRevisions.revisionNumber,
      })
      .from(buildRevisions)
      .where(eq(buildRevisions.id, revisionId));
    if (!rev) return;

    if (rev.validatedCommit !== null) {
      if (rev.validatedCommit !== commit) {
        throw new Error(
          `Revision ${revisionId} already has validatedCommit ${rev.validatedCommit}`
        );
      }
    } else {
      const now = new Date().toISOString();
      await tx
        .update(buildRevisions)
        .set({
          validatedCommit: commit,
          updatedAt: now,
        })
        .where(
          and(
            eq(buildRevisions.id, revisionId),
            isNull(buildRevisions.validatedCommit)
          )
        );
    }

    targetBuildRunId = rev.buildRunId;
    const now = new Date().toISOString();
    // Checks passed. Stay on `checking` until the pull request URL and end
    // time are stored together. `accepted` is rejected without both.
    await tx
      .update(buildRuns)
      .set({
        status: 'checking',
        acceptedRevisionNumber: rev.revisionNumber,
        updatedAt: now,
      })
      .where(
        and(
          eq(buildRuns.id, rev.buildRunId),
          inArray(buildRuns.status, [
            'building',
            'checking',
            'deploying',
            'preview_ready',
          ])
        )
      );
  });

  if (targetBuildRunId && process.env.NODE_ENV !== 'test') {
    void autoOpenPullRequestForPoc(targetBuildRunId);
    const { defaultBuildDeploymentService } = await import('../buildDeploymentService');
    void defaultBuildDeploymentService.enqueueRevisionDeployment(targetBuildRunId);
  }
}

export async function onAllTasksMerged(
  revisionId: string,
  deps?: FinalCheckDeps
): Promise<void> {
  const resolved = deps ?? createDefaultFinalCheckDeps();

  await resolved.withRevisionLock(revisionId, async () => {
    const state = await resolved.loadRevisionState(revisionId);
    if (!state) return;

    if (state.tasks.some((t) => t.taskKey === 'final-check')) {
      return;
    }

    if (!shouldRunFinalCheck(state.tasks)) {
      const head = await resolved.getIntegrationBranchHead(revisionId);
      if (!head) return;
      await resolved.markValidated(revisionId, head);
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: revisionId,
        eventType: 'run.validated',
        message:
          'Single-agent build validated without a separate final-check agent.',
        detail: { commit: head, skipped_single_agent: true },
      });
      return;
    }

    const implementerKeys = state.tasks
      .filter(
        (t) =>
          t.status !== 'omitted' &&
          (BUILD_PLAN_TASK_ROLES as readonly string[]).includes(t.role)
      )
      .map((t) => t.taskKey);

    const { inserted } = await resolved.insertFinalCheckTask(revisionId, {
      dependsOn: implementerKeys,
      runMode: 'own_agent',
      attempt: 1,
      status: 'ready',
    });
    if (!inserted) return;

    await resolved.setRunStatus(state.runId, 'checking');
    await resolved.appendEvent({
      buildRunId: state.runId,
      buildRevisionId: revisionId,
      eventType: 'check.started',
      message: 'Started final check on the combined integration branch.',
      detail: { dependsOn: implementerKeys },
    });
    await resolved.dispatchNext(state.runId);
  });
}

export async function applyFinalCheckCompletion(
  checkTaskId: string,
  observation: Pick<
    CloudAgentRunObservation,
    'settled' | 'status' | 'resultText'
  >,
  deps?: FinalCheckDeps
): Promise<void> {
  const resolved = deps ?? createDefaultFinalCheckDeps();
  const state = await resolved.loadStateByCheckTaskId(checkTaskId);
  if (!state) return;

  const checkTask = state.tasks.find((t) => t.id === checkTaskId);
  if (!checkTask || checkTask.status !== 'running') {
    return;
  }

  const currentAttempt = checkTask.attempt;

  const handleFailedWithoutRepair = async (
    invalidReportReason?: string
  ): Promise<void> => {
    const won = await resolved.compareAndSetCheckTask(
      checkTaskId,
      currentAttempt,
      'failed'
    );
    if (!won) return;

    if (invalidReportReason) {
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'check.report_invalid',
        severity: 'error',
        message: `Final check returned an invalid report (${invalidReportReason}).`,
        detail: { reason: invalidReportReason, attempt: currentAttempt },
      });
    } else {
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'check.failed',
        severity: 'error',
        message: 'Final check did not pass and no repair was made.',
        detail: { attempt: currentAttempt },
      });
    }

    if (state.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      const msg = buildCapReachedMessage(state.supportContacts);
      await resolved.suspendRun(state.runId, 'cap_reached', msg);
    } else {
      const msg = buildCheckFailedMessage(state.supportContacts);
      await resolved.suspendRun(state.runId, 'check_failed', msg);
    }
  };

  // 1. Agent did not finish or report is invalid or commit mismatched
  if (observation.status !== 'finished') {
    await handleFailedWithoutRepair();
    return;
  }

  const parsed = parseFinalCheckReport(observation.resultText);
  if (!parsed.ok) {
    await handleFailedWithoutRepair(parsed.reason);
    return;
  }

  const { report } = parsed;
  const currentHead = await resolved.getIntegrationBranchHead(state.revisionId);
  if (!currentHead || report.validatedCommit !== currentHead) {
    await handleFailedWithoutRepair('commit_mismatch');
    return;
  }

  // Write redacted report to Blob evidence
  await resolved.writeEvidenceBlob(
    state.revisionId,
    redactText(JSON.stringify(report))
  );

  // 2. Standards input unreadable wins over check results
  if (report.standards.status === 'unreadable_input') {
    const won = await resolved.compareAndSetCheckTask(
      checkTaskId,
      currentAttempt,
      'failed'
    );
    if (!won) return;

    const unreadablePath = report.standards.path;
    const message = buildUnreadableInputMessage(
      unreadablePath,
      state.supportContacts
    );
    await resolved.appendEvent({
      buildRunId: state.runId,
      buildRevisionId: state.revisionId,
      eventType: 'standards.unreadable_input',
      severity: 'error',
      message,
      detail: { path: unreadablePath },
    });
    await resolved.suspendRun(state.runId, 'configuration', message);
    return;
  }

  // Record standards findings
  const recordStandardsFindings = async (): Promise<void> => {
    if (report.standards.status !== 'reviewed') return;
    for (const finding of report.standards.findings) {
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'standards.finding',
        message: `Standards finding (${finding.rule}) in ${finding.file}: ${finding.resolution}.`,
        detail: {
          rule: finding.rule,
          file: finding.file,
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          resolution: finding.resolution,
          ...(finding.exceptionReason
            ? { exceptionReason: finding.exceptionReason }
            : {}),
        },
      });
    }
  };

  // 3. Checks passed
  if (isCheckPassed(report)) {
    if (!report.repairedInSession) {
      const won = await resolved.compareAndSetCheckTask(
        checkTaskId,
        currentAttempt,
        'merged'
      );
      if (!won) return;

      await recordStandardsFindings();
      await resolved.markValidated(state.revisionId, currentHead);
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'check.passed',
        message: redactText(report.summary),
        detail: { validatedCommit: currentHead, repairedInSession: false },
      });
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'run.validated',
        message: `Validated commit ${currentHead} ready for deployment.`,
        detail: { commit: currentHead, skipped_single_agent: false },
      });
      return;
    }

    // Repaired in session and passed: check budget first
    if (state.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      const won = await resolved.compareAndSetCheckTask(
        checkTaskId,
        currentAttempt,
        'failed'
      );
      if (!won) return;
      const msg = buildCapReachedMessage(state.supportContacts);
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'repair.denied',
        severity: 'error',
        message: msg,
        detail: { reason: 'final_check_fix', used: state.repairAttempts },
      });
      await resolved.suspendRun(state.runId, 'cap_reached', msg);
      return;
    }

    const won = await resolved.compareAndSetCheckTask(
      checkTaskId,
      currentAttempt,
      'merged'
    );
    if (!won) return;

    const mergedOutcome = await resolved.mergeCheckBranch(checkTaskId);
    if (mergedOutcome.outcome !== 'merged') {
      const msg = buildCheckFailedMessage(state.supportContacts);
      await resolved.suspendRun(state.runId, 'check_failed', msg);
      return;
    }

    const repair = await resolved.requestRepairAttempt(state.revisionId);
    if (!repair.granted) {
      const msg = buildCapReachedMessage(state.supportContacts);
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'repair.denied',
        severity: 'error',
        message: msg,
        detail: { reason: 'final_check_fix', used: repair.used },
      });
      await resolved.suspendRun(state.runId, 'cap_reached', msg);
      return;
    }

    await recordStandardsFindings();
    await resolved.appendEvent({
      buildRunId: state.runId,
      buildRevisionId: state.revisionId,
      eventType: 'repair.granted',
      message: `Repair attempt ${repair.used} of 2 used for final check fix.`,
      detail: { reason: 'final_check_fix', used: repair.used },
    });
    await resolved.markValidated(state.revisionId, mergedOutcome.mergeCommit);
    await resolved.appendEvent({
      buildRunId: state.runId,
      buildRevisionId: state.revisionId,
      eventType: 'check.passed',
      message: redactText(report.summary),
      detail: {
        validatedCommit: mergedOutcome.mergeCommit,
        repairedInSession: true,
      },
    });
    await resolved.appendEvent({
      buildRunId: state.runId,
      buildRevisionId: state.revisionId,
      eventType: 'run.validated',
      message: `Validated commit ${mergedOutcome.mergeCommit} ready for deployment.`,
      detail: {
        commit: mergedOutcome.mergeCommit,
        skipped_single_agent: false,
      },
    });
    return;
  }

  // 4. Checks failed
  if (report.repairedInSession) {
    const repair = await resolved.requestRepairAttempt(state.revisionId);
    if (repair.granted && repair.used < MAX_REPAIR_ATTEMPTS) {
      const nextAttempt = currentAttempt + 1;
      const won = await resolved.compareAndSetCheckTask(
        checkTaskId,
        currentAttempt,
        'ready',
        nextAttempt
      );
      if (!won) return;

      await recordStandardsFindings();
      await resolved.appendEvent({
        buildRunId: state.runId,
        buildRevisionId: state.revisionId,
        eventType: 'repair.granted',
        message: `Repair attempt ${repair.used} of 2 used; relaunching final check (attempt ${nextAttempt}).`,
        detail: { reason: 'final_check_fix', used: repair.used, nextAttempt },
      });
      await resolved.dispatchNext(state.runId);
      return;
    }

    const won = await resolved.compareAndSetCheckTask(
      checkTaskId,
      currentAttempt,
      'failed'
    );
    if (!won) return;

    await recordStandardsFindings();
    const msg = buildCapReachedMessage(state.supportContacts);
    await resolved.appendEvent({
      buildRunId: state.runId,
      buildRevisionId: state.revisionId,
      eventType: repair.granted ? 'check.failed' : 'repair.denied',
      severity: 'error',
      message: msg,
      detail: {
        reason: 'final_check_fix',
        used: repair.used,
        summary: redactText(report.summary),
      },
    });
    await resolved.suspendRun(state.runId, 'cap_reached', msg);
    return;
  }

  // Checks failed, not repaired in session
  await recordStandardsFindings();
  await handleFailedWithoutRepair();
}
