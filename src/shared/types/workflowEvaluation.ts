/**
 * Shared contracts for human workflow evaluation.
 *
 * FEAT-001 stores these shapes only. Submission rules, lineage resolution and
 * artifact hashing belong to the evaluation service (FEAT-003).
 */
import { z } from 'zod';
import type { AiRunBlobRef } from './aiRunV2';

export const WORKFLOW_EVALUATION_PROCESS_KEY = 'orchestrated_workflow' as const;
export const WORKFLOW_EVALUATION_DEFINITION_EVALUATOR_KEY = 'human_review' as const;
export const WORKFLOW_EVALUATION_BENCHMARK_KEY = 'baseline' as const;

/** Stages seeded by the first seed migration. */
export const WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS = [
  'prd_human_review',
  'interview_phase_1',
  'interview_phase_2',
  'interview_phase_3',
] as const;
export const WORKFLOW_EVALUATION_PRD_STAGE_KEY = 'prd_human_review' as const;
export const WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY = 'design_doc_human_review' as const;
export const WORKFLOW_EVALUATION_TEST_CASES_STAGE_KEY = 'test_cases_human_review' as const;
export type WorkflowEvaluationSeededStageKey =
  (typeof WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS)[number];

/** Every stage with a seeded definition, in display order. */
export const WORKFLOW_EVALUATION_STAGE_KEYS = [
  ...WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS,
  WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY,
  WORKFLOW_EVALUATION_TEST_CASES_STAGE_KEY,
] as const;
export type WorkflowEvaluationStageKey = (typeof WORKFLOW_EVALUATION_STAGE_KEYS)[number];

export const WORKFLOW_EVALUATION_OUTCOMES = [
  'accept_unchanged',
  'accept_after_edits',
  'regenerate',
  'reject',
] as const;
export type WorkflowEvaluationOutcome = (typeof WORKFLOW_EVALUATION_OUTCOMES)[number];

export const WORKFLOW_EVALUATION_CRITERIA_KEYS = [
  'intent_alignment',
  'requirements_coverage',
  'scope_alignment',
  'acceptance_criteria',
  'readiness',
] as const;
export type WorkflowEvaluationCriteriaKey =
  (typeof WORKFLOW_EVALUATION_CRITERIA_KEYS)[number];

export const WORKFLOW_EVALUATION_REASON_CODES = [
  'missing_requirement',
  'invented_requirement',
  'incorrect_interpretation',
  'too_vague',
  'wrong_scope',
  'acceptance_criteria_not_testable',
  'prd_backlog_inconsistency',
] as const;
export type WorkflowEvaluationReasonCode =
  (typeof WORKFLOW_EVALUATION_REASON_CODES)[number];

export const WORKFLOW_EVALUATION_REVIEWER_ROLE_KEYS = [
  'product_owner',
  'ba',
  'manager',
  'developer',
  'qa',
  'other',
] as const;
export type WorkflowEvaluationReviewerRoleKey =
  (typeof WORKFLOW_EVALUATION_REVIEWER_ROLE_KEYS)[number];

export const WORKFLOW_EVALUATION_SUBJECT_TYPES = ['interview_phase', 'prd', 'design_doc', 'test_cases'] as const;
export type WorkflowEvaluationSubjectType =
  (typeof WORKFLOW_EVALUATION_SUBJECT_TYPES)[number];

export const WORKFLOW_EVALUATION_JOB_EVALUATORS = ['promptfoo', 'llm_judge'] as const;
export type WorkflowEvaluationJobEvaluator =
  (typeof WORKFLOW_EVALUATION_JOB_EVALUATORS)[number];

export const WORKFLOW_EVALUATION_JOB_STATUSES = [
  'pending',
  'running',
  'ready',
  'failed',
] as const;
export type WorkflowEvaluationJobStatus =
  (typeof WORKFLOW_EVALUATION_JOB_STATUSES)[number];

/** Integer score on the shared 1–5 scale. */
export type WorkflowEvaluationScore = 1 | 2 | 3 | 4 | 5;

/** v1 criteria. Later processes may store other keys; the service checks the active rubric. */
export type WorkflowEvaluationCriteriaScores = {
  [K in WorkflowEvaluationCriteriaKey]: WorkflowEvaluationScore;
};

export type WorkflowEvaluationLabeledValue<TKey extends string = string> = {
  key: TKey;
  label: string;
};

export type WorkflowEvaluationCriterion = {
  key: WorkflowEvaluationCriteriaKey;
  label: string;
  helpText: string;
};

