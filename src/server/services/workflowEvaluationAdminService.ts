/**
 * Admin read model for workflow evaluations: project-wide list, event detail,
 * judge narrative and export. Read-only — it imports no insert, update or
 * enqueue path, so opening the admin page never starts work.
 */
import {
  isWorkflowEvaluationJudgeOutput,
  WORKFLOW_EVALUATION_CRITERIA_KEYS,
  WORKFLOW_EVALUATION_OUTCOME_LABELS,
  WORKFLOW_EVALUATION_REASON_CODE_LABELS,
  WORKFLOW_EVALUATION_SCALE,
  WORKFLOW_EVALUATION_SUBJECT_TYPES,
  isWorkflowEvaluationOutcome,
  type WorkflowEvaluationDefinition,
  type WorkflowEvaluationJob,
  type WorkflowEvaluationJobEvaluator,
  type WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import type { WorkflowEvaluationPromptfooSummary } from '../../shared/types/aiRunV2EvaluationSpec';
import {
  ADMIN_EVALUATION_EXPORT_MAX_ROWS,
  ADMIN_EVALUATION_LIST_DEFAULT_LIMIT,
  ADMIN_EVALUATION_LIST_MAX_LIMIT,
  ADMIN_EVALUATION_SEARCH_MAX_LENGTH,
  workflowEvaluationStageLabel,
  type AdminEvaluationEventDetail,
  type AdminEvaluationEventSummary,
  type AdminEvaluationExportFormat,
  type AdminEvaluationFilters,
  type AdminEvaluationJob,
  type AdminEvaluationJobSummary,
  type AdminEvaluationListResponse,
} from '../../shared/types/workflowEvaluationAdmin';
import { serializeCsv } from '../utils/csvSerialize';
import { resolveArtifactContainerClient } from './aiRunV2/artifactContainer';
import { trackEvent } from './telemetry';
import {
  getDefinitionById,
  getEventWithJobs,
  listJobsForEvents,
  listProjectEvents,
  type ProjectEventCursor,
  type ProjectEventFilters,
  type WorkflowEvaluationEventRecord,
} from './workflowEvaluationRepository';

export class AdminEvaluationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminEvaluationRequestError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPENDIX_MAX_BYTES = 512 * 1024;

const OUTCOME_LABELS = new Map<string, string>(
  WORKFLOW_EVALUATION_OUTCOME_LABELS.map((outcome) => [outcome.key, outcome.label]),
);
const REASON_LABELS = new Map<string, string>(
  WORKFLOW_EVALUATION_REASON_CODE_LABELS.map((reason) => [reason.key, reason.label]),
);

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AdminEvaluationRequestError(`${name} is invalid`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Validates the query string shared by list and export. Unknown keys are ignored. */
export function parseAdminEvaluationFilters(query: Record<string, unknown>): AdminEvaluationFilters {
  const filters: AdminEvaluationFilters = {};
  const stage = optionalString(query.stage, 'stage');
  if (stage) filters.stage = stage;
  const outcome = optionalString(query.outcome, 'outcome');
  if (outcome) {
    if (!isWorkflowEvaluationOutcome(outcome)) throw new AdminEvaluationRequestError('outcome is invalid');
    filters.outcome = outcome;
  }
  const reason = optionalString(query.reason, 'reason');
  if (reason) {
    if (!REASON_LABELS.has(reason)) throw new AdminEvaluationRequestError('reason is invalid');
    filters.reason = reason;
  }
  const subjectType = optionalString(query.subjectType, 'subjectType');
  if (subjectType) {
    if (!(WORKFLOW_EVALUATION_SUBJECT_TYPES as readonly string[]).includes(subjectType)) {
      throw new AdminEvaluationRequestError('subjectType is invalid');
    }
    filters.subjectType = subjectType as WorkflowEvaluationSubjectType;
  }
  for (const key of ['from', 'to'] as const) {
    const value = optionalString(query[key], key);
    if (!value) continue;
    if (!isRealDate(value)) throw new AdminEvaluationRequestError(`${key} must be YYYY-MM-DD`);
    filters[key] = value;
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AdminEvaluationRequestError('from must be on or before to');
  }
  const q = optionalString(query.q, 'q');
  if (q) {
    if (q.length > ADMIN_EVALUATION_SEARCH_MAX_LENGTH) throw new AdminEvaluationRequestError('q is too long');
    filters.q = q;
  }
  const eventId = optionalString(query.eventId, 'eventId');
  if (eventId) {
    if (!UUID_RE.test(eventId)) throw new AdminEvaluationRequestError('eventId is invalid');
    filters.eventId = eventId;
  }
  return filters;
}

export function parseAdminEvaluationLimit(value: unknown): number {
  if (value === undefined) return ADMIN_EVALUATION_LIST_DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ADMIN_EVALUATION_LIST_MAX_LIMIT) {
    throw new AdminEvaluationRequestError(`limit must be between 1 and ${ADMIN_EVALUATION_LIST_MAX_LIMIT}`);
  }
  return parsed;
}

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString();
}

