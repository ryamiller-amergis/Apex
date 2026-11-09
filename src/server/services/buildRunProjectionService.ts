/**
 * Read projection for the Build Run View (TBI-014). Each mapper copies named fields only, and every
 * free-text field passes through the shared redaction step before it leaves the server.
 */
import { asc, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { buildEvents, buildRevisions, buildRuns, buildTasks, buildVerificationRows } from '../db/schema';
import type {
  BuildClassification,
  BuildDeploymentStatus,
  BuildRequirement,
  BuildReuseEntry,
  BuildRiskDecision,
  BuildRunStatus,
  BuildSupportContact,
  BuildSuspendReason,
  BuildTaskRole,
  BuildTaskRunMode,
  BuildTaskStatus,
  BuildVerificationStatus,
} from '../../shared/types/build';
import {
  BUILD_EVENTS_DEFAULT_LIMIT,
  BUILD_EVENTS_MAX_LIMIT,
  type BuildBriefView,
  type BuildDetailResponse,
  type BuildEventsResponse,
  type BuildEventView,
  type BuildTaskView,
  type BuildVerificationSummary,
} from '../../shared/types/buildView';
import { redactText } from './buildRedactionService';
import { queuePositionFor } from './buildOrchestrator/store';
import { deriveBuildStage, deriveBuildTiming } from './buildStageDerivation';

export const REDACTION_PLACEHOLDER = '[Text hidden: it could not be checked]';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProjectionRevisionRow {
  id: string;
  revisionNumber: number;
  requirements: BuildRequirement[];
  assumptions: string[];
  exclusions: string[];
  riskDecisions: BuildRiskDecision[];
  classification: BuildClassification | null;
  repairAttempts: number;
  elapsedSecondsUsed: number;
  deploymentStatus: BuildDeploymentStatus;
  previewUrl: string | null;
  createdAt: string;
}

export interface ProjectionRunRow {
  id: string;
  project: string;
  repository: string;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  interviewId: string | null;
  currentRevisionNumber: number;
  revisionsUsed: number;
  revisionCap: number;
  supportContacts: BuildSupportContact[];
  costCapUsd: string;
  costUsedUsd: string;
  elapsedCapSeconds: number;
  parallelismCap: number;
  parallelismUsed: number;
  endedAt: string | null;
  createdAt: string;
  revisions: ProjectionRevisionRow[];
}

export interface ProjectionTaskRow {
  taskKey: string;
  role: BuildTaskRole;
  dependsOn: string[];
  ownedFiles: string[];
  reuse: BuildReuseEntry[];
  runMode: BuildTaskRunMode;
  branchName: string | null;
  status: BuildTaskStatus;
  attempt: number;
  omittedReason: string | null;
}

export interface ProjectionEventRow {
  id: string;
  eventType: string;
  message: string;
  taskKey: string | null;
  createdAt: string;
}

export interface BuildRunProjectionDeps {
  loadRun: (buildId: string) => Promise<ProjectionRunRow | null>;
  loadRunProject: (buildId: string) => Promise<{ id: string; project: string } | null>;
  loadTasks: (revisionId: string) => Promise<ProjectionTaskRow[]>;
  loadVerificationCounts: (revisionId: string) => Promise<Array<{ status: BuildVerificationStatus; count: number }>>;
  queuePosition: (project: string, buildId: string) => Promise<number | null>;
  /** Latest `limit` rows, newest first, plus the full count. */
  loadEvents: (buildId: string, limit: number) => Promise<{ rows: ProjectionEventRow[]; total: number }>;
  redact: (text: string) => string;
  now: () => Date;
  warn: (event: string, fields: Record<string, unknown>) => void;
}

const defaultDeps: BuildRunProjectionDeps = {
  loadRun: async (buildId) => {
    const row = await db.query.buildRuns.findFirst({
      where: eq(buildRuns.id, buildId),
      columns: {
        id: true,
        project: true,
        repository: true,
        status: true,
        suspendReason: true,
        interviewId: true,
        currentRevisionNumber: true,
        revisionsUsed: true,
        revisionCap: true,
        supportContacts: true,
        costCapUsd: true,
        costUsedUsd: true,
        elapsedCapSeconds: true,
        parallelismCap: true,
        parallelismUsed: true,
        endedAt: true,
        createdAt: true,
      },
      with: {
        revisions: {
          columns: {
            id: true,
            revisionNumber: true,
            requirements: true,
            assumptions: true,
            exclusions: true,
            riskDecisions: true,
            classification: true,
            repairAttempts: true,
            elapsedSecondsUsed: true,
            deploymentStatus: true,
            previewUrl: true,
            createdAt: true,
          },
          orderBy: asc(buildRevisions.revisionNumber),
        },
      },
    });
    return row ?? null;
  },
  loadRunProject: async (buildId) => {
    const [row] = await db
      .select({ id: buildRuns.id, project: buildRuns.project })
      .from(buildRuns)
      .where(eq(buildRuns.id, buildId))
      .limit(1);
    return row ?? null;
  },
  loadTasks: (revisionId) => db
    .select({
      taskKey: buildTasks.taskKey,
      role: buildTasks.role,
      dependsOn: buildTasks.dependsOn,
      ownedFiles: buildTasks.ownedFiles,
      reuse: buildTasks.reuse,
      runMode: buildTasks.runMode,
      branchName: buildTasks.branchName,
      status: buildTasks.status,
      attempt: buildTasks.attempt,
      omittedReason: buildTasks.omittedReason,
    })
    .from(buildTasks)
    .where(eq(buildTasks.buildRevisionId, revisionId))
    .orderBy(asc(buildTasks.createdAt), asc(buildTasks.taskKey)),
  loadVerificationCounts: (revisionId) => db
    .select({ status: buildVerificationRows.status, count: sql<number>`count(*)::int` })
    .from(buildVerificationRows)
    .where(eq(buildVerificationRows.buildRevisionId, revisionId))
    .groupBy(buildVerificationRows.status),
  queuePosition: queuePositionFor,
  loadEvents: async (buildId, limit) => {
    const [rows, totals] = await Promise.all([
      db
        .select({
          id: buildEvents.id,
          eventType: buildEvents.eventType,
          message: buildEvents.message,
          taskKey: sql<string | null>`${buildEvents.detail} ->> 'taskKey'`,
          createdAt: buildEvents.createdAt,
        })
        .from(buildEvents)
        .where(eq(buildEvents.buildRunId, buildId))
        .orderBy(desc(buildEvents.ordinal))
        .limit(limit),
      db.select({ total: count() }).from(buildEvents).where(eq(buildEvents.buildRunId, buildId)),
    ]);
    return { rows, total: Number(totals[0]?.total ?? 0) };
  },
  redact: (text) => redactText(text),
  now: () => new Date(),
  warn: (event, fields) => console.warn(event, fields),
};

export type BuildDetailResult =
  | { kind: 'ok'; detail: BuildDetailResponse }
  | { kind: 'not-found' }
  | { kind: 'wrong-project' };

export type BuildEventsResult =
  | { kind: 'ok'; response: BuildEventsResponse }
  | { kind: 'not-found' }
  | { kind: 'wrong-project' };

export function normalizeEventsLimit(raw: unknown): number {
  const parsed = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return BUILD_EVENTS_DEFAULT_LIMIT;
  return Math.min(parsed, BUILD_EVENTS_MAX_LIMIT);
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function makeRedactor(deps: BuildRunProjectionDeps, buildId: string): (text: string) => string {
  return (text) => {
    try {
      return deps.redact(text);
    } catch (error) {
      deps.warn('build.redaction.field_hidden', { buildId, errorClass: errorClass(error) });
      return REDACTION_PLACEHOLDER;
    }
  };
}

function asArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} is not a list`);
  return value as T[];
}

function mapBrief(revision: ProjectionRevisionRow, redact: (text: string) => string): BuildBriefView {
  return {
    status: 'ok',
    overview: null,
    requirements: asArray<BuildRequirement>(revision.requirements, 'requirements').map((row) => ({
      id: row.id,
      kind: row.kind,
      text: redact(row.text),
      retired: row.retired === true,
    })),
    assumptions: asArray<string>(revision.assumptions, 'assumptions').map(redact),
    exclusions: asArray<string>(revision.exclusions, 'exclusions').map(redact),
    riskDecisions: asArray<BuildRiskDecision>(revision.riskDecisions, 'riskDecisions').map((row) => ({
      id: row.id,
      category: row.category,
      rating: row.rating,
      decision: redact(row.decision),
      rationale: redact(row.rationale),
    })),
  };
}

function mapTask(row: ProjectionTaskRow, redact: (text: string) => string): BuildTaskView {
  return {
    key: row.taskKey,
    role: row.role,
    dependsOn: [...row.dependsOn],
    ownedFiles: [...row.ownedFiles],
    reuse: row.reuse.map((entry) => ({
      path: entry.path,
      ...(entry.symbol ? { symbol: entry.symbol } : {}),
      ...(entry.reason ? { reason: redact(entry.reason) } : {}),
    })),
    runMode: row.runMode,
    branch: row.branchName,
    status: row.status,
    attempt: row.attempt,
    omittedReason: row.omittedReason === null ? null : redact(row.omittedReason),
  };
}

function summarizeVerification(
  counts: Array<{ status: BuildVerificationStatus; count: number }>,
): BuildVerificationSummary {
  const summary: BuildVerificationSummary = { total: 0, pass: 0, fail: 0, deferred: 0, retired: 0 };
  for (const row of counts) {
    const n = Number(row.count);
    summary.total += n;
    switch (row.status) {
      case 'pass':
      case 'fail':
      case 'deferred':
      case 'retired':
        summary[row.status] += n;
        break;
      case 'pending':
        break;
      default: {
        const unhandled: never = row.status;
        throw new Error(`Unhandled verification status: ${String(unhandled)}`);
      }
    }
  }
  return summary;
}

async function loadOwned<T extends { project: string }>(
  project: string,
  buildId: string,
  load: (buildId: string) => Promise<T | null>,
): Promise<T | 'not-found' | 'wrong-project'> {
  if (!UUID_PATTERN.test(buildId)) return 'not-found';
  const run = await load(buildId);
  if (!run) return 'not-found';
  if (run.project !== project) return 'wrong-project';
  return run;
}

export async function getBuildDetail(
  input: { project: string; buildId: string },
  deps: BuildRunProjectionDeps = defaultDeps,
): Promise<BuildDetailResult> {
  const run = await loadOwned(input.project, input.buildId, deps.loadRun);
  if (run === 'not-found' || run === 'wrong-project') return { kind: run };

  const redact = makeRedactor(deps, input.buildId);
  const current = run.revisions.find((row) => row.revisionNumber === run.currentRevisionNumber) ?? null;
  const [taskRows, verificationCounts, queuePosition] = await Promise.all([
    current ? deps.loadTasks(current.id) : Promise.resolve([]),
    current ? deps.loadVerificationCounts(current.id) : Promise.resolve([]),
    run.status === 'queued' ? deps.queuePosition(run.project, run.id) : Promise.resolve(null),
  ]);

  let brief: BuildBriefView = { status: 'unavailable' };
  if (current) {
    try {
      brief = mapBrief(current, redact);
    } catch (error) {
      deps.warn('build.brief.unavailable', { buildId: input.buildId, errorClass: errorClass(error) });
    }
  }

  const detail: BuildDetailResponse = {
    build: {
      id: run.id,
      project: run.project,
      repository: run.repository,
      status: run.status,
      currentRevisionNumber: run.currentRevisionNumber,
      intakeInterviewId: run.interviewId,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
    },
    stage: deriveBuildStage({ status: run.status, suspendReason: run.suspendReason, tasks: taskRows, queuePosition }),
    timing: deriveBuildTiming({
      classification: current?.classification ?? null,
      startedAt: current?.createdAt ?? null,
      deployStartedAt: null,
      deployFinishedAt: null,
      endedAt: run.endedAt,
      deploymentTimesKnown: false,
      now: deps.now(),
    }),
    caps: {
      cost: { usedUsd: String(run.costUsedUsd), limitUsd: String(run.costCapUsd) },
      revisions: { used: run.revisionsUsed, limit: run.revisionCap },
      elapsedSeconds: { used: current?.elapsedSecondsUsed ?? 0, limit: run.elapsedCapSeconds },
      parallelism: { used: run.parallelismUsed, limit: run.parallelismCap },
    },
    supportContacts: run.supportContacts.map((contact) => ({
      displayName: contact.displayName,
      email: contact.email || null,
    })),
    revisions: [...run.revisions]
      .sort((left, right) => left.revisionNumber - right.revisionNumber)
      .map((row) => ({
        number: row.revisionNumber,
        createdAt: row.createdAt,
        classification: row.classification,
        deploymentStatus: row.deploymentStatus,
        previewUrl: row.previewUrl,
      })),
    currentRevision: current
      ? {
        number: current.revisionNumber,
        classification: current.classification,
        repairAttempts: current.repairAttempts,
        brief,
        tasks: taskRows.map((row) => mapTask(row, redact)),
      }
      : null,
    verificationSummary: summarizeVerification(verificationCounts),
    lease: null,
  };
  return { kind: 'ok', detail };
}

function mapEvent(row: ProjectionEventRow, redact: (text: string) => string): BuildEventView {
  return {
    id: row.id,
    occurredAt: row.createdAt,
    kind: row.eventType,
    message: redact(row.message),
    taskKey: row.taskKey,
  };
}

export async function listBuildRunEvents(
  input: { project: string; buildId: string; limit: number },
  deps: BuildRunProjectionDeps = defaultDeps,
): Promise<BuildEventsResult> {
  const run = await loadOwned(input.project, input.buildId, deps.loadRunProject);
  if (run === 'not-found' || run === 'wrong-project') return { kind: run };
  const redact = makeRedactor(deps, input.buildId);
  const { rows, total } = await deps.loadEvents(run.id, input.limit);
  const events = [...rows].reverse().map((row) => mapEvent(row, redact));
  return { kind: 'ok', response: { events, total } };
}
