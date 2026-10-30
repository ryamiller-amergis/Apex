/**
 * Database reads and writes for the dispatcher, the completion handler, and the sweep.
 * Every status change is a conditional update, so two callers cannot both win.
 */
import { and, countDistinct, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  BUILD_PLAN_TASK_ROLES,
  taskBranchName,
  type BuildRunStatus,
  type BuildSuspendReason,
  type BuildTaskRole,
  type BuildTaskStatus,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { agentRuns, appUsers, buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { appendBuildEvent, type AppendBuildEventInput } from '../buildEventsService';
import { DISPATCH_EVENT_TYPES, suspensionMessage } from './dispatchEvents';

/** Revision-level cap enforced by `build_revisions_repair_attempts_check`. */
export const BUILD_REPAIR_ATTEMPT_CAP = 2;

/** Stages in which build agents run. Only these are suspended here and swept for the flag. */
export const AGENT_STAGE_STATUSES = ['planning', 'building', 'checking'] as const satisfies readonly BuildRunStatus[];

const SWEEP_LOCK_KEY = 'apex_build_reconciliation';

export interface DispatchRunRow {
  id: string;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  project: string;
  requesterUserId: string;
  parallelismCap: number;
  revisionId: string | null;
}

export interface DispatchTaskRow {
  id: string;
  key: string;
  role: BuildTaskRole;
  status: BuildTaskStatus;
  attempt: number;
  blockers: string[];
  chainHeadKey: string | null;
  branchName: string | null;
}

export interface BuildAgentRunRow {
  id: string;
  status: string;
  buildTaskId: string;
  projectId: string | null;
  cloudAgentIdentity: string | null;
  dispatchMessageId: string | null;
}

/** False while the launch has not recorded its Cursor IDs, so there is nothing to observe yet. */
export function canObserveAgentRun(agentRun: BuildAgentRunRow): agentRun is BuildAgentRunRow & {
  projectId: string;
  cloudAgentIdentity: string;
  dispatchMessageId: string;
} {
  return Boolean(agentRun.projectId && agentRun.cloudAgentIdentity && agentRun.dispatchMessageId);
}

export interface RunningHead {
  buildRunId: string;
  revisionId: string;
  taskId: string;
  key: string;
  attempt: number;
}

export interface ClaimRequest {
  buildRunId: string;
  revisionId: string;
  headTaskId: string;
  headKey: string;
  taskIds: string[];
  parallelismLimit: number;
}

export interface ClaimedUnit {
  attempt: number;
  branchName: string;
}

export type RepairAttemptResult = 'attempt_left' | 'none_left';

export interface DispatchStore {
  loadRun(buildRunId: string): Promise<DispatchRunRow | null>;
  /** Implementer and QA tasks of one revision. The orchestrator's own tasks are excluded. */
  loadPlanTasks(revisionId: string): Promise<DispatchTaskRow[]>;
  /** Every task of one revision, the planner and check tasks included. */
  loadRevisionTasks(revisionId: string): Promise<DispatchTaskRow[]>;
  loadTaskContext(taskId: string): Promise<{ task: DispatchTaskRow; buildRunId: string; revisionId: string } | null>;
  loadAgentRun(agentRunId: string): Promise<BuildAgentRunRow | null>;
  latestAgentRunForTask(taskId: string): Promise<BuildAgentRunRow | null>;
  /** Latest agent run started since the task's current claim. Runs from earlier attempts are not returned. */
  currentAgentRunForTask(taskId: string): Promise<BuildAgentRunRow | null>;
  /** `pending` to `ready`. */
  promote(taskIds: string[]): Promise<void>;
  /** Locks the run, rechecks free slots, and moves every member from `ready` to `running`. */
  claim(request: ClaimRequest): Promise<ClaimedUnit | null>;
  /** `running` to `ready`. Returns the number of rows moved. */
  resetToReady(taskIds: string[]): Promise<number>;
  /** `running` to `failed`. Returns the number of rows moved. */
  markFailed(taskIds: string[]): Promise<number>;
  /** `failed` to `ready`. */
  requeue(taskIds: string[]): Promise<number>;
  consumeRepairAttempt(revisionId: string): Promise<RepairAttemptResult>;
  /**
   * Suspends an active run and writes its timeline event. False when the run was not active.
   * Takes the run lock, so it must not be called from inside `withRunLock`.
   */
  suspend(buildRunId: string, reason: BuildSuspendReason): Promise<boolean>;
  appendEvent(input: AppendBuildEventInput): Promise<boolean>;
  listRuns(statuses: readonly BuildRunStatus[]): Promise<DispatchRunRow[]>;
  listRunsSuspendedFor(reason: BuildSuspendReason): Promise<DispatchRunRow[]>;
  /** Current agent run of every running plan task that heads its unit. */
  listRunningHeadAgentRunIds(): Promise<string[]>;
  /** Running plan heads of building runs whose claim is older than `olderThanMs`. */
  listRunningHeadsClaimedBefore(olderThanMs: number): Promise<RunningHead[]>;
  /** Runs `fn` while holding the run lock that `claim` and `suspend` also take. */
  withRunLock<T>(buildRunId: string, fn: () => Promise<T>): Promise<T>;
  /** Runs `fn` while holding the sweep lock. Null when another instance holds it. */
  withSweepLock<T>(fn: () => Promise<T>): Promise<T | null>;
  loadUserEmail(userId: string): Promise<string | null>;
}

const PLAN_ROLES = [...BUILD_PLAN_TASK_ROLES];

function toTaskRow(row: typeof buildTasks.$inferSelect): DispatchTaskRow {
  return {
    id: row.id,
    key: row.taskKey,
    role: row.role,
    status: row.status,
    attempt: row.attempt,
    blockers: row.dependsOn,
    chainHeadKey: row.chainHeadKey ?? null,
    branchName: row.branchName ?? null,
  };
}

function toAgentRunRow(row: Pick<typeof agentRuns.$inferSelect,
  'id' | 'status' | 'buildTaskId' | 'projectId' | 'cloudAgentIdentity' | 'dispatchMessageId'>): BuildAgentRunRow | null {
  if (!row.buildTaskId) return null;
  return {
    id: row.id,
    status: row.status,
    buildTaskId: row.buildTaskId,
    projectId: row.projectId ?? null,
    cloudAgentIdentity: row.cloudAgentIdentity ?? null,
    dispatchMessageId: row.dispatchMessageId ?? null,
  };
}

const agentRunColumns = {
  id: agentRuns.id,
  status: agentRuns.status,
  buildTaskId: agentRuns.buildTaskId,
  projectId: agentRuns.projectId,
  cloudAgentIdentity: agentRuns.cloudAgentIdentity,
  dispatchMessageId: agentRuns.dispatchMessageId,
};

async function loadRunRows(where: SQL | undefined): Promise<DispatchRunRow[]> {
  const rows = await db
    .select({
      id: buildRuns.id,
      status: buildRuns.status,
      suspendReason: buildRuns.suspendReason,
      project: buildRuns.project,
      requesterUserId: buildRuns.requestedByUserId,
      parallelismCap: buildRuns.parallelismCap,
      revisionId: buildRevisions.id,
    })
    .from(buildRuns)
    .leftJoin(buildRevisions, and(
      eq(buildRevisions.buildRunId, buildRuns.id),
      eq(buildRevisions.revisionNumber, buildRuns.currentRevisionNumber),
    ))
    .where(where);
  return rows.map((row) => ({ ...row, suspendReason: row.suspendReason ?? null, revisionId: row.revisionId ?? null }));
}

function runLock(buildRunId: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`apex_build_dispatch:${buildRunId}`}))`;
}

const isUnitHead = sql`(${buildTasks.chainHeadKey} IS NULL OR ${buildTasks.chainHeadKey} = ${buildTasks.taskKey})`;

class ClaimLostError extends Error {}

export function createDrizzleDispatchStore(): DispatchStore {
  const moveTasks = async (taskIds: string[], from: BuildTaskStatus, to: BuildTaskStatus): Promise<number> => {
    if (taskIds.length === 0) return 0;
    const now = new Date().toISOString();
    const rows = await db.update(buildTasks)
      .set({ status: to, updatedAt: now, ...(to === 'failed' ? { completedAt: now } : {}) })
      .where(and(inArray(buildTasks.id, taskIds), eq(buildTasks.status, from)))
      .returning({ id: buildTasks.id });
    return rows.length;
  };

  const latestAgentRunForTask = async (taskId: string): Promise<BuildAgentRunRow | null> => {
    const [row] = await db.select(agentRunColumns).from(agentRuns)
      .where(eq(agentRuns.buildTaskId, taskId))
      .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
      .limit(1);
    return row ? toAgentRunRow(row) : null;
  };

  const currentAgentRunForTask = async (taskId: string): Promise<BuildAgentRunRow | null> => {
    const [row] = await db.select(agentRunColumns).from(agentRuns)
      .innerJoin(buildTasks, eq(buildTasks.id, agentRuns.buildTaskId))
      .where(and(eq(agentRuns.buildTaskId, taskId), sql`${agentRuns.startedAt} >= ${buildTasks.startedAt}`))
      .orderBy(desc(agentRuns.startedAt), desc(agentRuns.id))
      .limit(1);
    return row ? toAgentRunRow(row) : null;
  };

  return {
    async loadRun(buildRunId) {
      const [row] = await loadRunRows(eq(buildRuns.id, buildRunId));
      return row ?? null;
    },

    async loadPlanTasks(revisionId) {
      const rows = await db.select().from(buildTasks)
        .where(and(eq(buildTasks.buildRevisionId, revisionId), inArray(buildTasks.role, PLAN_ROLES)));
      return rows.map(toTaskRow);
    },

    async loadRevisionTasks(revisionId) {
      const rows = await db.select().from(buildTasks).where(eq(buildTasks.buildRevisionId, revisionId));
      return rows.map(toTaskRow);
    },

    async loadTaskContext(taskId) {
      const [row] = await db
        .select({ task: buildTasks, buildRunId: buildRevisions.buildRunId })
        .from(buildTasks)
        .innerJoin(buildRevisions, eq(buildRevisions.id, buildTasks.buildRevisionId))
        .where(eq(buildTasks.id, taskId));
      if (!row) return null;
      return { task: toTaskRow(row.task), buildRunId: row.buildRunId, revisionId: row.task.buildRevisionId };
    },

    async loadAgentRun(agentRunId) {
      const [row] = await db.select(agentRunColumns).from(agentRuns).where(eq(agentRuns.id, agentRunId));
      return row ? toAgentRunRow(row) : null;
    },

    latestAgentRunForTask,
    currentAgentRunForTask,

    async promote(taskIds) {
      await moveTasks(taskIds, 'pending', 'ready');
    },

    async claim(request) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(runLock(request.buildRunId));
          const [counted] = await tx
            .select({ running: countDistinct(sql`coalesce(${buildTasks.chainHeadKey}, ${buildTasks.taskKey})`) })
            .from(buildTasks)
            .where(and(
              eq(buildTasks.buildRevisionId, request.revisionId),
              eq(buildTasks.status, 'running'),
              inArray(buildTasks.role, PLAN_ROLES),
            ));
          const running = Number(counted?.running ?? 0);
          if (running >= request.parallelismLimit) return null;

          const [head] = await tx.select({ attempt: buildTasks.attempt, startedAt: buildTasks.startedAt })
            .from(buildTasks).where(eq(buildTasks.id, request.headTaskId));
          if (!head) return null;
          const attempt = head.startedAt ? head.attempt + 1 : head.attempt;
          const branchName = `${taskBranchName(request.buildRunId, request.headKey)}-${attempt}`;
          const now = new Date().toISOString();

          // Database clock, so it compares cleanly with agent_runs.started_at in currentAgentRunForTask.
          const claimed = await tx.update(buildTasks)
            .set({ status: 'running', attempt, startedAt: sql`now()`, completedAt: null, updatedAt: now })
            .where(and(inArray(buildTasks.id, request.taskIds), eq(buildTasks.status, 'ready')))
            .returning({ id: buildTasks.id });
          if (claimed.length !== request.taskIds.length) throw new ClaimLostError();

          await tx.update(buildTasks).set({ branchName }).where(eq(buildTasks.id, request.headTaskId));
          await tx.update(buildRuns)
            .set({ parallelismUsed: sql`GREATEST(${buildRuns.parallelismUsed}, ${running + 1})`, updatedAt: now })
            .where(eq(buildRuns.id, request.buildRunId));
          return { attempt, branchName };
        });
      } catch (error) {
        if (error instanceof ClaimLostError) return null;
        throw error;
      }
    },

    resetToReady: (taskIds) => moveTasks(taskIds, 'running', 'ready'),
    markFailed: (taskIds) => moveTasks(taskIds, 'running', 'failed'),
    requeue: (taskIds) => moveTasks(taskIds, 'failed', 'ready'),

    async consumeRepairAttempt(revisionId) {
      const rows = await db.update(buildRevisions)
        .set({ repairAttempts: sql`${buildRevisions.repairAttempts} + 1`, updatedAt: new Date().toISOString() })
        .where(and(
          eq(buildRevisions.id, revisionId),
          sql`${buildRevisions.repairAttempts} < ${BUILD_REPAIR_ATTEMPT_CAP}`,
        ))
        .returning({ id: buildRevisions.id });
      return rows.length > 0 ? 'attempt_left' : 'none_left';
    },

    async suspend(buildRunId, reason) {
      return db.transaction(async (tx) => {
        await tx.execute(runLock(buildRunId));
        const rows = await tx.update(buildRuns)
          .set({
            status: 'suspended',
            suspendReason: reason,
            suspendedFromStatus: sql`${buildRuns.status}`,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(buildRuns.id, buildRunId), inArray(buildRuns.status, [...AGENT_STAGE_STATUSES])))
          .returning({ id: buildRuns.id });
        if (rows.length === 0) return false;
        await appendBuildEvent({
          buildRunId,
          eventType: DISPATCH_EVENT_TYPES.runSuspended,
          severity: 'warn',
          message: suspensionMessage(reason),
          detail: { reason },
        }, { executor: tx });
        return true;
      });
    },

    async appendEvent(input) {
      const { inserted } = await appendBuildEvent(input);
      return inserted;
    },

    listRuns: (statuses) => loadRunRows(inArray(buildRuns.status, [...statuses])),

    listRunsSuspendedFor: (reason) => loadRunRows(and(
      eq(buildRuns.status, 'suspended'),
      eq(buildRuns.suspendReason, reason),
    )),

    async listRunningHeadAgentRunIds() {
      const heads = await db.select({ id: buildTasks.id }).from(buildTasks)
        .where(and(
          eq(buildTasks.status, 'running'),
          inArray(buildTasks.role, PLAN_ROLES),
          isUnitHead,
        ));
      const ids: string[] = [];
      for (const head of heads) {
        const current = await currentAgentRunForTask(head.id);
        if (current) ids.push(current.id);
      }
      return ids;
    },

    async listRunningHeadsClaimedBefore(olderThanMs) {
      return db
        .select({
          buildRunId: buildRuns.id,
          revisionId: buildTasks.buildRevisionId,
          taskId: buildTasks.id,
          key: buildTasks.taskKey,
          attempt: buildTasks.attempt,
        })
        .from(buildTasks)
        .innerJoin(buildRevisions, eq(buildRevisions.id, buildTasks.buildRevisionId))
        .innerJoin(buildRuns, and(
          eq(buildRuns.id, buildRevisions.buildRunId),
          eq(buildRuns.currentRevisionNumber, buildRevisions.revisionNumber),
        ))
        .where(and(
          eq(buildRuns.status, 'building'),
          eq(buildTasks.status, 'running'),
          inArray(buildTasks.role, PLAN_ROLES),
          isUnitHead,
          sql`${buildTasks.startedAt} < now() - ${`${olderThanMs} milliseconds`}::interval`,
        ));
    },

    async withRunLock(buildRunId, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(runLock(buildRunId));
        return fn();
      });
    },

    async withSweepLock(fn) {
      return db.transaction(async (tx) => {
        const result = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${SWEEP_LOCK_KEY})) AS locked`,
        );
        if (!result.rows[0]?.locked) return null;
        return fn();
      });
    },

    async loadUserEmail(userId) {
      const [row] = await db.select({ email: appUsers.email }).from(appUsers).where(eq(appUsers.oid, userId));
      return row?.email ?? null;
    },
  };
}