function toRepositoryFilters(filters: AdminEvaluationFilters): ProjectEventFilters {
  return {
    stageKey: filters.stage,
    outcome: filters.outcome,
    reasonCode: filters.reason,
    subjectType: filters.subjectType,
    createdFrom: filters.from ? `${filters.from}T00:00:00.000Z` : undefined,
    createdBefore: filters.to ? nextDay(filters.to) : undefined,
    search: filters.q,
    eventId: filters.eventId,
  };
}

export function encodeAdminEvaluationCursor(cursor: ProjectEventCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeAdminEvaluationCursor(value: unknown): ProjectEventCursor | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    if (typeof value !== 'string') throw new Error('not a string');
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && !Number.isNaN(Date.parse(parsed[0]))
      && typeof parsed[1] === 'string'
      && UUID_RE.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the request error below
  }
  throw new AdminEvaluationRequestError('cursor is invalid');
}

function criteriaAverage(record: WorkflowEvaluationEventRecord): number {
  const scores = Object.values(record.criteriaScores);
  if (scores.length === 0) return 0;
  const mean = scores.reduce((total, score) => total + score, 0) / scores.length;
  return Math.round(mean * 10) / 10;
}

function jobsFor(jobs: readonly WorkflowEvaluationJob[]): AdminEvaluationJobSummary[] {
  return jobs.map((job) => ({ evaluatorKey: job.evaluatorKey, status: job.status }));
}

function toSummary(
  record: WorkflowEvaluationEventRecord,
  jobs: readonly WorkflowEvaluationJob[],
): AdminEvaluationEventSummary {
  return {
    id: record.id,
    createdAt: record.createdAt,
    stageKey: record.stageKey,
    stageLabel: workflowEvaluationStageLabel(record.stageKey),
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    phaseIndex: record.phaseIndex,
    outcome: record.outcome,
    outcomeLabel: OUTCOME_LABELS.get(record.outcome) ?? record.outcome,
    criteriaAverage: criteriaAverage(record),
    reviewerDisplayName: record.reviewerName ?? 'Unknown reviewer',
    reviewerRoleLabel: record.reviewerRoleLabel,
    reasonCodes: record.reasonCodes,
    jobs: jobsFor(jobs),
  };
}

function groupJobs(jobs: readonly WorkflowEvaluationJob[]): Map<string, WorkflowEvaluationJob[]> {
  const byEvent = new Map<string, WorkflowEvaluationJob[]>();
  for (const job of jobs) {
    const list = byEvent.get(job.eventId) ?? [];
    list.push(job);
    byEvent.set(job.eventId, list);
  }
  return byEvent;
}

export async function listAdminEvaluationEvents(
  projectId: string,
  filters: AdminEvaluationFilters,
  page: { limit: number; cursor?: ProjectEventCursor },
): Promise<AdminEvaluationListResponse> {
  const rows = await listProjectEvents({
    project: projectId,
    filters: toRepositoryFilters(filters),
    after: page.cursor,
    limit: page.limit + 1,
  });
  const items = rows.slice(0, page.limit);
  const jobs = groupJobs(await listJobsForEvents(items.map((row) => row.id)));
  const last = items[items.length - 1];
  return {
    items: items.map((row) => toSummary(row, jobs.get(row.id) ?? [])),
    nextCursor: rows.length > page.limit && last
      ? encodeAdminEvaluationCursor({ createdAt: last.createdAt, id: last.id })
      : null,
  };
}

