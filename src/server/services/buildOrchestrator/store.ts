import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { BUILD_RUN_SLOT_STATUSES } from '../../../shared/types/build';
import type { BuildSkillSnapshot, BuildSupportContact, BuildSuspendReason } from '../../../shared/types/build';
import type { BuildQualityManifestSnapshot } from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRuns } from '../../db/schema';
import { appendBuildEvent } from '../buildEventsService';
import { decideAdmission, type QueuedBuild } from './admission';

const ADMISSION_LOCK = 'apex_build_admission';

export interface NewBuildRow {
  project: string;
  repository: string;
  requestedByUserId: string;
  clientRequestId: string;
  prompt: string;
  modelOverride: string | null;
  skillSettingsId: string | null;
  status: 'intake' | 'queued';
  queuedAt: string | null;
  startedAt: string | null;
  skillSnapshot: BuildSkillSnapshot;
  supportContacts: BuildSupportContact[];
  qualityManifestSnapshot: BuildQualityManifestSnapshot;
  costCapUsd: string;
  elapsedCapSeconds: number;
  parallelismCap: number;
  revisionCap: number;
}

export interface StoredBuild {
  id: string;
  project: string;
  repository: string;
  requestedByUserId: string;
  prompt: string;
  status: string;
  playbookRunId: string | null;
  playbookStepRunId: string | null;
  skillSettingsId: string | null;
  queuedAt: string | null;
  interviewId: string | null;
}

export function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && (current as { code?: unknown }).code === '23505') return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export async function findBuildByClientRequest(
  project: string,
  userId: string,
  clientRequestId: string,
): Promise<StoredBuild | null> {
  const [row] = await db
    .select({
      id: buildRuns.id,
      project: buildRuns.project,
      repository: buildRuns.repository,
      requestedByUserId: buildRuns.requestedByUserId,
      prompt: buildRuns.prompt,
      status: buildRuns.status,
      playbookRunId: buildRuns.playbookRunId,
      playbookStepRunId: buildRuns.playbookStepRunId,
      skillSettingsId: buildRuns.skillSettingsId,
      queuedAt: buildRuns.queuedAt,
      interviewId: buildRuns.interviewId,
    })
    .from(buildRuns)
    .where(and(
      eq(buildRuns.project, project),
      eq(buildRuns.requestedByUserId, userId),
      eq(buildRuns.clientRequestId, clientRequestId),
    ))
    .limit(1);
  return row ?? null;
}

export async function queuePositionFor(project: string, buildId: string): Promise<number | null> {
  const [self] = await db
    .select({ status: buildRuns.status, queuedAt: buildRuns.queuedAt })
    .from(buildRuns)
    .where(eq(buildRuns.id, buildId))
    .limit(1);
  if (!self || self.status !== 'queued' || !self.queuedAt) return null;
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(buildRuns)
    .where(and(
      eq(buildRuns.project, project),
      eq(buildRuns.status, 'queued'),
      lt(buildRuns.queuedAt, self.queuedAt),
    ));
  return Number(count?.n ?? 0) + 1;
}

export async function insertBuild(executor: typeof db, row: NewBuildRow): Promise<StoredBuild> {
  const [inserted] = await executor.insert(buildRuns).values({
    project: row.project,
    repository: row.repository,
    requestedByUserId: row.requestedByUserId,
    clientRequestId: row.clientRequestId,
    prompt: row.prompt,
    modelOverride: row.modelOverride,
    skillSettingsId: row.skillSettingsId,
    status: row.status,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    skillSnapshot: row.skillSnapshot,
    supportContacts: row.supportContacts,
    qualityManifestSnapshot: row.qualityManifestSnapshot,
    costCapUsd: row.costCapUsd,
    elapsedCapSeconds: row.elapsedCapSeconds,
    parallelismCap: row.parallelismCap,
    revisionCap: row.revisionCap,
  }).returning({
    id: buildRuns.id,
    project: buildRuns.project,
    repository: buildRuns.repository,
    requestedByUserId: buildRuns.requestedByUserId,
    prompt: buildRuns.prompt,
    status: buildRuns.status,
    playbookRunId: buildRuns.playbookRunId,
    playbookStepRunId: buildRuns.playbookStepRunId,
    skillSettingsId: buildRuns.skillSettingsId,
    queuedAt: buildRuns.queuedAt,
    interviewId: buildRuns.interviewId,
  });
  return inserted;
}

