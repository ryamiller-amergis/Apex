export type InterviewStatus = 'in_progress' | 'complete' | 'archived';

export interface InterviewSummary {
  id: string;
  chatThreadId: string;
  authorId: string;
  authorName?: string;
  title: string;
  project: string;
  repo: string;
  status: InterviewStatus;
  prdCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Interview extends InterviewSummary {
  prds: PrdSummary[];
}

export type PrdStatus = 'generating' | 'draft' | 'pending_review' | 'approved' | 'revision_requested';

export interface PrdSummary {
  id: string;
  interviewId: string | null;
  chatThreadId: string;
  authorId: string;
  authorName?: string;
  project: string;
  title: string;
  status: PrdStatus;
  reviewerId?: string;
  reviewerName?: string;
  reviewComment?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Prd extends PrdSummary {
  content: string;
  backlogJson?: unknown;
}

export interface CreateInterviewRequest {
  project: string;
  repo: string;
  title?: string;
  model?: string;
}

export interface CreateInterviewResponse {
  interviewId: string;
  threadId: string;
}

export interface CreatePrdRequest {
  model?: string;
}

export interface CreatePrdResponse {
  prdId: string;
  threadId: string;
}

export interface ReviewPrdRequest {
  action: 'approve' | 'request_revision';
  comment?: string;
}

export interface ReviewPrdResponse {
  ok: boolean;
  designDocId?: string;
}

export function prdStatusLabel(status: PrdStatus): string {
  switch (status) {
    case 'generating': return 'Generating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

export function prdBadgeClass(status: PrdStatus): string {
  switch (status) {
    case 'generating': return 'generating';
    case 'draft': return 'draft';
    case 'pending_review': return 'pending-review';
    case 'approved': return 'approved';
    case 'revision_requested': return 'revision-requested';
  }
}

// ── Design Doc types ──────────────────────────────────────────────────────────

export interface ValidationScorecardGap {
  id: string;
  file: string;
  section: string;
  score: number;
  description: string;
  what_3_looks_like: string;
  resolution: 'pending' | 'filled' | 'deferred' | 'accepted';
}

export interface ValidationScorecardFeature {
  feature_slug: string;
  feature_title: string;
  design_score: number;
  tech_spec_score: number;
  assumptions_score: number;
  overall_score: number;
  verdict: string;
  gaps: ValidationScorecardGap[];
}

export interface ValidationScorecard {
  slug: string;
  generated_at: string;
  review_phase: 'initial' | 'final';
  overall_score: number;
  ready_threshold: number;
  is_ready: boolean;
  verdict: 'ready' | 'gaps' | 'significant_gaps';
  features: ValidationScorecardFeature[];
  cross_cutting_checks: Record<string, string>;
  accepted_gaps: string[];
  deferred_gaps: string[];
}

export interface ContentSnapshot {
  design: string;
  techSpec: string;
  assumptions: string;
  capturedAt: string;
  fixThreadId?: string;
}

export type DesignDocStatus = 'interviewing' | 'generating' | 'validating' | 'draft' | 'pending_review' | 'approved' | 'revision_requested';

export interface DesignDocSummary {
  id: string;
  prdId: string;
  prdTitle?: string;
  project: string;
  chatThreadId: string | null;
  qaChatThreadId?: string | null;
  docAssistantThreadId?: string | null;
  validationThreadId?: string | null;
  validationScore?: number | null;
  validationScorecard?: ValidationScorecard | null;
  validationReportMd?: string | null;
  validationPhase?: string | null;
  fixBaseline?: ContentSnapshot | null;
  authorId: string;
  authorName?: string;
  title: string;
  status: DesignDocStatus;
  reviewerId?: string;
  reviewerName?: string;
  reviewComment?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignDoc extends DesignDocSummary {
  designContent: string;
  techSpecContent: string;
  assumptionsContent: string;
}

export type CreateDesignDocResponse = { designDocId: string; threadId: string };

export interface ReviewDesignDocRequest {
  action: 'approve' | 'request_revision';
  comment?: string;
}

export function designDocStatusLabel(status: DesignDocStatus): string {
  switch (status) {
    case 'interviewing': return 'Interviewing';
    case 'generating': return 'Generating';
    case 'validating': return 'Validating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

export function designDocBadgeClass(status: DesignDocStatus): string {
  switch (status) {
    case 'interviewing': return 'interviewing';
    case 'generating': return 'generating';
    case 'validating': return 'validating';
    case 'draft': return 'draft';
    case 'pending_review': return 'pending-review';
    case 'approved': return 'approved';
    case 'revision_requested': return 'revision-requested';
  }
}

// ── PRD → ADO Work Items types ───────────────────────────────────────────────

export interface SelectedBacklogPBI {
  id: string;
  title: string;
  description?: string;
  priority?: string;
  acceptanceCriteria?: Array<{ given?: string; when?: string; then?: string }>;
  userStory?: { persona?: string; iWant?: string; soThat?: string };
  businessRules?: string[];
  nonFunctionalRequirements?: string[] | Record<string, string>;
  definitionOfDone?: string[];
  outOfScope?: string[];
  dependsOn?: string[];
}

export interface SelectedBacklogFeature {
  title: string;
  description?: string;
  priority?: string;
  affectedPersonas?: string[];
  outOfScope?: string[];
  dependencies?: string[];
  items?: SelectedBacklogPBI[];
}

export interface GlobalBusinessRule {
  id: string;
  rule: string;
  appliesTo?: string;
}

export interface SelectedBacklogEpic {
  title: string;
  description?: string;
  priority?: string;
  successMetrics?: string[];
  outOfScope?: string[];
  assumptions?: string[];
  dependencies?: string[];
  features?: SelectedBacklogFeature[];
}

export interface CreatePrdAdoItemsRequest {
  project: string;
  areaPath: string;
  globalBusinessRules?: GlobalBusinessRule[];
  selectedItems: { epics: SelectedBacklogEpic[] };
}

export interface CreatePrdAdoItemsResponse {
  success: boolean;
  created: {
    epics: Array<{ title: string; adoId: number; adoUrl: string }>;
    features: Array<{ title: string; adoId: number; adoUrl: string }>;
    pbis: Array<{ title: string; adoId: number; adoUrl: string }>;
  };
  totalCreated: number;
}
