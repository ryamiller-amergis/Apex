import { z } from 'zod';
import {
  WORKFLOW_EVALUATION_ERROR_CODES,
  WORKFLOW_EVALUATION_LOW_SCORE_THRESHOLD,
  type CreateWorkflowEvaluationRequest,
  type WorkflowEvaluationCriteriaScores,
  type WorkflowEvaluationDefinitionView,
  type WorkflowEvaluationErrorCode,
  type WorkflowEvaluationOutcome,
} from '../../shared/types/workflowEvaluation';

export type CorrectedArtifactSource = 'current_prd' | 'pasted';

export type QualityFeedbackFormValues = {
  /** Radio values: '' until chosen, then '1'..'5'. */
  criteria: Record<string, string>;
  outcome: string;
  reasonCodes: string[];
  comment: string;
  reviewerRole: string;
  correctedSource: CorrectedArtifactSource;
  correctedText: string;
};

export type QualityFeedbackFieldName =
  | 'criteria'
  | 'outcome'
  | 'reasonCodes'
  | 'comment'
  | 'reviewerRole'
  | 'correctedText';

export type QualityFeedbackSchemaOptions = {
  requiresRole: boolean;
  /** The surface can send its current artifact instead of pasted text. */
  snapshotAvailable: boolean;
};

export function hasLowScore(criteria: Record<string, string>): boolean {
  return Object.values(criteria).some((value) => {
    const score = Number(value);
    return value !== '' && score <= WORKFLOW_EVALUATION_LOW_SCORE_THRESHOLD;
  });
}

export function needsCorrectedArtifact(
  definition: WorkflowEvaluationDefinitionView,
  outcome: string,
): boolean {
  return definition.correctedArtifactRequiredOutcomes.includes(outcome);
}

export function defaultQualityFeedbackValues(
  definition: WorkflowEvaluationDefinitionView,
  options: { derivedRoleKey: string | null; snapshotAvailable: boolean },
): QualityFeedbackFormValues {
  return {
    criteria: Object.fromEntries(definition.criteria.map((criterion) => [criterion.key, ''])),
    outcome: '',
    reasonCodes: [],
    comment: '',
    reviewerRole: options.derivedRoleKey ?? '',
    correctedSource: options.snapshotAvailable ? 'current_prd' : 'pasted',
    correctedText: '',
  };
}

export function buildQualityFeedbackSchema(
  definition: WorkflowEvaluationDefinitionView,
  options: QualityFeedbackSchemaOptions,
) {
  const criteriaShape = Object.fromEntries(
    definition.criteria.map((criterion) => [
      criterion.key,
      z.string().regex(/^[1-5]$/, `Choose a score for ${criterion.label}`),
    ]),
  );
  const outcomeKeys = new Set(definition.outcomes.map((outcome) => outcome.key));
  const reasonKeys = new Set(definition.reasonCodes.map((reason) => reason.key));
  const roleKeys = new Set(definition.reviewerRoles.map((role) => role.key));
  const minComment = definition.minLowScoreCommentLength;

  return z
    .object({
      criteria: z.object(criteriaShape),
      outcome: z.string().refine((value) => outcomeKeys.has(value), 'Choose an outcome'),
      reasonCodes: z.array(z.string()),
      comment: z.string().max(4_000, 'Comment must be 4,000 characters or fewer'),
      reviewerRole: z.string(),
      correctedSource: z.enum(['current_prd', 'pasted']),
      correctedText: z.string(),
    })
    .superRefine((values, ctx) => {
      if (hasLowScore(values.criteria)) {
        const chosen = values.reasonCodes.filter((code) => reasonKeys.has(code));
        if (chosen.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['reasonCodes'],
            message: 'Choose at least one reason for a score of 2 or lower',
          });
        }
        if (values.comment.trim().length < minComment) {
          ctx.addIssue({
            code: 'custom',
            path: ['comment'],
            message: `A score of 2 or lower needs a comment of at least ${minComment} characters`,
          });
        }
      }
      if (options.requiresRole && !roleKeys.has(values.reviewerRole)) {
        ctx.addIssue({ code: 'custom', path: ['reviewerRole'], message: 'Choose your reviewer role' });
      }
      if (needsCorrectedArtifact(definition, values.outcome)) {
        const usesSnapshot = values.correctedSource === 'current_prd' && options.snapshotAvailable;
        if (!usesSnapshot && values.correctedText.trim() === '') {
          ctx.addIssue({
            code: 'custom',
            path: ['correctedText'],
            message: 'Paste the corrected version, or use the current one in Apex',
          });
        }
      }
    });
}

export function toCreateRequest(
  values: QualityFeedbackFormValues,
  context: {
    definition: WorkflowEvaluationDefinitionView;
    subjectId: string;
    requiresRole: boolean;
    snapshotAvailable: boolean;
  },
): CreateWorkflowEvaluationRequest {
  const { definition } = context;
  const criteria = Object.fromEntries(
    Object.entries(values.criteria).map(([key, value]) => [key, Number(value)]),
  ) as WorkflowEvaluationCriteriaScores;
  const low = hasLowScore(values.criteria);
  const comment = values.comment.trim();
  const request: CreateWorkflowEvaluationRequest = {
    subjectType: definition.subjectType,
    subjectId: context.subjectId,
    stageKey: definition.stageKey,
    criteria,
    outcome: values.outcome as WorkflowEvaluationOutcome,
    reasonCodes: low ? values.reasonCodes : [],
  };
  if (comment) request.comment = comment;
  if (context.requiresRole) request.reviewerRole = values.reviewerRole;
  if (needsCorrectedArtifact(definition, values.outcome)) {
    request.correctedArtifact = values.correctedSource === 'current_prd' && context.snapshotAvailable
      ? { source: 'current_prd' }
      : { source: 'pasted', text: values.correctedText };
  }
  return request;
}

/** The server answers with an error code; this names the form field it belongs to. */
export function fieldForErrorCode(value: string | undefined): QualityFeedbackFieldName | null {
  if (!value || !(WORKFLOW_EVALUATION_ERROR_CODES as readonly string[]).includes(value)) return null;
  const code = value as WorkflowEvaluationErrorCode;
  switch (code) {
    case 'INVALID_SCORES':
      return 'criteria';
    case 'INVALID_OUTCOME':
      return 'outcome';
    case 'REASON_REQUIRED':
      return 'reasonCodes';
    case 'COMMENT_TOO_SHORT':
    case 'COMMENT_TOO_LONG':
      return 'comment';
    case 'ROLE_REQUIRED':
    case 'ROLE_NOT_ALLOWED':
      return 'reviewerRole';
    case 'CORRECTED_ARTIFACT_REQUIRED':
    case 'CORRECTED_ARTIFACT_TOO_LARGE':
      return 'correctedText';
    case 'UNKNOWN_FIELD':
    case 'UNKNOWN_STAGE':
    case 'SUBJECT_STAGE_MISMATCH':
    case 'PHASE_NOT_STARTED':
    case 'ARTIFACT_NOT_READY':
    case 'SUBJECT_NOT_FOUND':
    case 'ARTIFACT_STORAGE_UNAVAILABLE':
      return null;
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled evaluation error code: ${String(unhandled)}`);
    }
  }
}
