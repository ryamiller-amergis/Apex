/**
 * Human workflow evaluation: validate a submission, resolve lineage, store one event.
 * Listeners run after the insert. A listener error never changes the stored event.
 */
import { randomUUID } from 'crypto';
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import type {
  CreateWorkflowEvaluationRequest,
  GetWorkflowEvaluationDefinitionsResponse,
  ListWorkflowEvaluationEventsResponse,
  WorkflowEvaluationCriteriaScores,
  WorkflowEvaluationDefinition,
  WorkflowEvaluationDefinitionView,
  WorkflowEvaluationEvent,
  WorkflowEvaluationEventDetail,
  WorkflowEvaluationLabeledValue,
  WorkflowEvaluationOutcome,
  WorkflowEvaluationReasonCode,
  WorkflowEvaluationReviewerRoleState,
  WorkflowEvaluationRubric,
  WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import { telemetryClient, trackEvent } from './telemetry';
import { getUserGroupNamesForProject } from './groupService';
import { resolveCurrentArtifactBinding } from './artifactBindingResolver';
import { WorkflowEvaluationError } from './workflowEvaluationError';
import {
  deleteCorrectedArtifact,
  writeCorrectedArtifact,
} from './workflowEvaluationArtifactStore';
import {
  getActiveDefinition,
  getEventWithJobs,
  getReviewerDisplayName,
  insertEvent,
  listActiveDefinitions,
  listEventsForSubject,
  type WorkflowEvaluationEventRecord,
} from './workflowEvaluationRepository';

export { WorkflowEvaluationError } from './workflowEvaluationError';

const LIST_CAP = 50;
const COMMENT_MAX_LENGTH = 4_000;
const CORRECTED_ARTIFACT_MAX_BYTES = 1024 * 1024;

const GROUP_ROLE_KEYS: Record<string, string> = {
  'Product-Owner': 'product_owner',
  BA: 'ba',
  Manager: 'manager',
  Developer: 'developer',
  QA: 'qa',
};

export type EventStoredListener = (event: WorkflowEvaluationEvent) => Promise<void>;

const eventStoredListeners: EventStoredListener[] = [];

export function registerEventStoredListener(listener: EventStoredListener): void {
  eventStoredListeners.push(listener);
}

/** Test seam. Production code does not call this. */
export function resetEventStoredListeners(): void {
  eventStoredListeners.length = 0;
}

export function subjectForStageKey(stageKey: string): {
  subjectType: WorkflowEvaluationSubjectType;
  phaseIndex: number | null;
} | null {
  const interview = /^interview_phase_([1-3])$/.exec(stageKey);
  if (interview) {
    return { subjectType: 'interview_phase', phaseIndex: Number(interview[1]) };
  }
  if (stageKey.startsWith('prd')) return { subjectType: 'prd', phaseIndex: null };
  return null;
}

function correctedArtifactOutcomes(subjectType: WorkflowEvaluationSubjectType): readonly string[] {
  return subjectType === 'prd' ? ['accept_after_edits'] : [];
}

function toDefinitionView(definition: WorkflowEvaluationDefinition): WorkflowEvaluationDefinitionView | null {
  const subject = subjectForStageKey(definition.stageKey);
  if (!subject) return null;
  const rubric = definition.rubric;
  return {
    id: definition.id,
    version: definition.version,
    processKey: definition.processKey,
    stageKey: definition.stageKey,
    subjectType: subject.subjectType,
    ...(subject.phaseIndex != null ? { phaseIndex: subject.phaseIndex } : {}),
    criteria: rubric.criteria,
    scale: rubric.scale,
    reasonCodes: rubric.reasonCodes,
    outcomes: rubric.outcomes,
    reviewerRoles: rubric.allowedReviewerRoles,
    minLowScoreCommentLength: rubric.minLowScoreCommentLength,
    correctedArtifactRequiredOutcomes: correctedArtifactOutcomes(subject.subjectType),
  };
}

function toEvent(record: WorkflowEvaluationEventRecord): WorkflowEvaluationEvent {
  return {
    id: record.id,
    projectId: record.project,
    processKey: record.processKey,
    stageKey: record.stageKey,
    definitionId: record.definitionId,
    definitionVersion: record.definitionVersion,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    phaseIndex: record.phaseIndex,
    reviewerUserId: record.reviewerUserId,
    reviewerName: record.reviewerName,
    reviewerRoleKey: record.reviewerRoleKey,
    reviewerRoleLabel: record.reviewerRoleLabel,
    lineage: {
      skillPath: record.skillPath,
      skillVersion: record.skillVersion,
      model: record.model,
      interviewId: record.interviewId,
      prdId: record.prdId,
    },
    artifactContentHash: record.artifactHash,
    criteria: record.criteriaScores,
    outcome: record.outcome,
    reasonCodes: record.reasonCodes,
    comment: record.comment,
    hasCorrectedArtifact: record.correctedArtifactBlobRef != null || record.correctedArtifactText != null,
    createdAt: record.createdAt,
  };
}

export async function describeReviewerRole(
  userId: string,
  project: string,
  roles: readonly WorkflowEvaluationLabeledValue[],
): Promise<WorkflowEvaluationReviewerRoleState> {
  const names = await getUserGroupNamesForProject(userId, project);
  const allowed = new Set(roles.map((role) => role.key));
  const matched = [...new Set(
    names
      .map((name) => GROUP_ROLE_KEYS[name])
      .filter((key): key is string => typeof key === 'string' && allowed.has(key)),
  )];
  const options = roles.map((role) => ({ key: role.key, label: role.label }));
  if (matched.length === 1) {
    return { derivedRoleKey: matched[0], options, requiresSelection: false };
  }
  return { derivedRoleKey: null, options, requiresSelection: true };
}

export async function listEvaluationDefinitions(
  project: string,
  userId: string,
  filter: { subjectType?: WorkflowEvaluationSubjectType; stageKey?: string } = {},
): Promise<GetWorkflowEvaluationDefinitionsResponse> {
  const definitions = (await listActiveDefinitions(filter.stageKey))
    .map(toDefinitionView)
    .filter((view): view is WorkflowEvaluationDefinitionView => view != null)
    .filter((view) => !filter.subjectType || view.subjectType === filter.subjectType);
  const roleSource = definitions[0]?.reviewerRoles ?? [];
  const reviewer = await describeReviewerRole(userId, project, roleSource);
  return { definitions, reviewer };
}

export async function listEvaluationEvents(
  project: string,
  query: {
    subjectType: WorkflowEvaluationSubjectType;
    subjectId: string;
    stageKey?: string;
    includeOlderVersions?: boolean;
  },
): Promise<ListWorkflowEvaluationEventsResponse> {
  const stage = query.stageKey ? subjectForStageKey(query.stageKey) : null;
  const phaseIndex = query.subjectType === 'interview_phase' ? (stage?.phaseIndex ?? null) : null;
  const canResolveCurrent = query.subjectType === 'prd' || phaseIndex != null;

  let currentArtifactHash: string | null = null;
  if (canResolveCurrent) {
    try {
      const binding = await resolveCurrentArtifactBinding({
        project,
        subjectType: query.subjectType,
        subjectId: query.subjectId,
        phaseIndex,
      });
      currentArtifactHash = binding.artifactHash;
    } catch (err) {
      if (err instanceof WorkflowEvaluationError && err.code === 'SUBJECT_NOT_FOUND') throw err;
      if (!query.includeOlderVersions) {
        return { events: [], truncated: false, currentArtifactHash: null };
      }
      currentArtifactHash = null;
    }
  } else {
    const { getInterviewEvaluationInputs } = await import('./interviewService');
    const interview = await getInterviewEvaluationInputs(query.subjectId);
    if (!interview || interview.project !== project) {
      throw new WorkflowEvaluationError('SUBJECT_NOT_FOUND', 'Subject was not found in this project.');
    }
  }

  const rows = await listEventsForSubject({
    project,
    subjectType: query.subjectType,
    subjectId: query.subjectId,
    stageKey: query.stageKey,
    artifactHash: !query.includeOlderVersions && currentArtifactHash ? currentArtifactHash : undefined,
    limit: LIST_CAP + 1,
  });
  return {
    events: rows.slice(0, LIST_CAP).map(toEvent),
    truncated: rows.length > LIST_CAP,
    currentArtifactHash,
  };
}

export async function getEvaluationEvent(
  project: string,
  eventId: string,
): Promise<WorkflowEvaluationEventDetail | null> {
  const record = await getEventWithJobs(project, eventId);
  if (!record) return null;
  return {
    ...toEvent(record),
    jobs: record.jobs.map((job) => ({
      evaluatorKey: job.evaluatorKey,
      status: job.status,
      summary: job.summary,
      errorDetail: job.errorDetail,
      updatedAt: job.updatedAt,
    })),
  };
}

export async function submitEvaluation(
  project: string,
  userId: string,
  request: CreateWorkflowEvaluationRequest,
): Promise<WorkflowEvaluationEvent> {
  const started = Date.now();
  try {
    const stored = await storeEvaluation(project, userId, request);
    const durationMs = Date.now() - started;
    trackEvent('WorkflowEvaluationSubmitted', {
      project,
      stageKey: stored.event.stageKey,
      outcome: stored.event.outcome,
      lowScoreCount: String(stored.lowScoreCount),
      hasCorrectedArtifact: String(stored.event.hasCorrectedArtifact),
      listenerFailures: String(stored.listenerFailures),
    });
    telemetryClient?.trackMetric({
      name: 'workflowEvaluation.submit.durationMs',
      value: durationMs,
    });
    return stored.event;
  } catch (err) {
    if (err instanceof WorkflowEvaluationError) {
      trackEvent('WorkflowEvaluationRejected', {
        project,
        stageKey: request.stageKey,
        code: err.code,
      });
      telemetryClient?.trackMetric({
        name: 'workflowEvaluation.submit.durationMs',
        value: Date.now() - started,
      });
    }
    throw err;
  }
}

type ArtifactPlan =
  | { kind: 'none' }
  | { kind: 'pasted'; text: string }
  | { kind: 'current_prd' };

async function storeEvaluation(
  project: string,
  userId: string,
  request: CreateWorkflowEvaluationRequest,
): Promise<{ event: WorkflowEvaluationEvent; listenerFailures: number; lowScoreCount: number }> {
  const definition = await getActiveDefinition(request.stageKey);
  if (!definition) {
    throw new WorkflowEvaluationError('UNKNOWN_STAGE', 'No active evaluation definition matches that stage.');
  }
  const stageSubject = subjectForStageKey(definition.stageKey);
  if (!stageSubject || stageSubject.subjectType !== request.subjectType) {
    throw new WorkflowEvaluationError(
      'SUBJECT_STAGE_MISMATCH',
      'That stage does not apply to this subject.',
    );
  }

  const criteria = assertScores(request.criteria, definition.rubric);
  const outcome = assertOutcome(request.outcome, definition.rubric);
  const reasonCodes = assertReasonCodes(request.reasonCodes, criteria, definition.rubric);
  const comment = assertComment(request.comment, criteria, definition.rubric);
  const artifactPlan = planCorrectedArtifact(request, stageSubject.subjectType, outcome);

  const binding = await resolveCurrentArtifactBinding({
    project,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    phaseIndex: stageSubject.phaseIndex,
  });
  const artifactText = artifactTextFromPlan(artifactPlan, binding.prdMarkdown);

  const role = await resolveReviewerRole(userId, project, request.reviewerRole, definition.rubric);
  const eventId = randomUUID();
  let blobRef: AiRunBlobRef | null = null;
  if (artifactText != null) {
    try {
      blobRef = await writeCorrectedArtifact(project, eventId, artifactText);
    } catch (err) {
      console.error('[workflow-evaluation] corrected artifact write failed', err);
      throw new WorkflowEvaluationError(
        'ARTIFACT_STORAGE_UNAVAILABLE',
        'Corrected artifact storage is unavailable.',
      );
    }
  }

  let record: WorkflowEvaluationEventRecord;
  try {
    const reviewerName = await getReviewerDisplayName(userId);
    record = await insertEvent({
      id: eventId,
      project,
      definitionId: definition.id,
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      stageKey: definition.stageKey,
      phaseIndex: stageSubject.phaseIndex,
      reviewerUserId: userId,
      reviewerRoleKey: role.key,
      reviewerRoleLabel: role.label,
      skillPath: binding.lineage.skillPath,
      skillVersion: binding.lineage.skillVersion,
      model: binding.lineage.model,
      interviewId: binding.lineage.interviewId,
      prdId: binding.lineage.prdId,
      artifactHash: binding.artifactHash,
      criteriaScores: criteria,
      outcome,
      reasonCodes,
      comment,
      correctedArtifactBlobRef: blobRef,
    });
    if (!record.reviewerName && reviewerName) {
      record = { ...record, reviewerName };
    }
  } catch (err) {
    if (blobRef) {
      try {
        await deleteCorrectedArtifact(blobRef);
      } catch (cleanupErr) {
        console.error('[workflow-evaluation] orphan artifact cleanup failed', cleanupErr);
      }
    }
    throw err;
  }

  const event = toEvent(record);
  const results = await Promise.allSettled(eventStoredListeners.map((listener) => listener(event)));
  let listenerFailures = 0;
  for (const result of results) {
    if (result.status === 'rejected') {
      listenerFailures += 1;
      console.error('[workflow-evaluation] event listener failed', result.reason);
    }
  }
  const lowScoreCount = Object.values(criteria).filter(
    (score) => score <= definition.rubric.lowScoreThreshold,
  ).length;
  return { event, listenerFailures, lowScoreCount };
}

function assertScores(value: unknown, rubric: WorkflowEvaluationRubric): WorkflowEvaluationCriteriaScores {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowEvaluationError(
      'INVALID_SCORES',
      'Scores must include each criterion as an integer from 1 to 5.',
    );
  }
  const record = value as Record<string, unknown>;
  const expected = rubric.criteria.map((criterion) => criterion.key);
  const keys = Object.keys(record);
  const sameKeys = keys.length === expected.length && expected.every((key) => keys.includes(key));
  if (!sameKeys) {
    throw new WorkflowEvaluationError(
      'INVALID_SCORES',
      'Scores must include each criterion as an integer from 1 to 5.',
    );
  }
  for (const key of expected) {
    const score = record[key];
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      throw new WorkflowEvaluationError(
        'INVALID_SCORES',
        'Scores must include each criterion as an integer from 1 to 5.',
      );
    }
  }
  return record as WorkflowEvaluationCriteriaScores;
}

