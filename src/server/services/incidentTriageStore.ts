/**
 * Drizzle store for ServiceNow incident triage: per-project settings, redacted incidents,
 * and one analysis row per content hash. Rows map to the shared types here.
 */
import { randomUUID } from 'crypto';
import { and, asc, desc, eq, ilike, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  agentRuns,
  incidentTriageAnalyses,
  incidentTriageIncidents,
  incidentTriageSettings,
} from '../db/schema';
import type { EffortLevel } from '../../shared/types/effort';
import type {
  IncidentTriageAnalysis,
  IncidentTriageDetailResponse,
  IncidentTriageIncident,
  IncidentTriageResult,
  IncidentTriageSettings,
  IncidentTriageSettingsUpdate,
  IncidentTriageSeverity,
  IncidentTriageVerdict,
} from '../../shared/types/incidentTriage';
import {
  encryptWebhookUrl,
  isTeamsWorkflowsWebhookUrl,
  readMaskedWebhook,
} from './incidentTriageWebhookCrypto';

export const DEFAULT_BACKFILL_DAYS = 7;
/** A Teams post is tried this many times in total, the first try included. */
export const MAX_TEAMS_ATTEMPTS = 3;

/** An incident as stored: text fields are already redacted and timestamps are ISO strings. */
export interface IncidentRowInput {
  sysId: string;
  number: string;
  shortDescription: string | null;
  description: string | null;
  closeNotes: string | null;
  state: string | null;
  priority: string | null;
  impact: string | null;
  urgency: string | null;
  category: string | null;
  subcategory: string | null;
  assignmentGroupName: string | null;
  closeCode: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  sysUpdatedOn: string | null;
}

export interface SweepResultUpdate {
  watermark?: string;
  lastSweepAt: string;
  lastSweepError: string | null;
}

export interface UpsertIncidentResult {
  id: string;
  contentHash: string;
  changed: boolean;
}

export interface PendingAnalysis {
  runId: string;
  incidentId: string;
  project: string;
  contentHash: string;
  requestedBy: string | null;
  requestedAt: string;
}

export interface ListIncidentsFilters {
  verdict?: IncidentTriageVerdict;
  state?: string;
  q?: string;
  limit: number;
}

type SettingsRow = typeof incidentTriageSettings.$inferSelect;
type IncidentRow = typeof incidentTriageIncidents.$inferSelect;
type AnalysisRow = typeof incidentTriageAnalyses.$inferSelect;

