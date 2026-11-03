/**
 * TBI-003 — shared evaluation contracts.
 * Covers DoD-1, DoD-2, VT-16, VT-17, VT-18 and VT-19.
 * VT-19 is a compile error on each forbidden field. ts-jest diagnostics are off;
 * `tsc -p tsconfig.server.json` is what fails if a @ts-expect-error becomes unused.
 */
import { toJSONSchema } from 'zod';
import {
  WORKFLOW_EVALUATION_JOB_STATUSES,
  WORKFLOW_EVALUATION_OUTCOMES,
  WORKFLOW_EVALUATION_REASON_CODES,
  isWorkflowEvaluationCriteriaScores,
  isWorkflowEvaluationJobStatus,
  isWorkflowEvaluationJudgeOutput,
  isWorkflowEvaluationOutcome,
  isWorkflowEvaluationReasonCode,
  workflowEvaluationJudgeOutputSchema,
  type CreateHumanEvaluationRequest,
  type WorkflowEvaluationJudgeOutput,
} from '../../shared/types/workflowEvaluation';

const validCriteria = {
  intent_alignment: 5,
  requirements_coverage: 4,
  scope_alignment: 3,
  acceptance_criteria: 2,
  readiness: 1,
} as const;

function judgeOutput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    missedRequirements: [],
    inventedRequirements: [],
    recommendedImprovements: [],
    confidence: 'medium',
    ...overrides,
  };
}

/**
 * Each assignment must be a type error. If a lineage or hash field is added to
 * CreateHumanEvaluationRequest, the matching @ts-expect-error becomes unused
 * and the server type-check fails.
 */
function createRequestRejectsLineageAndHash(): CreateHumanEvaluationRequest {
  const request: CreateHumanEvaluationRequest = {
    subjectType: 'prd',
    subjectId: '00000000-0000-4000-8000-000000000001',
    stageKey: 'prd_human_review',
    criteria: validCriteria,
    outcome: 'accept_unchanged',
    reasonCodes: [],
  };

  // @ts-expect-error VT-19 skillPath is excluded from CreateHumanEvaluationRequest
  request.skillPath = '.cursor/skills/to-prd/SKILL.md';
  // @ts-expect-error VT-19 skillVersion is excluded from CreateHumanEvaluationRequest
  request.skillVersion = 'f1fe8d46ed081e310bdb95b66063a80cd987e243';
  // @ts-expect-error VT-19 model is excluded from CreateHumanEvaluationRequest
  request.model = 'claude';
  // @ts-expect-error VT-19 interviewId is excluded from CreateHumanEvaluationRequest
  request.interviewId = '00000000-0000-4000-8000-000000000002';
  // @ts-expect-error VT-19 prdId is excluded from CreateHumanEvaluationRequest
  request.prdId = '00000000-0000-4000-8000-000000000003';
  // @ts-expect-error VT-19 artifactHash is excluded from CreateHumanEvaluationRequest
  request.artifactHash = 'a'.repeat(64);

  return request;
}

describe('TBI-003 — workflow evaluation shared types', () => {
  it('DoD-2 / VT-16 a sample judge output matches the zod schema used for the seed', () => {
    const sample: WorkflowEvaluationJudgeOutput = {
      missedRequirements: [{ description: 'No out-of-scope note', evidence: 'Scope section' }],
      inventedRequirements: [],
      alignmentScore: 4,
      recommendedImprovements: [{ text: 'Name the pilot projects', criterion: 'scope_alignment' }],
      confidence: 'high',
    };
    expect(isWorkflowEvaluationJudgeOutput(sample)).toBe(true);
    expect(workflowEvaluationJudgeOutputSchema.safeParse(sample).success).toBe(true);
    expect(toJSONSchema(workflowEvaluationJudgeOutputSchema)).toMatchObject({
      type: 'object',
      required: [
        'missedRequirements',
        'inventedRequirements',
        'recommendedImprovements',
        'confidence',
      ],
    });
  });

  it('VT-17 / AC-b rejects a missing confidence, an alignment score of 7, and a non-array finding list', () => {
    const missingConfidence = judgeOutput();
    delete missingConfidence.confidence;
    expect(isWorkflowEvaluationJudgeOutput(missingConfidence)).toBe(false);

    expect(isWorkflowEvaluationJudgeOutput(judgeOutput({ alignmentScore: 7 }))).toBe(false);
    expect(
      isWorkflowEvaluationJudgeOutput(judgeOutput({ missedRequirements: 'not-a-list' })),
    ).toBe(false);
    expect(workflowEvaluationJudgeOutputSchema.safeParse(missingConfidence).success).toBe(false);
  });

  it('VT-18 / AC-c accepts empty findings and scores 1 and 5, and rejects 0 and 6', () => {
    expect(isWorkflowEvaluationJudgeOutput(judgeOutput())).toBe(true);
    expect(isWorkflowEvaluationJudgeOutput(judgeOutput({ alignmentScore: 1 }))).toBe(true);
    expect(isWorkflowEvaluationJudgeOutput(judgeOutput({ alignmentScore: 5 }))).toBe(true);
    expect(isWorkflowEvaluationJudgeOutput(judgeOutput({ alignmentScore: 0 }))).toBe(false);
    expect(isWorkflowEvaluationJudgeOutput(judgeOutput({ alignmentScore: 6 }))).toBe(false);
  });

  it('DoD-1 / VT-19 create request type excludes lineage and artifact hash', () => {
    // The function body assigns each forbidden field under @ts-expect-error.
    // Executing it would set those properties at runtime; the server type-check
    // is the assertion. Referencing the function keeps the body in this module.
    expect(createRequestRejectsLineageAndHash).toEqual(expect.any(Function));
    const request: CreateHumanEvaluationRequest = {
      subjectType: 'prd',
      subjectId: '00000000-0000-4000-8000-000000000001',
      stageKey: 'prd_human_review',
      criteria: validCriteria,
      outcome: 'accept_unchanged',
      reasonCodes: [],
    };
    expect(Object.keys(request)).toEqual([
      'subjectType',
      'subjectId',
      'stageKey',
      'criteria',
      'outcome',
      'reasonCodes',
    ]);
  });

  it('guards accept only the closed outcome, reason and job-status vocabularies', () => {
    expect(WORKFLOW_EVALUATION_OUTCOMES).toEqual([
      'accept_unchanged',
      'accept_after_edits',
      'regenerate',
      'reject',
    ]);
    expect(isWorkflowEvaluationOutcome('regenerate')).toBe(true);
    expect(isWorkflowEvaluationOutcome('approve')).toBe(false);
    expect(isWorkflowEvaluationReasonCode('too_vague')).toBe(true);
    expect(isWorkflowEvaluationReasonCode('other')).toBe(false);
    expect(WORKFLOW_EVALUATION_REASON_CODES).toHaveLength(7);
    expect(isWorkflowEvaluationJobStatus('ready')).toBe(true);
    expect(isWorkflowEvaluationJobStatus('queued')).toBe(false);
    expect(WORKFLOW_EVALUATION_JOB_STATUSES).toEqual(['pending', 'running', 'ready', 'failed']);
    expect(isWorkflowEvaluationCriteriaScores(validCriteria)).toBe(true);
    expect(isWorkflowEvaluationCriteriaScores({ ...validCriteria, extra: 3 })).toBe(false);
    expect(isWorkflowEvaluationCriteriaScores({ ...validCriteria, readiness: 0 })).toBe(false);
  });
});