function assertOutcome(value: unknown, rubric: WorkflowEvaluationRubric): WorkflowEvaluationOutcome {
  const allowed = new Set(rubric.outcomes.map((outcome) => outcome.key));
  if (typeof value !== 'string' || !allowed.has(value as WorkflowEvaluationOutcome)) {
    throw new WorkflowEvaluationError('INVALID_OUTCOME', 'Outcome is not one of the stage outcomes.');
  }
  return value as WorkflowEvaluationOutcome;
}

function assertReasonCodes(
  value: readonly string[] | undefined,
  criteria: WorkflowEvaluationCriteriaScores,
  rubric: WorkflowEvaluationRubric,
): WorkflowEvaluationReasonCode[] {
  const codes = value ?? [];
  if (!Array.isArray(codes)) {
    throw new WorkflowEvaluationError('REASON_REQUIRED', 'Reason codes must be chosen from the stage list.');
  }
  const allowed = new Set(rubric.reasonCodes.map((reason) => reason.key));
  if (codes.some((code) => typeof code !== 'string' || !allowed.has(code as WorkflowEvaluationReasonCode))) {
    throw new WorkflowEvaluationError('REASON_REQUIRED', 'Reason codes must be chosen from the stage list.');
  }
  const threshold = rubric.lowScoreThreshold;
  const needsReason = Object.values(criteria).some((score) => score <= threshold);
  if (needsReason && codes.length === 0) {
    throw new WorkflowEvaluationError(
      'REASON_REQUIRED',
      'A score of 2 or lower needs a reason.',
    );
  }
  return codes as WorkflowEvaluationReasonCode[];
}