function toIso(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function serviceNowUrl(sysId: string): string | null {
  const base = (process.env.SERVICENOW_INSTANCE_URL ?? '').trim().replace(/\/+$/, '');
  if (base === '') return null;
  return `${base}/nav_to.do?uri=incident.do?sys_id=${sysId}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function defaultSettings(project: string): IncidentTriageSettings {
  return {
    project,
    enabled: false,
    assignmentGroupIds: [],
    backfillDays: DEFAULT_BACKFILL_DAYS,
    watermark: null,
    lastSweepAt: null,
    lastSweepError: null,
    teamsWebhookMasked: null,
  };
}

function mapSettings(row: SettingsRow): IncidentTriageSettings {
  return {
    project: row.project,
    enabled: row.enabled,
    assignmentGroupIds: row.assignmentGroupIds,
    backfillDays: row.backfillDays,
    watermark: toIso(row.watermark),
    lastSweepAt: toIso(row.lastSweepAt),
    lastSweepError: row.lastSweepError,
    teamsWebhookMasked: readMaskedWebhook(row.teamsWebhook),
  };
}

function mapAnalysis(row: AnalysisRow): IncidentTriageAnalysis {
  return {
    runId: row.runId,
    status: row.status,
    requestedBy: row.requestedBy,
    model: row.model,
    verdict: row.verdict as IncidentTriageVerdict | null,
    area: row.area,
    severity: row.severity as IncidentTriageSeverity | null,
    result: row.result,
    failureDetail: row.failureDetail,
    teamsStatus: row.teamsStatus,
    requestedAt: toIso(row.requestedAt) ?? row.requestedAt,
    completedAt: toIso(row.completedAt),
  };
}

function mapIncident(row: IncidentRow, latestAnalysis: AnalysisRow | null): IncidentTriageIncident {
  return {
    id: row.id,
    project: row.project,
    sysId: row.sysId,
    number: row.number,
    shortDescription: row.shortDescription,
    description: row.description,
    closeNotes: row.closeNotes,
    state: row.state,
    priority: row.priority,
    impact: row.impact,
    urgency: row.urgency,
    category: row.category,
    subcategory: row.subcategory,
    assignmentGroupName: row.assignmentGroupName,
    openedAt: toIso(row.openedAt),
    resolvedAt: toIso(row.resolvedAt),
    sysUpdatedOn: toIso(row.sysUpdatedOn),
    closeCode: row.closeCode,
    serviceNowUrl: serviceNowUrl(row.sysId),
    latestAnalysis: latestAnalysis ? mapAnalysis(latestAnalysis) : null,
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(project: string): Promise<IncidentTriageSettings | null> {
  const [row] = await db
    .select()
    .from(incidentTriageSettings)
    .where(eq(incidentTriageSettings.project, project))
    .limit(1);
  return row ? mapSettings(row) : null;
}

export async function listEnabledSettings(): Promise<IncidentTriageSettings[]> {
  const rows = await db
    .select()
    .from(incidentTriageSettings)
    .where(eq(incidentTriageSettings.enabled, true))
    .orderBy(asc(incidentTriageSettings.project));
  return rows.map(mapSettings);
}

function sameIds(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  return leftSet.size === new Set(right).size && right.every((id) => leftSet.has(id));
}

export class InvalidTeamsWebhookError extends Error {
  constructor() {
    super('Webhook must be a Teams Workflows URL');
    this.name = 'InvalidTeamsWebhookError';
  }
}

function webhookChange(project: string, url: string | null | undefined) {
  if (url === undefined) return {};
  if (url === null) return { teamsWebhook: null };
  const trimmed = url.trim();
  if (!isTeamsWorkflowsWebhookUrl(trimmed)) throw new InvalidTeamsWebhookError();
  return { teamsWebhook: { ...encryptWebhookUrl(project, trimmed) } };
}

/**
 * A `teamsWebhookUrl` string is validated and stored encrypted, `null` clears it, and omitted keeps it.
 * New assignment groups clear the watermark so the next sweep backfills them.
 */
export async function upsertSettings(
  project: string,
  update: IncidentTriageSettingsUpdate,
  userId: string,
): Promise<IncidentTriageSettings> {
  const webhook = webhookChange(project, update.teamsWebhookUrl);
  const [existing] = await db
    .select({ assignmentGroupIds: incidentTriageSettings.assignmentGroupIds })
    .from(incidentTriageSettings)
    .where(eq(incidentTriageSettings.project, project))
    .limit(1);
  const groupsChanged = update.assignmentGroupIds !== undefined
    && existing !== undefined
    && !sameIds(existing.assignmentGroupIds, update.assignmentGroupIds);
  const changes = {
    ...(update.enabled !== undefined && { enabled: update.enabled }),
    ...(update.assignmentGroupIds !== undefined && { assignmentGroupIds: update.assignmentGroupIds }),
    ...(update.backfillDays !== undefined && { backfillDays: update.backfillDays }),
    ...(groupsChanged && { watermark: null }),
    ...webhook,
  };
  const [row] = await db
    .insert(incidentTriageSettings)
    .values({ project, ...changes, updatedBy: userId })
    .onConflictDoUpdate({
      target: incidentTriageSettings.project,
      set: { ...changes, updatedBy: userId, updatedAt: sql`now()` },
    })
    .returning();
  return mapSettings(row);
}

export async function recordSweepResult(project: string, result: SweepResultUpdate): Promise<void> {
  await db
    .update(incidentTriageSettings)
    .set({
      lastSweepAt: result.lastSweepAt,
      lastSweepError: result.lastSweepError,
      ...(result.watermark !== undefined && { watermark: result.watermark }),
    })
    .where(eq(incidentTriageSettings.project, project));
}

// ── Incidents ────────────────────────────────────────────────────────────────

export async function upsertIncident(
  project: string,
  row: IncidentRowInput,
  contentHash: string,
): Promise<UpsertIncidentResult> {
  const [existing] = await db
    .select({ contentHash: incidentTriageIncidents.contentHash })
    .from(incidentTriageIncidents)
    .where(
      and(eq(incidentTriageIncidents.project, project), eq(incidentTriageIncidents.sysId, row.sysId)),
    )
    .limit(1);

  const { sysId, ...fields } = row;
  const [stored] = await db
    .insert(incidentTriageIncidents)
    .values({ project, sysId, ...fields, contentHash })
    .onConflictDoUpdate({
      target: [incidentTriageIncidents.project, incidentTriageIncidents.sysId],
      set: { ...fields, contentHash, lastSeenAt: sql`now()` },
    })
    .returning({ id: incidentTriageIncidents.id });

  return { id: stored.id, contentHash, changed: !existing || existing.contentHash !== contentHash };
}

/** The latest analysis per incident, any status. */
function latestAnalysisPerIncident() {
  return db
    .selectDistinctOn([incidentTriageAnalyses.incidentId])
    .from(incidentTriageAnalyses)
    .orderBy(incidentTriageAnalyses.incidentId, desc(incidentTriageAnalyses.requestedAt))
    .as('latest_analysis');
}

export async function listIncidents(
  project: string,
  filters: ListIncidentsFilters,
): Promise<IncidentTriageIncident[]> {
  const latest = latestAnalysisPerIncident();
  const conditions: SQL[] = [eq(incidentTriageIncidents.project, project)];
  if (filters.verdict) conditions.push(eq(latest.verdict, filters.verdict));
  if (filters.state) conditions.push(eq(incidentTriageIncidents.state, filters.state));
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    const match = or(
      ilike(incidentTriageIncidents.number, pattern),
      ilike(incidentTriageIncidents.shortDescription, pattern),
    );
    if (match) conditions.push(match);
  }

  const rows = await db
    .select()
    .from(incidentTriageIncidents)
    .leftJoin(latest, eq(latest.incidentId, incidentTriageIncidents.id))
    .where(and(...conditions))
    .orderBy(desc(incidentTriageIncidents.sysUpdatedOn))
    .limit(filters.limit);

  return rows.map((row) => mapIncident(row.incident_triage_incidents, row.latest_analysis));
}

export async function getIncidentDetail(
  project: string,
  id: string,
): Promise<IncidentTriageDetailResponse | null> {
  const [incident] = await db
    .select()
    .from(incidentTriageIncidents)
    .where(and(eq(incidentTriageIncidents.project, project), eq(incidentTriageIncidents.id, id)))
    .limit(1);
  if (!incident) return null;

  const analyses = await db
    .select()
    .from(incidentTriageAnalyses)
    .where(eq(incidentTriageAnalyses.incidentId, id))
    .orderBy(desc(incidentTriageAnalyses.requestedAt));

  return {
    incident: mapIncident(incident, analyses[0] ?? null),
    analyses: analyses.map(mapAnalysis),
  };
}

// ── Analyses ─────────────────────────────────────────────────────────────────

/** Returns false when a scheduled analysis for this incident and content hash already exists. */
export async function insertPendingAnalysis(
  incidentId: string,
  contentHash: string,
  sysUpdatedOn: string | null,
  requestedBy: string | null,
): Promise<boolean> {
  const inserted = await db
    .insert(incidentTriageAnalyses)
    .values({
      runId: randomUUID(),
      incidentId,
      contentHash,
      sysUpdatedOn,
      status: 'pending',
      requestedBy,
    })
    .onConflictDoNothing({
      target: [incidentTriageAnalyses.incidentId, incidentTriageAnalyses.contentHash],
      where: sql`requested_by IS NULL`,
    })
    .returning({ runId: incidentTriageAnalyses.runId });
  return inserted.length > 0;
}

/** Pending analyses of the given projects, oldest first. No projects means no rows. */
export async function listPendingAnalyses(limit: number, projects: readonly string[]): Promise<PendingAnalysis[]> {
  if (projects.length === 0) return [];
  const rows = await db
    .select({
      runId: incidentTriageAnalyses.runId,
      incidentId: incidentTriageAnalyses.incidentId,
      project: incidentTriageIncidents.project,
      contentHash: incidentTriageAnalyses.contentHash,
      requestedBy: incidentTriageAnalyses.requestedBy,
      requestedAt: incidentTriageAnalyses.requestedAt,
    })
    .from(incidentTriageAnalyses)
    .innerJoin(incidentTriageIncidents, eq(incidentTriageIncidents.id, incidentTriageAnalyses.incidentId))
    .where(and(eq(incidentTriageAnalyses.status, 'pending'), inArray(incidentTriageIncidents.project, [...projects])))
    .orderBy(asc(incidentTriageAnalyses.requestedAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, requestedAt: toIso(row.requestedAt) ?? row.requestedAt }));
}

export interface RunningAnalysisFields {
  model: string;
  effort: EffortLevel | null;
  repository: string;
  groundedSha: string;
}

/** Claims a pending analysis for a run. Returns false when another caller already did. */
export async function markAnalysisRunning(runId: string, fields: RunningAnalysisFields): Promise<boolean> {
  const claimed = await db
    .update(incidentTriageAnalyses)
    .set({ status: 'running', ...fields })
    .where(and(eq(incidentTriageAnalyses.runId, runId), eq(incidentTriageAnalyses.status, 'pending')))
    .returning({ runId: incidentTriageAnalyses.runId });
  return claimed.length > 0;
}

/** Puts a run that never started back in the queue for the next sweep. */
export async function revertAnalysisToPending(runId: string): Promise<void> {
  await db
    .update(incidentTriageAnalyses)
    .set({ status: 'pending', model: null, effort: null, repository: null, groundedSha: null })
    .where(and(eq(incidentTriageAnalyses.runId, runId), eq(incidentTriageAnalyses.status, 'running')));
}

export async function deleteAnalysis(runId: string): Promise<void> {
  await db.delete(incidentTriageAnalyses).where(eq(incidentTriageAnalyses.runId, runId));
}

export interface AnalysisCompletion {
  verdict: IncidentTriageVerdict;
  area: string;
  severity: IncidentTriageSeverity;
  result: IncidentTriageResult;
}

/**
 * Stores a finished result and queues its Teams post, also when the stale-run reaper failed the row
 * first. A row already completed is left as it is, so a repeated harvest changes nothing.
 */
export async function completeAnalysis(runId: string, completion: AnalysisCompletion): Promise<void> {
  await db
    .update(incidentTriageAnalyses)
    .set({
      status: 'completed',
      ...completion,
      failureDetail: null,
      teamsStatus: 'pending',
      completedAt: new Date().toISOString(),
    })
    .where(and(eq(incidentTriageAnalyses.runId, runId), ne(incidentTriageAnalyses.status, 'completed')));
}

/** A failed analysis has nothing to post, so its Teams status is skipped. */
export async function failAnalysis(runId: string, failureDetail: string): Promise<void> {
  await db
    .update(incidentTriageAnalyses)
    .set({ status: 'failed', failureDetail, teamsStatus: 'skipped', completedAt: new Date().toISOString() })
    .where(eq(incidentTriageAnalyses.runId, runId));
}

const ACTIVE_AGENT_RUN_STATUSES = ['queued', 'dispatched', 'running'] as const;
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/**
 * The agent run is over but its result is not harvested yet. Mirrors `isDocumentHarvestPending`
 * in the finished-attempt reader, which never offers a run that a newer run on the same thread
 * and workflow class superseded. A run with no agent run or no attempt never matches, so a run
 * that crashed before dispatch can still be failed.
 */
const harvestPending = sql`EXISTS (
  SELECT 1
  FROM agent_runs r
  JOIN LATERAL (
    SELECT attempt.id, attempt.status
    FROM ai_run_attempts attempt
    WHERE attempt.run_id = r.id
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  ) latest_attempt ON TRUE
  WHERE r.id = ${incidentTriageAnalyses.runId}::text
    AND r.transport_version = 'servicebus-blob-v2'
    AND ${inArray(sql`r.status`, [...FINISHED_STATUSES])}
    AND ${inArray(sql`latest_attempt.status`, [...FINISHED_STATUSES])}
    AND NOT EXISTS (
      SELECT 1
      FROM agent_runs newer
      WHERE newer.thread_id = r.thread_id
        AND newer.execution_snapshot->>'workflowClass' =
          r.execution_snapshot->>'workflowClass'
        AND (
          newer.created_at > r.created_at
          OR (
            newer.created_at = r.created_at
            AND newer.id > r.id
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ai_run_inbox harvested
      WHERE harvested.event_id = 'artifact-harvest:' || latest_attempt.id
        AND harvested.processed_at IS NOT NULL
    )
)`;

/**
 * Fails running analyses requested before `cutoff` whose agent run is no longer active and whose
 * result is not waiting for harvest, so a crash or restart cannot block an incident for good.
 * Returns how many rows it failed.
 */
export async function failStaleRunningAnalyses(cutoff: Date, reason: string): Promise<number> {
  const failed = await db
    .update(incidentTriageAnalyses)
    .set({ status: 'failed', failureDetail: reason, teamsStatus: 'skipped', completedAt: new Date().toISOString() })
    .where(
      and(
        eq(incidentTriageAnalyses.status, 'running'),
        lt(incidentTriageAnalyses.requestedAt, cutoff.toISOString()),
        sql`NOT EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${agentRuns.id} = ${incidentTriageAnalyses.runId}::text AND ${inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES])})`,
        sql`NOT ${harvestPending}`,
      ),
    )
    .returning({ runId: incidentTriageAnalyses.runId });
  return failed.length;
}

export async function getAnalysisByRunId(runId: string): Promise<IncidentTriageAnalysis | null> {
  const [row] = await db
    .select()
    .from(incidentTriageAnalyses)
    .where(eq(incidentTriageAnalyses.runId, runId))
    .limit(1);
  return row ? mapAnalysis(row) : null;
}

/** A person asked for a new analysis of the incident's latest content. Null when the incident is unknown. */
export async function insertManualAnalysis(
  project: string,
  incidentId: string,
  userId: string,
): Promise<{ runId: string } | null> {
  const [incident] = await db
    .select({
      id: incidentTriageIncidents.id,
      contentHash: incidentTriageIncidents.contentHash,
      sysUpdatedOn: incidentTriageIncidents.sysUpdatedOn,
    })
    .from(incidentTriageIncidents)
    .where(and(eq(incidentTriageIncidents.project, project), eq(incidentTriageIncidents.id, incidentId)))
    .limit(1);
  if (!incident) return null;

  const [inserted] = await db
    .insert(incidentTriageAnalyses)
    .values({
      runId: randomUUID(),
      incidentId: incident.id,
      contentHash: incident.contentHash,
      sysUpdatedOn: incident.sysUpdatedOn,
      status: 'pending',
      requestedBy: userId,
    })
    .returning({ runId: incidentTriageAnalyses.runId });
  return { runId: inserted.runId };
}

export async function hasRunningAnalysis(incidentId: string): Promise<boolean> {
  const rows = await db
    .select({ runId: incidentTriageAnalyses.runId })
    .from(incidentTriageAnalyses)
    .where(and(eq(incidentTriageAnalyses.incidentId, incidentId), eq(incidentTriageAnalyses.status, 'running')))
    .limit(1);
  return rows.length > 0;
}

/** Counts a failed start for the row. Returns the new count, or null when the row is gone. */
export async function recordAdmissionFailure(runId: string): Promise<number | null> {
  const [row] = await db
    .update(incidentTriageAnalyses)
    .set({ admissionAttempts: sql`${incidentTriageAnalyses.admissionAttempts} + 1` })
    .where(eq(incidentTriageAnalyses.runId, runId))
    .returning({ admissionAttempts: incidentTriageAnalyses.admissionAttempts });
  return row ? row.admissionAttempts : null;
}

// ── Teams delivery ───────────────────────────────────────────────────────────

export interface AnalysisForPost {
  project: string;
  incident: IncidentTriageIncident;
  analysis: IncidentTriageAnalysis;
  teamsAttempts: number;
}

export interface PostedVerdict {
  verdict: string | null;
  severity: string | null;
}

/** The stored, encrypted webhook envelope, or null when the project has none. */
export async function getTeamsWebhook(project: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ teamsWebhook: incidentTriageSettings.teamsWebhook })
    .from(incidentTriageSettings)
    .where(eq(incidentTriageSettings.project, project))
    .limit(1);
  return row?.teamsWebhook ?? null;
}

export async function getAnalysisForPost(runId: string): Promise<AnalysisForPost | null> {
  const [row] = await db
    .select()
    .from(incidentTriageAnalyses)
    .innerJoin(incidentTriageIncidents, eq(incidentTriageIncidents.id, incidentTriageAnalyses.incidentId))
    .where(eq(incidentTriageAnalyses.runId, runId))
    .limit(1);
  if (!row) return null;
  const stored = row.incident_triage_analyses;
  const incident = row.incident_triage_incidents;
  return {
    project: incident.project,
    incident: mapIncident(incident, null),
    analysis: mapAnalysis(stored),
    teamsAttempts: stored.teamsAttempts,
  };
}

/** The verdict and severity of the incident's most recently posted card, other than this run's. */
export async function getLastPostedAnalysis(incidentId: string, excludeRunId: string): Promise<PostedVerdict | null> {
  const [row] = await db
    .select({ verdict: incidentTriageAnalyses.verdict, severity: incidentTriageAnalyses.severity })
    .from(incidentTriageAnalyses)
    .where(
      and(
        eq(incidentTriageAnalyses.incidentId, incidentId),
        eq(incidentTriageAnalyses.teamsStatus, 'posted'),
        ne(incidentTriageAnalyses.runId, excludeRunId),
      ),
    )
    .orderBy(desc(incidentTriageAnalyses.teamsPostedAt))
    .limit(1);
  return row ?? null;
}

export async function markTeamsPosted(runId: string): Promise<void> {
  await db
    .update(incidentTriageAnalyses)
    .set({ teamsStatus: 'posted', teamsPostedAt: new Date().toISOString() })
    .where(eq(incidentTriageAnalyses.runId, runId));
}

export async function markTeamsSkipped(runId: string): Promise<void> {
  await db
    .update(incidentTriageAnalyses)
    .set({ teamsStatus: 'skipped' })
    .where(eq(incidentTriageAnalyses.runId, runId));
}

/** Records a failed post and counts the attempt. */
export async function markTeamsFailed(runId: string): Promise<void> {
  await db
    .update(incidentTriageAnalyses)
    .set({
      teamsStatus: 'failed',
      teamsAttempts: sql`${incidentTriageAnalyses.teamsAttempts} + 1`,
    })
    .where(eq(incidentTriageAnalyses.runId, runId));
}

/** Run ids of the given projects' completed analyses whose post failed and has attempts left, oldest first. */
export async function listFailedTeamsPosts(limit: number, projects: readonly string[]): Promise<string[]> {
  if (projects.length === 0) return [];
  const rows = await db
    .select({ runId: incidentTriageAnalyses.runId })
    .from(incidentTriageAnalyses)
    .innerJoin(incidentTriageIncidents, eq(incidentTriageIncidents.id, incidentTriageAnalyses.incidentId))
    .where(
      and(
        inArray(incidentTriageIncidents.project, [...projects]),
        eq(incidentTriageAnalyses.status, 'completed'),
        eq(incidentTriageAnalyses.teamsStatus, 'failed'),
        lt(incidentTriageAnalyses.teamsAttempts, MAX_TEAMS_ATTEMPTS),
      ),
    )
    .orderBy(asc(incidentTriageAnalyses.completedAt))
    .limit(limit);
  return rows.map((row) => row.runId);
}
