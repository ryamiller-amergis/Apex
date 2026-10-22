import {
  WORKFLOW_EVALUATION_OUTCOMES,
  WORKFLOW_EVALUATION_REASON_CODES,
  WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS,
  WORKFLOW_EVALUATION_SUBJECT_TYPES,
  type WorkflowEvaluationOutcome,
  type WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import {
  ADMIN_EVALUATION_SEARCH_MAX_LENGTH,
  type AdminEvaluationFilters,
} from '../../shared/types/workflowEvaluationAdmin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILTER_KEYS = ['outcome', 'stage', 'reason', 'subjectType', 'from', 'to', 'q', 'eventId'] as const;

function listed<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return value !== null && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

function validDate(value: string | null): string | undefined {
  if (!value || !DATE_RE.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : undefined;
}

/** Unknown or malformed values are dropped, so a stale link still opens. */
export function parseWorkflowEvaluationFilters(params: URLSearchParams): AdminEvaluationFilters {
  const filters: AdminEvaluationFilters = {};
  const outcome = listed<WorkflowEvaluationOutcome>(WORKFLOW_EVALUATION_OUTCOMES, params.get('outcome'));
  if (outcome) filters.outcome = outcome;
  const stage = listed(WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS, params.get('stage'));
  if (stage) filters.stage = stage;
  const reason = listed(WORKFLOW_EVALUATION_REASON_CODES, params.get('reason'));
  if (reason) filters.reason = reason;
  const subjectType = listed<WorkflowEvaluationSubjectType>(WORKFLOW_EVALUATION_SUBJECT_TYPES, params.get('subjectType'));
  if (subjectType) filters.subjectType = subjectType;
  const from = validDate(params.get('from'));
  if (from) filters.from = from;
  const to = validDate(params.get('to'));
  if (to) filters.to = to;
  const q = params.get('q')?.trim().slice(0, ADMIN_EVALUATION_SEARCH_MAX_LENGTH);
  if (q) filters.q = q;
  const eventId = params.get('eventId');
  if (eventId && UUID_RE.test(eventId)) filters.eventId = eventId;
  return filters;
}

/** Writes filters into `params`, keeping unrelated keys such as `drawer`. */
export function writeWorkflowEvaluationFilters(
  params: URLSearchParams,
  filters: AdminEvaluationFilters,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

export function filtersToQuery(filters: AdminEvaluationFilters): URLSearchParams {
  return writeWorkflowEvaluationFilters(new URLSearchParams(), filters);
}

export function isDateRangeInvalid(filters: AdminEvaluationFilters): boolean {
  return Boolean(filters.from && filters.to && filters.from > filters.to);
}

export function hasActiveFilters(filters: AdminEvaluationFilters): boolean {
  return FILTER_KEYS.some((key) => Boolean(filters[key]));
}