function assertComment(
  value: string | undefined,
  criteria: WorkflowEvaluationCriteriaScores,
  rubric: WorkflowEvaluationRubric,
): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length > COMMENT_MAX_LENGTH) {
    throw new WorkflowEvaluationError('COMMENT_TOO_LONG', 'Comment is longer than 4000 characters.');
  }
  const threshold = rubric.lowScoreThreshold;
  const needsComment = Object.values(criteria).some((score) => score <= threshold);
  if (needsComment && trimmed.length < rubric.minLowScoreCommentLength) {
    throw new WorkflowEvaluationError(
      'COMMENT_TOO_SHORT',
      `A score of 2 or lower needs a comment of at least ${rubric.minLowScoreCommentLength} characters.`,
    );
  }
  return trimmed.length > 0 ? trimmed : null;
}

function planCorrectedArtifact(
  request: CreateWorkflowEvaluationRequest,
  subjectType: WorkflowEvaluationSubjectType,
  outcome: WorkflowEvaluationOutcome,
): ArtifactPlan {
  const artifact = request.correctedArtifact;
  const required = correctedArtifactOutcomes(subjectType).includes(outcome);
  if (!artifact) {
    if (required) {
      throw new WorkflowEvaluationError(
        'CORRECTED_ARTIFACT_REQUIRED',
        'Accept after edits needs the corrected PRD.',
      );
    }
    return { kind: 'none' };
  }
  if (artifact.source !== 'current_prd' && artifact.source !== 'pasted') {
    throw new WorkflowEvaluationError(
      'CORRECTED_ARTIFACT_REQUIRED',
      'Corrected artifact source must be current_prd or pasted.',
    );
  }
  if (subjectType === 'interview_phase' && artifact.source === 'current_prd') {
    throw new WorkflowEvaluationError(
      'CORRECTED_ARTIFACT_REQUIRED',
      'Interview phases accept only pasted corrected text.',
    );
  }
  if (artifact.source === 'pasted') {
    const text = artifact.text ?? '';
    if (!text.trim()) {
      if (required) {
        throw new WorkflowEvaluationError(
          'CORRECTED_ARTIFACT_REQUIRED',
          'Accept after edits needs the corrected PRD.',
        );
      }
      return { kind: 'none' };
    }
    assertArtifactSize(text);
    return { kind: 'pasted', text };
  }
  return { kind: 'current_prd' };
}

