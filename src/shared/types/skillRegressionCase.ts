import type {
  WorkflowEvaluationOutcome,
  WorkflowEvaluationSubjectType,
} from './workflowEvaluation';

export const SKILL_REGRESSION_CASE_REASONS = ['corrected_text', 'low_score', 'both'] as const;
export type SkillRegressionCaseReason = (typeof SKILL_REGRESSION_CASE_REASONS)[number];

export const SKILL_REGRESSION_SNAPSHOT_STATUSES = ['pending', 'stored', 'artifact_changed', 'failed'] as const;
export type SkillRegressionSnapshotStatus = (typeof SKILL_REGRESSION_SNAPSHOT_STATUSES)[number];

export const SKILL_REGRESSION_CASE_STATUSES = ['active', 'retired'] as const;
export type SkillRegressionCaseStatus = (typeof SKILL_REGRESSION_CASE_STATUSES)[number];

export const SKILL_REGRESSION_STATUS_REASON_MAX = 500;

export const SKILL_REGRESSION_CASE_REASON_LABELS: Record<SkillRegressionCaseReason, string> = {
  corrected_text: 'Corrected text',
  low_score: 'Low score',
  both: 'Low score + corrected text',
};

export const SKILL_REGRESSION_SNAPSHOT_STATUS_LABELS: Record<SkillRegressionSnapshotStatus, string> = {
  pending: 'Saving copy',
  stored: 'Copy saved',
  artifact_changed: 'Changed before copy',
  failed: 'Copy failed',
};

/** The exact parts each artifact hash covers, so a stored copy can be re-hashed. */
export type SkillRegressionArtifact =
  | { subjectType: 'prd'; markdown: string; backlog: unknown }
  | { subjectType: 'design_doc'; designContent: string; techSpecContent: string; assumptionsContent: string }
  | { subjectType: 'test_cases'; testCasesMd: string | null; testCasesJson: unknown }
  | {
    subjectType: 'interview_phase';
    phaseIndex: number;
    messages: Array<{ role: string; text: string }>;
    linkedContextIds: { adrIds: string[]; designModuleIds: string[] };
  };

export type SkillRegressionSnapshotDocument = {
  version: 1;
  eventId: string;
  artifactHash: string;
  capturedAt: string;
  artifact: SkillRegressionArtifact;
};

export type SkillRegressionCase = {
  id: string;
  eventId: string;
  subjectType: WorkflowEvaluationSubjectType;
  subjectId: string;
  phaseIndex: number | null;
  stageKey: string;
  skillPath: string | null;
  skillVersion: string | null;
  reason: SkillRegressionCaseReason;
  outcome: WorkflowEvaluationOutcome;
  lowCriteria: string[];
  comment: string | null;
  reviewerName: string | null;
  snapshotStatus: SkillRegressionSnapshotStatus;
  status: SkillRegressionCaseStatus;
  statusReason: string | null;
  statusChangedByName: string | null;
  statusChangedAt: string | null;
  createdAt: string;
};

export type SkillRegressionCaseFilters = {
  status?: SkillRegressionCaseStatus;
  skillPath?: string;
};

export type SkillRegressionCaseListResponse = {
  cases: SkillRegressionCase[];
  skillPaths: string[];
  limit: number;
};

export type UpdateSkillRegressionCaseRequest = {
  status: SkillRegressionCaseStatus;
  reason?: string;
};

export type SkillRegressionBackfillResult = {
  created: number;
  stored: number;
  artifactChanged: number;
  failed: number;
  remaining: number;
};