export async function withAdmissionLock<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ADMISSION_LOCK}))`);
    return fn(tx as unknown as typeof db);
  });
}

export async function countSlots(executor: typeof db, project?: string): Promise<number> {
  const filters = [inArray(buildRuns.status, [...BUILD_RUN_SLOT_STATUSES])];
  if (project) filters.push(eq(buildRuns.project, project));
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(buildRuns)
    .where(and(...filters));
  return Number(row?.n ?? 0);
}

export async function currentQueueReason(project: string): Promise<'project_limit' | 'platform_limit' | null> {
  const decision = decideAdmission({
    projectSlots: await countSlots(db, project),
    platformSlots: await countSlots(db),
    olderQueued: 0,
  });
  return decision.queueReason;
}

export async function countOlderQueued(executor: typeof db, project: string, queuedAt: string): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(buildRuns)
    .where(and(
      eq(buildRuns.project, project),
      eq(buildRuns.status, 'queued'),
      lt(buildRuns.queuedAt, queuedAt),
    ));
  return Number(row?.n ?? 0);
}

export async function linkPlaybookRun(buildRunId: string, playbookRunId: string): Promise<void> {
  await db.update(buildRuns).set({
    playbookRunId,
    updatedAt: new Date().toISOString(),
  }).where(and(eq(buildRuns.id, buildRunId), isNull(buildRuns.playbookRunId)));
}

export interface BuildForPlaybookRun {
  id: string;
  repository: string;
  requestedByUserId: string;
}

export async function findBuildByPlaybookRun(playbookRunId: string): Promise<BuildForPlaybookRun | null> {
  const [row] = await db
    .select({
      id: buildRuns.id,
      repository: buildRuns.repository,
      requestedByUserId: buildRuns.requestedByUserId,
    })
    .from(buildRuns)
    .where(eq(buildRuns.playbookRunId, playbookRunId))
    .limit(1);
  return row ?? null;
}

export async function linkBuildInterview(buildRunId: string, interviewId: string): Promise<void> {
  await db.update(buildRuns).set({
    interviewId,
    updatedAt: new Date().toISOString(),
  }).where(and(eq(buildRuns.id, buildRunId), isNull(buildRuns.interviewId)));
}

export async function markBuildFailed(buildRunId: string): Promise<void> {
  const now = new Date().toISOString();
  await db.update(buildRuns).set({
    status: 'failed',
    endedAt: now,
    updatedAt: now,
  }).where(and(eq(buildRuns.id, buildRunId), inArray(buildRuns.status, ['queued', 'intake'])));
}

export async function loadBuild(buildRunId: string): Promise<StoredBuild | null> {
  const [row] = await db
    .select({
      id: buildRuns.id,
      project: buildRuns.project,
      repository: buildRuns.repository,
      requestedByUserId: buildRuns.requestedByUserId,
      prompt: buildRuns.prompt,
      status: buildRuns.status,
      playbookRunId: buildRuns.playbookRunId,
      playbookStepRunId: buildRuns.playbookStepRunId,
      skillSettingsId: buildRuns.skillSettingsId,
      queuedAt: buildRuns.queuedAt,
      interviewId: buildRuns.interviewId,
    })
    .from(buildRuns)
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  return row ?? null;
}

export async function beginPlanningRow(buildRunId: string, stepRunId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const moved = await db.update(buildRuns).set({
    status: 'planning',
    playbookStepRunId: stepRunId,
    updatedAt: now,
  }).where(and(eq(buildRuns.id, buildRunId), eq(buildRuns.status, 'intake'))).returning({ id: buildRuns.id });
  if (moved.length === 0) return false;
  await appendBuildEvent({
    buildRunId,
    eventType: 'build.planning_started',
    message: 'Planning started',
    dedupeKey: `planning:${stepRunId}`,
  });
  return true;
}

export async function listQueuedBuilds(executor: typeof db = db): Promise<QueuedBuild[]> {
  const rows = await executor
    .select({
      id: buildRuns.id,
      project: buildRuns.project,
      repository: buildRuns.repository,
      requestedByUserId: buildRuns.requestedByUserId,
      prompt: buildRuns.prompt,
      skillSettingsId: buildRuns.skillSettingsId,
      queuedAt: buildRuns.queuedAt,
    })
    .from(buildRuns)
    .where(eq(buildRuns.status, 'queued'))
    .orderBy(asc(buildRuns.queuedAt));
  return rows.flatMap((row) => row.queuedAt ? [{ ...row, queuedAt: row.queuedAt }] : []);
}

export async function markIntake(executor: typeof db, id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const moved = await executor.update(buildRuns).set({
    status: 'intake',
    startedAt: now,
    updatedAt: now,
  }).where(and(eq(buildRuns.id, id), eq(buildRuns.status, 'queued'))).returning({ id: buildRuns.id });
  return moved.length > 0;
}

export async function suspendQueued(executor: typeof db, id: string, reason: BuildSuspendReason): Promise<void> {
  const now = new Date().toISOString();
  await executor.update(buildRuns).set({
    status: 'suspended',
    suspendReason: reason,
    suspendedFromStatus: 'queued',
    updatedAt: now,
  }).where(and(eq(buildRuns.id, id), eq(buildRuns.status, 'queued')));
}

export async function writeBuildEvent(input: {
  buildRunId: string;
  eventType: string;
  message: string;
  repository: string;
  model: string | null;
  promptLength: number;
  actorUserId: string;
  dedupeKey: string;
}): Promise<void> {
  await appendBuildEvent({
    buildRunId: input.buildRunId,
    eventType: input.eventType,
    message: input.message,
    actorUserId: input.actorUserId,
    dedupeKey: input.dedupeKey,
    detail: {
      repository: input.repository,
      model: input.model,
      promptLength: input.promptLength,
    },
  });
}