export type WorkflowEvaluationScaleLabel = {
  score: WorkflowEvaluationScore;
  label: string;
};

export const WORKFLOW_EVALUATION_LOW_SCORE_THRESHOLD = 2;
export const WORKFLOW_EVALUATION_MIN_LOW_SCORE_COMMENT_LENGTH = 20;

export const WORKFLOW_EVALUATION_SCALE: readonly WorkflowEvaluationScaleLabel[] = [
  { score: 1, label: 'Missed' },
  { score: 2, label: 'Major changes needed' },
  { score: 3, label: 'Some changes needed' },
  { score: 4, label: 'Minor changes needed' },
  { score: 5, label: 'Met completely' },
];

export const WORKFLOW_EVALUATION_CRITERION_LABELS: Record<
  WorkflowEvaluationCriteriaKey,
  string
> = {
  intent_alignment: 'Intent alignment',
  requirements_coverage: 'Requirements coverage',
  scope_alignment: 'Scope alignment',
  acceptance_criteria: 'Acceptance criteria',
  readiness: 'Readiness',
};

export const WORKFLOW_EVALUATION_PRD_CRITERION_HELP: Record<
  WorkflowEvaluationCriteriaKey,
  string
> = {
  intent_alignment: 'Does the PRD state the problem and outcome you meant?',
  requirements_coverage: 'Does the PRD and Backlog include every requirement you expected?',
  scope_alignment: 'Does the PRD stay inside the scope you agreed, with nothing invented?',
  acceptance_criteria: 'Can a tester check each acceptance criterion?',
  readiness: 'Could the team start design and delivery from this PRD without rework?',
};

/** Shared Interview wording. Phase number lives on the stage key until product names each phase. */
export const WORKFLOW_EVALUATION_INTERVIEW_CRITERION_HELP: Record<
  WorkflowEvaluationCriteriaKey,
  string
> = {
  intent_alignment: 'Does this phase capture the problem and outcome you meant to explore?',
  requirements_coverage: 'Did this phase surface every requirement you discussed?',
  scope_alignment: 'Did this phase stay inside the scope you agreed?',
  acceptance_criteria: 'Are the success conditions in this phase specific enough to test?',
  readiness: 'Is this phase complete enough to move to the next one?',
};

export const WORKFLOW_EVALUATION_DESIGN_DOC_CRITERION_HELP: Record<
  WorkflowEvaluationCriteriaKey,
  string
> = {
  intent_alignment: 'Does the design solve the problem the PRD describes, the way you meant?',
  requirements_coverage: 'Does the design and tech spec cover every PRD requirement for this feature?',
  scope_alignment: 'Does the design stay inside the PRD scope, with nothing invented?',
  acceptance_criteria: 'Can a tester check each acceptance criterion and test in the design?',
  readiness: 'Could a developer build this feature from the design without rework?',
};

export const WORKFLOW_EVALUATION_TEST_CASES_CRITERION_HELP: Record<
  WorkflowEvaluationCriteriaKey,
  string
> = {
  intent_alignment: 'Do the test cases check what the PRD meant, not just its wording?',
  requirements_coverage: 'Is every acceptance criterion and business rule covered by at least one case?',
  scope_alignment: 'Do the cases stay inside the PRD scope, with no invented behavior?',
  acceptance_criteria: 'Does each case have clear steps and an expected result a tester can check?',
  readiness: 'Could QA run these cases without rewriting them?',
};

export const WORKFLOW_EVALUATION_OUTCOME_LABELS: readonly WorkflowEvaluationLabeledValue<WorkflowEvaluationOutcome>[] =
  [
    { key: 'accept_unchanged', label: 'Accept unchanged' },
    { key: 'accept_after_edits', label: 'Accept after edits' },
    { key: 'regenerate', label: 'Regenerate' },
    { key: 'reject', label: 'Reject' },
  ];

export const WORKFLOW_EVALUATION_REASON_CODE_LABELS: readonly WorkflowEvaluationLabeledValue<WorkflowEvaluationReasonCode>[] =
  [
    { key: 'missing_requirement', label: 'Missing requirement' },
    { key: 'invented_requirement', label: 'Invented requirement' },
    { key: 'incorrect_interpretation', label: 'Incorrect interpretation' },
    { key: 'too_vague', label: 'Too vague' },
    { key: 'wrong_scope', label: 'Wrong scope' },
    { key: 'acceptance_criteria_not_testable', label: 'Acceptance criteria not testable' },
    { key: 'prd_backlog_inconsistency', label: 'PRD and backlog inconsistency' },
  ];

