/**
 * Admin model for workflow evaluations (Project Admin -> Workflow evaluations):
 * list, detail and export responses, plus the project's evaluation model setting.
 */
import type { WorkflowEvaluationPromptfooSummary } from './aiRunV2EvaluationSpec';
import type { EffortLevel } from './effort';
import type {
  WorkflowEvaluationJobEvaluator,
  WorkflowEvaluationJobStatus,
  WorkflowEvaluationJudgeOutput,
  WorkflowEvaluationLabeledValue,
  WorkflowEvaluationLineage,
  WorkflowEvaluationOutcome,
  WorkflowEvaluationSubjectType,
} from './workflowEvaluation';

export const ADMIN_EVALUATION_LIST_DEFAULT_LIMIT = 50;
export const ADMIN_EVALUATION_LIST_MAX_LIMIT = 200;
export const ADMIN_EVALUATION_EXPORT_MAX_ROWS = 2_000;
export const ADMIN_EVALUATION_SEARCH_MAX_LENGTH = 100;

export const ADMIN_EVALUATION_EXPORT_FORMATS = ['json', 'csv'] as const;
export type AdminEvaluationExportFormat = (typeof ADMIN_EVALUATION_EXPORT_FORMATS)[number];

/** `from` and `to` are `YYYY-MM-DD` in UTC, both inclusive. */
export type AdminEvaluationFilters = {
  stage?: string;
  outcome?: WorkflowEvaluationOutcome;
  reason?: string;
  subjectType?: WorkflowEvaluationSubjectType;
  from?: string;
  to?: string;
  q?: string;
  eventId?: string;
};

export type AdminEvaluationJobSummary = {
  evaluatorKey: WorkflowEvaluationJobEvaluator;
  status: WorkflowEvaluationJobStatus;
};

export type AdminEvaluationEventSummary = {
  id: string;
  createdAt: string;
  stageKey: string;
  stageLabel: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  phaseIndex: number | null;
  outcome: WorkflowEvaluationOutcome;
  outcomeLabel: string;
  criteriaAverage: number;
  reviewerDisplayName: string;
  reviewerRoleLabel: string;
  reasonCodes: string[];
  jobs: AdminEvaluationJobSummary[];
};

export type AdminEvaluationListResponse = {
  items: AdminEvaluationEventSummary[];
  nextCursor: string | null;
};

export type AdminEvaluationJob = AdminEvaluationJobSummary & {
  updatedAt: string;
  errorDetail: string | null;
};

export type AdminEvaluationCriterionScore = {
  key: string;
  label: string;
  score: number;
  scaleLabel: string;
};

export type AdminEvaluationEventDetail = Omit<AdminEvaluationEventSummary, 'jobs'> & {
  criteria: AdminEvaluationCriterionScore[];
  reasons: WorkflowEvaluationLabeledValue[];
  comment: string | null;
  hasCorrectedArtifact: boolean;
  artifactHash: string;
  lineage: WorkflowEvaluationLineage;
  jobs: AdminEvaluationJob[];
  judge: { output: WorkflowEvaluationJudgeOutput | null; hasAppendix: boolean };
  promptfoo: WorkflowEvaluationPromptfooSummary | null;
  promptfooFailed: boolean;
};

export type AdminEvaluationEventDetailResponse = { event: AdminEvaluationEventDetail };

export type AdminEvaluationJudgeAppendixResponse = { markdown: string };

export const WORKFLOW_EVALUATION_STAGE_LABELS: Record<string, string> = {
  prd_human_review: 'PRD review',
  interview_phase_1: 'Interview phase 1',
  interview_phase_2: 'Interview phase 2',
  interview_phase_3: 'Interview phase 3',
  design_doc_human_review: 'Design doc review',
  test_cases_human_review: 'Test case review',
};

export function workflowEvaluationStageLabel(stageKey: string): string {
  return WORKFLOW_EVALUATION_STAGE_LABELS[stageKey] ?? stageKey;
}

export const ADMIN_EVALUATION_MODEL_MAX_LENGTH = 200;

/** Where the model every evaluation judge in the project runs on comes from. */
export type AdminEvaluationModelSource = 'evaluation' | 'prd_validation' | 'app_default';

export type AdminEvaluationModelSettings = {
  /** False when the project has no default skill configuration to store the setting on. */
  hasSkillConfig: boolean;
  model: string | null;
  effort: EffortLevel | null;
  effective: { model: string; effort: EffortLevel | null; source: AdminEvaluationModelSource } | null;
};

export type UpdateAdminEvaluationModelSettingsRequest = {
  model: string | null;
  effort: EffortLevel | null;
};