function artifactTextFromPlan(plan: ArtifactPlan, prdMarkdown: string | null): string | null {
  if (plan.kind === 'none') return null;
  if (plan.kind === 'pasted') return plan.text;
  const text = prdMarkdown ?? '';
  if (!text.trim()) {
    throw new WorkflowEvaluationError(
      'CORRECTED_ARTIFACT_REQUIRED',
      'Accept after edits needs the corrected PRD.',
    );
  }
  assertArtifactSize(text);
  return text;
}

function assertArtifactSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > CORRECTED_ARTIFACT_MAX_BYTES) {
    throw new WorkflowEvaluationError(
      'CORRECTED_ARTIFACT_TOO_LARGE',
      'Corrected artifact is larger than 1 MiB.',
    );
  }
}

async function resolveReviewerRole(
  userId: string,
  project: string,
  requested: string | undefined,
  rubric: WorkflowEvaluationRubric,
): Promise<{ key: string; label: string }> {
  const described = await describeReviewerRole(userId, project, rubric.allowedReviewerRoles);
  let key = described.derivedRoleKey;
  if (key) {
    if (requested && requested !== key) {
      throw new WorkflowEvaluationError(
        'ROLE_NOT_ALLOWED',
        'Reviewer role does not match the role derived from project groups.',
      );
    }
  } else if (!requested) {
    throw new WorkflowEvaluationError('ROLE_REQUIRED', 'Choose a reviewer role.');
  } else if (!described.options.some((option) => option.key === requested)) {
    throw new WorkflowEvaluationError('ROLE_NOT_ALLOWED', 'Reviewer role is not in the stage list.');
  } else {
    key = requested;
  }
  const match = described.options.find((option) => option.key === key);
  return { key: key ?? '', label: match?.label ?? key ?? '' };
}