export const WORKFLOW_EVALUATION_REVIEWER_ROLE_LABELS: readonly WorkflowEvaluationLabeledValue<WorkflowEvaluationReviewerRoleKey>[] =
  [
    { key: 'product_owner', label: 'Product owner' },
    { key: 'ba', label: 'BA' },
    { key: 'manager', label: 'Manager' },
    { key: 'developer', label: 'Developer' },
    { key: 'qa', label: 'QA' },
    { key: 'other', label: 'Other' },
  ];

/**
 * Given by the server when the reviewer owns the PRD or design doc; never offered
 * as a choice and not part of a stored rubric. Owner approval waits for feedback
 * in this role.
 */
export const WORKFLOW_EVALUATION_PRD_OWNER_ROLE = { key: 'prd_owner', label: 'PRD owner' } as const;
export const WORKFLOW_EVALUATION_DESIGN_DOC_OWNER_ROLE = {
  key: 'design_doc_owner',
  label: 'Design doc owner',
} as const;
export const WORKFLOW_EVALUATION_TEST_CASES_OWNER_ROLE = {
  key: 'test_case_owner',
  label: 'Test case owner',
} as const;

export type WorkflowEvaluationRubric = {
  scale: readonly WorkflowEvaluationScaleLabel[];
  criteria: readonly WorkflowEvaluationCriterion[];
  reasonCodes: readonly WorkflowEvaluationLabeledValue<WorkflowEvaluationReasonCode>[];
  outcomes: readonly WorkflowEvaluationLabeledValue<WorkflowEvaluationOutcome>[];
  allowedReviewerRoles: readonly WorkflowEvaluationLabeledValue<WorkflowEvaluationReviewerRoleKey>[];
  lowScoreThreshold: number;
  minLowScoreCommentLength: number;
};

function criteriaFromHelp(
  help: Record<WorkflowEvaluationCriteriaKey, string>,
): WorkflowEvaluationCriterion[] {
  return WORKFLOW_EVALUATION_CRITERIA_KEYS.map((key) => ({
    key,
    label: WORKFLOW_EVALUATION_CRITERION_LABELS[key],
    helpText: help[key],
  }));
}

/** Rubric JSON stored on a definition row. A copy change is a new version, not an edit. */
export function buildWorkflowEvaluationRubric(
  help: Record<WorkflowEvaluationCriteriaKey, string>,
): WorkflowEvaluationRubric {
  return {
    scale: WORKFLOW_EVALUATION_SCALE,
    criteria: criteriaFromHelp(help),
    reasonCodes: WORKFLOW_EVALUATION_REASON_CODE_LABELS,
    outcomes: WORKFLOW_EVALUATION_OUTCOME_LABELS,
    allowedReviewerRoles: WORKFLOW_EVALUATION_REVIEWER_ROLE_LABELS,
    lowScoreThreshold: WORKFLOW_EVALUATION_LOW_SCORE_THRESHOLD,
    minLowScoreCommentLength: WORKFLOW_EVALUATION_MIN_LOW_SCORE_COMMENT_LENGTH,
  };
}

export const WORKFLOW_EVALUATION_PRD_RUBRIC = buildWorkflowEvaluationRubric(
  WORKFLOW_EVALUATION_PRD_CRITERION_HELP,
);

export const WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC = buildWorkflowEvaluationRubric(
  WORKFLOW_EVALUATION_INTERVIEW_CRITERION_HELP,
);

export const WORKFLOW_EVALUATION_DESIGN_DOC_RUBRIC = buildWorkflowEvaluationRubric(
  WORKFLOW_EVALUATION_DESIGN_DOC_CRITERION_HELP,
);

export const WORKFLOW_EVALUATION_TEST_CASES_RUBRIC = buildWorkflowEvaluationRubric(
  WORKFLOW_EVALUATION_TEST_CASES_CRITERION_HELP,
);

/** Opaque suite key. The executor Feature resolves it; this Feature only stores it. */
export function workflowEvaluationPromptfooSuiteRef(stageKey: string): string {
  return `${WORKFLOW_EVALUATION_PROCESS_KEY}/${stageKey}/structural@1`;
}

const workflowEvaluationFindingSchema = z.object({
  description: z.string(),
  evidence: z.string().optional(),
});

const workflowEvaluationImprovementSchema = z.object({
  text: z.string(),
  criterion: z.string().optional(),
});