function isPromptfooSummary(value: unknown): value is WorkflowEvaluationPromptfooSummary {
  if (value === null || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  const totals = summary.totals as Record<string, unknown> | undefined;
  return typeof summary.passed === 'boolean'
    && Array.isArray(summary.failures)
    && totals !== undefined && totals !== null
    && typeof totals.tests === 'number'
    && typeof totals.failed === 'number';
}

function labelFrom(list: readonly { key: string; label: string }[] | undefined, key: string, fallback: Map<string, string>): string {
  return list?.find((item) => item.key === key)?.label ?? fallback.get(key) ?? key;
}

export async function getAdminEvaluationEventDetail(
  projectId: string,
  eventId: string,
): Promise<AdminEvaluationEventDetail | null> {
  const record = await getEventWithJobs(projectId, eventId);
  if (!record) return null;
  const definition: WorkflowEvaluationDefinition | null = await getDefinitionById(record.definitionId);
  const rubric = definition?.rubric;
  const scale = rubric?.scale ?? WORKFLOW_EVALUATION_SCALE;
  const criterionKeys = rubric?.criteria.map((criterion) => criterion.key) ?? WORKFLOW_EVALUATION_CRITERIA_KEYS;
  const scores = record.criteriaScores as Record<string, number>;
  const judgeJob = record.jobs.find((job) => job.evaluatorKey === 'llm_judge');
  const promptfooJob = record.jobs.find((job) => job.evaluatorKey === 'promptfoo');
  const judgeOutput = judgeJob?.status === 'ready' && isWorkflowEvaluationJudgeOutput(judgeJob.summary)
    ? judgeJob.summary
    : null;
  const jobs: AdminEvaluationJob[] = record.jobs.map((job) => ({
    evaluatorKey: job.evaluatorKey,
    status: job.status,
    updatedAt: job.updatedAt,
    errorDetail: job.errorDetail,
  }));
  return {
    ...toSummary(record, record.jobs),
    outcomeLabel: labelFrom(rubric?.outcomes, record.outcome, OUTCOME_LABELS),
    criteria: criterionKeys.map((key) => {
      const score = scores[key] ?? 0;
      return {
        key,
        label: rubric?.criteria.find((criterion) => criterion.key === key)?.label ?? key,
        score,
        scaleLabel: scale.find((entry) => entry.score === score)?.label ?? '',
      };
    }),
    reasons: record.reasonCodes.map((key) => ({
      key,
      label: labelFrom(rubric?.reasonCodes, key, REASON_LABELS),
    })),
    comment: record.comment,
    hasCorrectedArtifact: record.correctedArtifactBlobRef != null || record.correctedArtifactText != null,
    artifactHash: record.artifactHash,
    lineage: {
      skillPath: record.skillPath,
      skillVersion: record.skillVersion,
      model: record.model,
      interviewId: record.interviewId,
      prdId: record.prdId,
    },
    jobs,
    judge: {
      output: judgeOutput,
      hasAppendix: judgeJob?.status === 'ready' && judgeJob.resultBlobRefs?.appendix != null,
    },
    promptfoo: promptfooJob && isPromptfooSummary(promptfooJob.summary) ? promptfooJob.summary : null,
    promptfooFailed: promptfooJob?.status === 'failed',
  };
}

export type JudgeAppendixResult =
  | { status: 'ok'; markdown: string }
  | { status: 'not_found' };

/** Throws when the Blob read fails; the route answers 502. */
export async function getAdminEvaluationJudgeAppendix(
  projectId: string,
  eventId: string,
): Promise<JudgeAppendixResult> {
  const record = await getEventWithJobs(projectId, eventId);
  const judge = record?.jobs.find((job) => job.evaluatorKey === 'llm_judge');
  const ref = judge?.status === 'ready' ? judge.resultBlobRefs?.appendix : undefined;
  if (!ref) return { status: 'not_found' };
  const body = await resolveArtifactContainerClient(ref.container)
    .getBlockBlobClient(ref.key)
    .downloadToBuffer();
  const markdown = body.subarray(0, APPENDIX_MAX_BYTES).toString('utf8');
  return { status: 'ok', markdown };
}

const CSV_HEADER = [
  'event_id', 'created_at', 'stage_key', 'subject_type', 'subject_id', 'phase_index', 'outcome',
  'score_intent_alignment', 'score_requirements_coverage', 'score_scope_alignment',
  'score_acceptance_criteria', 'score_readiness', 'criteria_average', 'reviewer_role',
  'artifact_hash', 'skill_path', 'skill_version', 'model', 'interview_id', 'prd_id',
  'promptfoo_status', 'judge_status',
] as const;

export type AdminEvaluationExport =
  | { status: 'ok'; filename: string; contentType: string; body: string; rowCount: number }
  | { status: 'too_many'; limit: number };

function exportFilename(projectId: string, format: AdminEvaluationExportFormat, now: Date): string {
  const safeProject = projectId.replace(/[^A-Za-z0-9._-]/g, '-');
  return `workflow-evaluations-${safeProject}-${now.toISOString().slice(0, 10)}.${format}`;
}

function blobNames(job: WorkflowEvaluationJob): Record<string, string> | null {
  if (!job.resultBlobRefs) return null;
  const names: Record<string, string> = {};
  if (job.resultBlobRefs.output) names.output = job.resultBlobRefs.output.key;
  if (job.resultBlobRefs.appendix) names.appendix = job.resultBlobRefs.appendix.key;
  return names;
}

export async function exportAdminEvaluationEvents(
  projectId: string,
  filters: AdminEvaluationFilters,
  format: AdminEvaluationExportFormat,
  userId: string,
  now: Date = new Date(),
): Promise<AdminEvaluationExport> {
  const rows = await listProjectEvents({
    project: projectId,
    filters: toRepositoryFilters(filters),
    limit: ADMIN_EVALUATION_EXPORT_MAX_ROWS + 1,
  });
  if (rows.length > ADMIN_EVALUATION_EXPORT_MAX_ROWS) {
    return { status: 'too_many', limit: ADMIN_EVALUATION_EXPORT_MAX_ROWS };
  }
  const jobs = groupJobs(await listJobsForEvents(rows.map((row) => row.id)));
  const filename = exportFilename(projectId, format, now);
  let body: string;
  let contentType: string;
  switch (format) {
    case 'json': {
      contentType = 'application/json; charset=utf-8';
      body = JSON.stringify({
        exportedAt: now.toISOString(),
        projectId,
        filters,
        events: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          stageKey: row.stageKey,
          definitionId: row.definitionId,
          definitionVersion: row.definitionVersion,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          phaseIndex: row.phaseIndex,
          outcome: row.outcome,
          criteria: row.criteriaScores,
          criteriaAverage: criteriaAverage(row),
          reasonCodes: row.reasonCodes,
          comment: row.comment,
          hasCorrectedArtifact: row.correctedArtifactBlobRef != null || row.correctedArtifactText != null,
          reviewerUserId: row.reviewerUserId,
          reviewerName: row.reviewerName,
          reviewerRoleKey: row.reviewerRoleKey,
          artifactHash: row.artifactHash,
          lineage: {
            skillPath: row.skillPath,
            skillVersion: row.skillVersion,
            model: row.model,
            interviewId: row.interviewId,
            prdId: row.prdId,
          },
          jobs: (jobs.get(row.id) ?? []).map((job) => ({
            evaluatorKey: job.evaluatorKey,
            status: job.status,
            runId: job.runId,
            specificationHash: job.specificationHash,
            summary: job.summary,
            resultBlobNames: blobNames(job),
            errorDetail: job.errorDetail,
            updatedAt: job.updatedAt,
          })),
        })),
      }, null, 2);
      break;
    }
    case 'csv': {
      contentType = 'text/csv; charset=utf-8';
      body = serializeCsv(CSV_HEADER, rows.map((row) => {
        const rowJobs = jobs.get(row.id) ?? [];
        const statusOf = (key: WorkflowEvaluationJobEvaluator) =>
          rowJobs.find((job) => job.evaluatorKey === key)?.status ?? '';
        const scores = row.criteriaScores;
        return [
          row.id, row.createdAt, row.stageKey, row.subjectType, row.subjectId, row.phaseIndex,
          row.outcome, scores.intent_alignment, scores.requirements_coverage, scores.scope_alignment,
          scores.acceptance_criteria, scores.readiness, criteriaAverage(row), row.reviewerRoleKey,
          row.artifactHash, row.skillPath, row.skillVersion, row.model, row.interviewId, row.prdId,
          statusOf('promptfoo'), statusOf('llm_judge'),
        ];
      }));
      break;
    }
    default: {
      const unhandled: never = format;
      throw new Error(`Unhandled export format: ${String(unhandled)}`);
    }
  }
  trackEvent('WorkflowEvaluationExported', { projectId, format, userId }, { rowCount: rows.length });
  return { status: 'ok', filename, contentType, body, rowCount: rows.length };
}
