import {
  buildQualityFeedbackSchema,
  defaultQualityFeedbackValues,
  fieldForErrorCode,
  toCreateRequest,
  type QualityFeedbackFormValues,
} from '../qualityFeedbackSchema';
import {
  WORKFLOW_EVALUATION_PRD_RUBRIC,
  type WorkflowEvaluationDefinitionView,
} from '../../../shared/types/workflowEvaluation';

const definition: WorkflowEvaluationDefinitionView = {
  id: 'def-1',
  version: 1,
  processKey: 'orchestrated_workflow',
  stageKey: 'prd_human_review',
  subjectType: 'prd',
  criteria: WORKFLOW_EVALUATION_PRD_RUBRIC.criteria,
  scale: WORKFLOW_EVALUATION_PRD_RUBRIC.scale,
  reasonCodes: WORKFLOW_EVALUATION_PRD_RUBRIC.reasonCodes,
  outcomes: WORKFLOW_EVALUATION_PRD_RUBRIC.outcomes,
  reviewerRoles: WORKFLOW_EVALUATION_PRD_RUBRIC.allowedReviewerRoles,
  minLowScoreCommentLength: 20,
  correctedArtifactRequiredOutcomes: ['accept_after_edits'],
};

function values(overrides: Partial<QualityFeedbackFormValues> = {}): QualityFeedbackFormValues {
  return {
    ...defaultQualityFeedbackValues(definition, { derivedRoleKey: 'product_owner', snapshotAvailable: true }),
    criteria: {
      intent_alignment: '4',
      requirements_coverage: '4',
      scope_alignment: '4',
      acceptance_criteria: '4',
      readiness: '4',
    },
    outcome: 'accept_unchanged',
    ...overrides,
  };
}

function issues(input: QualityFeedbackFormValues, options = { requiresRole: false, snapshotAvailable: true }) {
  const result = buildQualityFeedbackSchema(definition, options).safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('buildQualityFeedbackSchema', () => {
  it('accepts a complete high-score submission', () => {
    expect(issues(values())).toEqual([]);
  });

  it('requires every criterion and an outcome', () => {
    const empty = defaultQualityFeedbackValues(definition, { derivedRoleKey: 'ba', snapshotAvailable: true });
    expect(issues(empty)).toEqual(expect.arrayContaining(['criteria.intent_alignment', 'criteria.readiness', 'outcome']));
  });

  it('requires a reason and a 20-character comment when any score is 2 or lower', () => {
    const low = values({ criteria: { ...values().criteria, readiness: '2' }, comment: 'too short' });
    expect(issues(low)).toEqual(['reasonCodes', 'comment']);
    expect(issues({ ...low, reasonCodes: ['too_vague'], comment: 'x'.repeat(20) })).toEqual([]);
  });

  it('requires a role only when the reviewer must choose', () => {
    expect(issues(values({ reviewerRole: '' }), { requiresRole: true, snapshotAvailable: true })).toEqual(['reviewerRole']);
    expect(issues(values({ reviewerRole: '' }))).toEqual([]);
  });

  it('requires pasted text for accept after edits unless the snapshot is used', () => {
    expect(issues(values({ outcome: 'accept_after_edits', correctedSource: 'current_prd' }))).toEqual([]);
    expect(issues(values({ outcome: 'accept_after_edits', correctedSource: 'pasted' }))).toEqual(['correctedText']);
    expect(issues(values({ outcome: 'accept_after_edits' }), { requiresRole: false, snapshotAvailable: false }))
      .toEqual(['correctedText']);
  });
});

describe('toCreateRequest', () => {
  const context = { definition, subjectId: 'prd-1', requiresRole: false, snapshotAvailable: true };

  it('sends numbers and drops reasons when no score is low', () => {
    const request = toCreateRequest(values({ reasonCodes: ['too_vague'], comment: '  ' }), context);
    expect(request).toEqual({
      subjectType: 'prd',
      subjectId: 'prd-1',
      stageKey: 'prd_human_review',
      criteria: { intent_alignment: 4, requirements_coverage: 4, scope_alignment: 4, acceptance_criteria: 4, readiness: 4 },
      outcome: 'accept_unchanged',
      reasonCodes: [],
    });
  });

  it('sends the snapshot source or pasted text for accept after edits', () => {
    expect(toCreateRequest(values({ outcome: 'accept_after_edits' }), context).correctedArtifact)
      .toEqual({ source: 'current_prd' });
    expect(toCreateRequest(values({ outcome: 'accept_after_edits', correctedSource: 'pasted', correctedText: '# Fixed' }), context)
      .correctedArtifact).toEqual({ source: 'pasted', text: '# Fixed' });
  });

  it('sends the role only when the reviewer chose one', () => {
    expect(toCreateRequest(values({ reviewerRole: 'qa' }), { ...context, requiresRole: true }).reviewerRole).toBe('qa');
    expect(toCreateRequest(values(), context)).not.toHaveProperty('reviewerRole');
  });
});

describe('fieldForErrorCode', () => {
  it.each([
    ['REASON_REQUIRED', 'reasonCodes'],
    ['COMMENT_TOO_SHORT', 'comment'],
    ['ROLE_REQUIRED', 'reviewerRole'],
    ['CORRECTED_ARTIFACT_REQUIRED', 'correctedText'],
    ['INVALID_SCORES', 'criteria'],
    ['ARTIFACT_NOT_READY', null],
    ['SOMETHING_NEW', null],
    [undefined, null],
  ])('maps %s to %s', (code, field) => {
    expect(fieldForErrorCode(code)).toBe(field);
  });
});
