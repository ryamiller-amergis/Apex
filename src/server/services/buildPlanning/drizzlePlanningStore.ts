/**
 * Drizzle adapter for the planning store. Behavior tests use an in-memory store.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PlanViolation } from '../../../shared/buildPlanSchema';
import { db } from '../../db/drizzle';
import { agentRuns, buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { appendBuildEvent } from '../buildEventsService';
import { guardMatches, type PlanningStore, type PlanningView, type PlanningWrite, type StoredPlanTask } from './planningModel';

type Database = typeof db;
type Executor = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createDrizzlePlanningStore(database: Database = db): PlanningStore {
  return {
    load: (buildRunId, revisionNumber) => loadPlanning(database, buildRunId, revisionNumber),
    apply: (buildRunId, write) => database.transaction(async (tx) => {
      await lockRun(tx, buildRunId);
      const current = await loadPlanning(tx, buildRunId);
      if (!current) throw new Error(`Build ${buildRunId} was not found.`);
      await persist(tx, current, write);
      const next = await loadPlanning(tx, buildRunId);
      if (!next) throw new Error(`Build ${buildRunId} was not found.`);
      return next;
    }),
    applyIf: (buildRunId, guard, write) => database.transaction(async (tx) => {
      await lockRun(tx, buildRunId);
      const current = await loadPlanning(tx, buildRunId);
      if (!current || !guardMatches(current, guard)) return null;
      await persist(tx, current, write);
      return loadPlanning(tx, buildRunId);
    }),
    claimAndApply: (buildRunId, agentRunId, write) => database.transaction(async (tx) => {
      await lockRun(tx, buildRunId);
      const current = await loadPlanning(tx, buildRunId);
      if (
        current?.status !== 'planning'
        || !current.planner
        || current.planner.status !== 'running'
        || current.planner.agentRunId !== agentRunId
      ) {
        return null;
      }
      const claimed = await tx.update(buildTasks).set({
        status: 'failed',
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(buildTasks.id, current.planner.id),
        eq(buildTasks.status, 'running'),
      )).returning({ id: buildTasks.id });
      if (claimed.length === 0) return null;
      await persist(tx, { ...current, planner: { ...current.planner, status: 'failed' } }, write);
      return loadPlanning(tx, buildRunId);
    }),
  };
}

/**
 * Holds the run row until the transaction ends, so a cancel or suspend that
 * writes the run waits for this write and is never overwritten by it.
 */
async function lockRun(tx: Executor, buildRunId: string): Promise<void> {
  await tx.select({ id: buildRuns.id }).from(buildRuns).where(eq(buildRuns.id, buildRunId)).for('update');
}

async function loadPlanning(
  database: Executor | Database,
  buildRunId: string,
  revisionNumber?: number,
): Promise<PlanningView | null> {
  const [run] = await database.select().from(buildRuns).where(eq(buildRuns.id, buildRunId));
  if (!run) return null;
  const revisionRows = await database.select().from(buildRevisions).where(and(
    eq(buildRevisions.buildRunId, buildRunId),
    eq(buildRevisions.revisionNumber, revisionNumber ?? run.currentRevisionNumber),
  ));
  const revision = revisionRows[0];
  if (!revision) return null;
  const tasks = await database.select().from(buildTasks).where(eq(buildTasks.buildRevisionId, revision.id));
  const planner = tasks.find((task) => task.role === 'planner') ?? null;
  const agent = planner
    ? (await database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.buildTaskId, planner.id)).orderBy(desc(agentRuns.startedAt)).limit(1))[0]
    : undefined;
  const planTasks = tasks.filter((task) => task.role !== 'planner').map(toStoredTask);
  return {
    buildRunId: run.id,
    project: run.project,
    repository: run.repository,
    requestedByUserId: run.requestedByUserId,
    status: run.status,
    suspendReason: run.suspendReason ?? null,
    suspendedFromStatus: run.suspendedFromStatus ?? null,
    integrationBranch: run.integrationBranch ?? null,
    baseCommit: run.baseCommit ?? null,
    skillSnapshot: run.skillSnapshot,
    supportContacts: run.supportContacts,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    classification: revision.classification ?? null,
    requirements: revision.requirements,
    riskDecisions: revision.riskDecisions,
    plan: revision.plan ?? null,
    planValidation: normalizeValidation(revision.planValidation),
    repairAttempts: revision.repairAttempts,
    contextNotesPath: revision.contextNotesPath ?? null,
    briefText: run.prompt,
    planner: planner ? {
      id: planner.id,
      status: planner.status,
      attempt: planner.attempt,
      agentRunId: agent?.id ?? null,
      startedAtMs: planner.startedAt ? Date.parse(planner.startedAt) : null,
    } : null,
    planTasks,
    implementerCount: planTasks.filter((task) => task.role === 'implementer').length,
  };
}