export const workflowEvaluationJudgeOutputSchema = z.object({
  missedRequirements: z.array(workflowEvaluationFindingSchema),
  inventedRequirements: z.array(workflowEvaluationFindingSchema),
  alignmentScore: z.number().min(1).max(5).optional(),
  recommendedImprovements: z.array(workflowEvaluationImprovementSchema),
  confidence: z.enum(['low', 'medium', 'high']),
});

export type WorkflowEvaluationJudgeOutput = z.infer<typeof workflowEvaluationJudgeOutputSchema>;

export type WorkflowEvaluationJobResultBlobRefs = {
  output?: AiRunBlobRef;
  appendix?: AiRunBlobRef;
};

export type WorkflowEvaluationDefinition = {
  id: string;
  processKey: string;
  stageKey: string;
  evaluatorKey: string;
  benchmarkKey: string;
  version: number;
  rubric: WorkflowEvaluationRubric;
  promptfooSuiteRef: string;
  judgeOutputSchema: Record<string, unknown>;
  active: boolean;
  createdAt: string;
};

/** One immutable human submission. Lineage and the artifact hash are server-filled. */
export type HumanEvaluationEvent = {
  id: string;
  project: string;
  definitionId: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  phaseIndex: number | null;
  reviewerUserId: string;
  reviewerRoleKey: string;
  reviewerRoleLabel: string;
  skillPath: string | null;
  skillVersion: string | null;
  model: string | null;
  interviewId: string | null;
  prdId: string | null;
  artifactHash: string;
  criteriaScores: WorkflowEvaluationCriteriaScores;
  outcome: WorkflowEvaluationOutcome;
  reasonCodes: WorkflowEvaluationReasonCode[];
  comment: string | null;
  correctedArtifactText: string | null;
  correctedArtifactBlobRef: AiRunBlobRef | null;
  createdAt: string;
};

/**
 * Client create body. Lineage (`skillPath`, `skillVersion`, `model`, `interviewId`,
 * `prdId`) and `artifactHash` are absent on purpose: the server resolves them.
 */
export type CreateHumanEvaluationCorrectedArtifact =
  | { text: string }
  | { blobRef: AiRunBlobRef };

export type CreateHumanEvaluationRequest = {
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  criteria: WorkflowEvaluationCriteriaScores;
  outcome: WorkflowEvaluationOutcome;
  reasonCodes: readonly WorkflowEvaluationReasonCode[];
  comment?: string;
  reviewerRoleKey?: WorkflowEvaluationReviewerRoleKey;
  correctedArtifact?: CreateHumanEvaluationCorrectedArtifact;
};

export type WorkflowEvaluationJob = {
  id: string;
  eventId: string;
  evaluatorKey: WorkflowEvaluationJobEvaluator;
  status: WorkflowEvaluationJobStatus;
  runId: string | null;
  specificationHash: string | null;
  summary: Record<string, unknown> | null;
  resultBlobRefs: WorkflowEvaluationJobResultBlobRefs | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HumanEvaluationEventWithJobs = HumanEvaluationEvent & {
  jobs: WorkflowEvaluationJob[];
};

function isListedValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isWorkflowEvaluationOutcome(
  value: unknown,
): value is WorkflowEvaluationOutcome {
  return isListedValue(WORKFLOW_EVALUATION_OUTCOMES, value);
}

export function isWorkflowEvaluationReasonCode(
  value: unknown,
): value is WorkflowEvaluationReasonCode {
  return isListedValue(WORKFLOW_EVALUATION_REASON_CODES, value);
}

export function isWorkflowEvaluationJobStatus(
  value: unknown,
): value is WorkflowEvaluationJobStatus {
  return isListedValue(WORKFLOW_EVALUATION_JOB_STATUSES, value);
}

export function isWorkflowEvaluationCriteriaScores(
  value: unknown,
): value is WorkflowEvaluationCriteriaScores {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== WORKFLOW_EVALUATION_CRITERIA_KEYS.length) return false;
  return WORKFLOW_EVALUATION_CRITERIA_KEYS.every((key) => {
    const score = record[key];
    return typeof score === 'number' && Number.isInteger(score) && score >= 1 && score <= 5;
  });
}

/** False for any output that does not match the judge schema. Never returns a partial. */
export function isWorkflowEvaluationJudgeOutput(
  value: unknown,
): value is WorkflowEvaluationJudgeOutput {
  return workflowEvaluationJudgeOutputSchema.safeParse(value).success;
}

/**
 * API contracts for the evaluation router (FEAT-003).
 * `HumanEvaluationEvent` still mirrors the table. Responses use the shapes below
 * so a Blob path never leaves the server.
 */