async function persist(tx: Executor, current: PlanningView, write: PlanningWrite): Promise<void> {
  const now = new Date().toISOString();
  if (write.incrementRepair) {
    await tx.update(buildRevisions).set({
      repairAttempts: sql`${buildRevisions.repairAttempts} + 1`,
      updatedAt: now,
    }).where(and(eq(buildRevisions.id, current.revisionId), sql`${buildRevisions.repairAttempts} < 2`));
  }
  const revisionPatch: Partial<typeof buildRevisions.$inferInsert> = { updatedAt: now };
  if (write.plan !== undefined) revisionPatch.plan = write.plan as Record<string, unknown>;
  if (write.planValidation) revisionPatch.planValidation = write.planValidation;
  if (write.contextNotesPath !== undefined) revisionPatch.contextNotesPath = write.contextNotesPath;
  if (write.repairAttempts != null && !write.incrementRepair) revisionPatch.repairAttempts = write.repairAttempts;
  if (Object.keys(revisionPatch).length > 1) {
    await tx.update(buildRevisions).set(revisionPatch).where(eq(buildRevisions.id, current.revisionId));
  }
  if (write.runStatus) {
    await tx.update(buildRuns).set({
      status: write.runStatus,
      suspendReason: write.runStatus === 'suspended' ? write.suspendReason ?? current.suspendReason : null,
      suspendedFromStatus: write.runStatus === 'suspended' ? write.suspendedFromStatus ?? current.suspendedFromStatus : null,
      updatedAt: now,
    }).where(eq(buildRuns.id, current.buildRunId));
  }
  if (write.planner) {
    const planner = write.planner;
    const existing = current.planner;
    if (!existing) {
      await tx.insert(buildTasks).values({
        id: planner.id,
        buildRevisionId: current.revisionId,
        taskKey: 'planner',
        role: 'planner',
        runMode: 'own_agent',
        status: planner.status,
        attempt: planner.attempt,
        startedAt: planner.startedAtMs == null ? null : new Date(planner.startedAtMs).toISOString(),
      });
    } else {
      await tx.update(buildTasks).set({
        status: planner.status,
        attempt: planner.attempt,
        startedAt: planner.startedAtMs == null ? null : new Date(planner.startedAtMs).toISOString(),
        updatedAt: now,
      }).where(eq(buildTasks.id, existing.id));
    }
  }
  if (write.tasks) {
    for (const task of write.tasks) {
      await tx.insert(buildTasks).values({
        buildRevisionId: current.revisionId,
        taskKey: task.taskKey,
        role: task.role,
        dependsOn: task.blockers,
        ownedFiles: task.ownedFiles,
        covers: task.covers,
        reuse: task.reuse,
        runMode: task.runMode,
        chainHeadKey: task.chainHeadKey,
        status: 'pending',
        attempt: 1,
      });
    }
  }
  for (const event of write.events ?? []) {
    await appendBuildEvent({
      buildRunId: current.buildRunId,
      buildRevisionId: current.revisionId,
      eventType: event.eventType,
      severity: event.severity ?? 'info',
      message: event.message,
      detail: event.detail ?? null,
      dedupeKey: event.dedupeKey ?? null,
    }, { executor: tx });
  }
}

function toStoredTask(task: typeof buildTasks.$inferSelect): StoredPlanTask {
  return {
    taskKey: task.taskKey,
    role: task.role === 'qa' ? 'qa' : 'implementer',
    blockers: task.dependsOn,
    ownedFiles: task.ownedFiles,
    covers: task.covers,
    reuse: task.reuse,
    runMode: task.runMode,
    chainHeadKey: task.chainHeadKey ?? null,
  };
}

function normalizeValidation(
  value: { status: 'pass' | 'fail'; violations: unknown[] } | null,
): PlanningView['planValidation'] {
  if (!value) return null;
  return {
    status: value.status,
    violations: value.violations as PlanViolation[],
  };
}