export const WORKFLOW_EVALUATION_ERROR_CODES = [
  'UNKNOWN_FIELD',
  'UNKNOWN_STAGE',
  'SUBJECT_STAGE_MISMATCH',
  'INVALID_SCORES',
  'INVALID_OUTCOME',
  'REASON_REQUIRED',
  'COMMENT_TOO_SHORT',
  'COMMENT_TOO_LONG',
  'CORRECTED_ARTIFACT_REQUIRED',
  'CORRECTED_ARTIFACT_TOO_LARGE',
  'ROLE_NOT_ALLOWED',
  'ROLE_REQUIRED',
  'PHASE_NOT_STARTED',
  'ARTIFACT_NOT_READY',
  'SUBJECT_NOT_FOUND',
  'ARTIFACT_STORAGE_UNAVAILABLE',
] as const;
export type WorkflowEvaluationErrorCode = (typeof WORKFLOW_EVALUATION_ERROR_CODES)[number];

/** Body keys POST /events accepts. Any other key is rejected. */
export const CREATE_WORKFLOW_EVALUATION_REQUEST_FIELDS = [
  'subjectType',
  'subjectId',
  'stageKey',
  'criteria',
  'outcome',
  'reasonCodes',
  'comment',
  'reviewerRole',
  'correctedArtifact',
] as const;

export type WorkflowEvaluationCorrectedArtifactRequest =
  | { source: 'current_prd' }
  | { source: 'pasted'; text: string };

/**
 * HTTP create body. Lineage, artifact hash, project and reviewer id are absent
 * on purpose: the server resolves them, and the router rejects those keys.
 */
export type CreateWorkflowEvaluationRequest = {
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  stageKey: string;
  criteria: WorkflowEvaluationCriteriaScores;
  outcome: WorkflowEvaluationOutcome;
  reasonCodes?: readonly string[];
  comment?: string;
  reviewerRole?: string;
  correctedArtifact?: WorkflowEvaluationCorrectedArtifactRequest;
};

export type WorkflowEvaluationLineage = {
  skillPath: string | null;
  skillVersion: string | null;
  model: string | null;
  interviewId: string | null;
  prdId: string | null;
};

/** Reviewer-facing event. Carries a boolean for the corrected artifact, never its Blob path. */
export type WorkflowEvaluationEvent = {
  id: string;
  projectId: string;
  processKey: string;
  stageKey: string;
  definitionId: string;
  definitionVersion: number;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  phaseIndex: number | null;
  reviewerUserId: string;
  reviewerName: string | null;
  reviewerRoleKey: string;
  reviewerRoleLabel: string;
  lineage: WorkflowEvaluationLineage;
  artifactContentHash: string;
  criteria: WorkflowEvaluationCriteriaScores;
  outcome: WorkflowEvaluationOutcome;
  reasonCodes: string[];
  comment: string | null;
  hasCorrectedArtifact: boolean;
  createdAt: string;
};

export type WorkflowEvaluationEventJob = {
  evaluatorKey: string;
  status: WorkflowEvaluationJobStatus;
  summary: unknown | null;
  errorDetail: string | null;
  updatedAt: string;
};

export type WorkflowEvaluationEventDetail = WorkflowEvaluationEvent & {
  jobs: WorkflowEvaluationEventJob[];
};

export type WorkflowEvaluationDefinitionView = {
  id: string;
  version: number;
  processKey: string;
  stageKey: string;
  subjectType: WorkflowEvaluationSubjectType;
  phaseIndex?: number;
  criteria: readonly WorkflowEvaluationCriterion[];
  scale: readonly WorkflowEvaluationScaleLabel[];
  reasonCodes: readonly WorkflowEvaluationLabeledValue[];
  outcomes: readonly WorkflowEvaluationLabeledValue[];
  reviewerRoles: readonly WorkflowEvaluationLabeledValue[];
  minLowScoreCommentLength: number;
  correctedArtifactRequiredOutcomes: readonly string[];
};

export type WorkflowEvaluationReviewerRoleState = {
  derivedRoleKey: string | null;
  options: { key: string; label: string }[];
  requiresSelection: boolean;
};

export type GetWorkflowEvaluationDefinitionsResponse = {
  definitions: WorkflowEvaluationDefinitionView[];
  reviewer: WorkflowEvaluationReviewerRoleState;
};

export type ListWorkflowEvaluationEventsResponse = {
  events: WorkflowEvaluationEvent[];
  truncated: boolean;
  currentArtifactHash: string | null;
};
