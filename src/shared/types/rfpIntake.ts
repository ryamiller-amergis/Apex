/**
 * Shared RFP Intake contracts.
 * Evaluation enums and output shape match `.cursor/skills/product-intake-evaluation/SKILL.md`.
 */

export const RFP_INTAKE_VIEW = 'rfp-intake:view';
export const RFP_INTAKE_MANAGE = 'rfp-intake:manage';
export const RFP_INTAKE_SUBMIT = 'rfp-intake:submit';
export const RFP_SUBMITTER_ROLE = 'rfp-submitter';

export type RfpSubmitAccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface RfpSubmitAccessRequest {
  id: string;
  userId: string;
  status: RfpSubmitAccessRequestStatus;
  requestedAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
}

export interface PlatformAdminRfpSubmitAccessRequest extends RfpSubmitAccessRequest {
  displayName: string;
  email: string;
}

export const RFP_HUMAN_STATUSES = [
  'submitted',
  'evaluating',
  'evaluated',
  'in-review',
  'accepted',
  'declined',
  'on-hold',
  'archived',
] as const;
export type RfpHumanStatus = (typeof RFP_HUMAN_STATUSES)[number];

export const RFP_AI_STATUSES = ['evaluating', 'failed', 'complete'] as const;
export type RfpAiStatus = (typeof RFP_AI_STATUSES)[number];

export const RFP_VERDICTS = [
  'build',
  'rent-and-wrap',
  'rent',
  'buy',
  'decline',
  'needs-clarification',
] as const;
export type RfpVerdict = (typeof RFP_VERDICTS)[number];

export const RFP_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type RfpConfidence = (typeof RFP_CONFIDENCE_LEVELS)[number];

export const RFP_TECH_VELOCITIES = ['stable', 'moderate', 'frontier'] as const;
export type RfpTechVelocity = (typeof RFP_TECH_VELOCITIES)[number];

export const RFP_NATIVE_BENEFITS = ['low', 'medium', 'high'] as const;
export type RfpNativeBenefit = (typeof RFP_NATIVE_BENEFITS)[number];

export const RFP_AUDIENCES = ['internal', 'external', 'mixed'] as const;
export type RfpAudience = (typeof RFP_AUDIENCES)[number];

export const RFP_DATA_SENSITIVITIES = [
  'none',
  'internal-only',
  'employee-pii',
  'candidate-pii',
  'client-customer-pii',
  'regulated',
] as const;
export type RfpDataSensitivity = (typeof RFP_DATA_SENSITIVITIES)[number];

export const RFP_REQUEST_TYPES = [
  'new-app',
  'change-existing',
  'internal-tool',
  'integration',
  'reporting',
  'other',
] as const;
export type RfpRequestType = (typeof RFP_REQUEST_TYPES)[number];

export const RFP_EXPECTED_USER_SCALES = ['small', 'medium', 'large'] as const;
export type RfpExpectedUserScale = (typeof RFP_EXPECTED_USER_SCALES)[number];

export const RFP_EXPECTED_USER_SCALE_LABELS: Record<RfpExpectedUserScale, string> = {
  small: 'Small (1–100)',
  medium: 'Medium (101–500)',
  large: 'Large (501+)',
};

export const RFP_AI_INTENTS = ['yes', 'no', 'not-sure'] as const;
export type RfpAiIntent = (typeof RFP_AI_INTENTS)[number];

export const RFP_AI_INTENT_LABELS: Record<RfpAiIntent, string> = {
  yes: 'Yes',
  no: 'No',
  'not-sure': 'Not sure',
};

export const RFP_APP_TYPES = ['web', 'console', 'copilot-workflow'] as const;
export type RfpAppType = (typeof RFP_APP_TYPES)[number];

export const RFP_APP_TYPE_LABELS: Record<RfpAppType, string> = {
  web: 'Web',
  console: 'Console',
  'copilot-workflow': 'Copilot Workflow',
};

export const RFP_CLOUD_RESOURCES = ['service-bus', 'rds', 'ecs', 'monitoring', 'pagerduty'] as const;
export type RfpCloudResource = (typeof RFP_CLOUD_RESOURCES)[number];

export const RFP_CLOUD_RESOURCE_LABELS: Record<RfpCloudResource, string> = {
  'service-bus': 'Amazon SQS',
  rds: 'RDS',
  ecs: 'ECS',
  monitoring: 'Amazon CloudWatch',
  pagerduty: 'PagerDuty',
};

export const RFP_DEPLOYMENT_REGIONS = ['us-east', 'us-central', 'us-west'] as const;
export type RfpDeploymentRegion = (typeof RFP_DEPLOYMENT_REGIONS)[number];

export const RFP_DEPLOYMENT_REGION_LABELS: Record<RfpDeploymentRegion, string> = {
  'us-east': 'US East (Virginia)',
  'us-central': 'US Central (Ohio / Iowa)',
  'us-west': 'US West (Oregon / Washington)',
};

export const RFP_SIZING_PROFILES = ['small', 'medium', 'large'] as const;
export type RfpSizingProfile = (typeof RFP_SIZING_PROFILES)[number];

export const RFP_SIZING_PROFILE_LABELS: Record<RfpSizingProfile, string> = {
  small: 'Small — light traffic, one app instance',
  medium: 'Medium — steady traffic, redundant instances',
  large: 'Large — heavy traffic, high availability',
};

export const RFP_UPTIME_PATTERNS = ['business-hours', 'always-on'] as const;
export type RfpUptimePattern = (typeof RFP_UPTIME_PATTERNS)[number];

export const RFP_UPTIME_PATTERN_LABELS: Record<RfpUptimePattern, string> = {
  'business-hours': 'Business hours (about 12 hours a day, weekdays)',
  'always-on': 'Always on (24/7)',
};

export const RFP_AI_USAGE_LEVELS = ['light', 'moderate', 'heavy'] as const;
export type RfpAiUsage = (typeof RFP_AI_USAGE_LEVELS)[number];

export const RFP_AI_USAGE_LABELS: Record<RfpAiUsage, string> = {
  light: 'Light (about 5M tokens a month)',
  moderate: 'Moderate (about 25M tokens a month)',
  heavy: 'Heavy (about 100M tokens a month)',
};

export const RFP_MAX_ENVIRONMENTS = 4;
export const RFP_MAX_STORAGE_GB = 10_000;

/** Assumptions the pricing research needs; prefilled from expected users and confirmed by an admin. */
export interface RfpArchitectureSizing {
  region: RfpDeploymentRegion;
  sizingProfile: RfpSizingProfile;
  environmentCount: number;
  uptimePattern: RfpUptimePattern;
  storageGb: number;
  aiUsage: RfpAiUsage | null;
}

/** Azure DevOps project that holds repos created from approved proposals. */
export const RFP_APPS_ADO_PROJECT = 'Apex - Apps';

export const RFP_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type RfpPriority = (typeof RFP_PRIORITIES)[number];

export const RFP_RISKS = ['low', 'medium', 'high'] as const;
export type RfpRisk = (typeof RFP_RISKS)[number];

export const RFP_DELIVERY_APPROACHES = [
  'full-code',
  'low-code-config',
  'rent-and-wrap',
  'handoff-specialist',
] as const;
export type RfpDeliveryApproach = (typeof RFP_DELIVERY_APPROACHES)[number];

export const RFP_RECOMMENDED_LANES = [
  'greenfield-prototype',
  'fix-existing',
  'committed-product',
  'low-code-solution',
  'platform-feature',
  'none',
] as const;
export type RfpRecommendedLane = (typeof RFP_RECOMMENDED_LANES)[number];

export const RFP_HOSTING_RECOMMENDATIONS = [
  'apex-managed-aws',
  'azure-existing',
  'vendor-hosted',
  'client-or-onprem',
  'undecided',
] as const;
export type RfpHostingRecommendation = (typeof RFP_HOSTING_RECOMMENDATIONS)[number];

export const RFP_REQUEST_EVENT_TYPES = [
  'submitted',
  'evaluation-started',
  'evaluation-completed',
  'evaluation-failed',
  'clarification-submitted',
  'evaluation-retried',
  'reevaluation-requested',
  'status-changed',
  'reopened',
  'comment-added',
  'attachment-added',
  'reviewer-decision-applied',
  'architecture-saved',
  'review-submitted',
  'proposal-generation-started',
  'proposal-generation-completed',
  'proposal-generation-failed',
  'decision-summary-generated',
  'proposal-draft-edited',
  'proposal-published',
  'proposal-approved',
  'proposal-rejected',
  'proposal-project-deleted',
] as const;
export type RfpRequestEventType = (typeof RFP_REQUEST_EVENT_TYPES)[number];

export const PRODUCT_INTAKE_EVALUATION_OUTPUT_FILE = 'product-intake-evaluation.json';

/** Structured intake collected by the Request for Product form (BR-002). */
export interface RfpIntakePayload {
  title: string;
  stakeholder: string;
  request: string;
  problem: string;
  audience: RfpAudience;
  dataSensitivity: RfpDataSensitivity;
  existingSolution: string;
  advantage?: string | null;
  constraints?: string | null;
  requestType?: RfpRequestType | null;
  existingSystemStack?: string | null;
  /** Required on new submissions; null on requests submitted before the field existed. */
  expectedUsers?: RfpExpectedUserScale | null;
  /** Required on new submissions; null on requests submitted before the field existed. */
  aiInApp?: RfpAiIntent | null;
}

export interface RfpArchitectureInput {
  appType: RfpAppType;
  resources: RfpCloudResource[];
  requiresAi: boolean;
  domainName?: string | null;
  sizing: RfpArchitectureSizing;
}

export interface RfpArchitecture extends Omit<RfpArchitectureInput, 'domainName' | 'sizing'> {
  domainName: string | null;
  /** Null only on architectures saved before sizing existed. */
  sizing: RfpArchitectureSizing | null;
  updatedBy: string;
  updatedAt: string;
}

export interface SubmitRfpReviewInput {
  /** Optional for Decline; required for every other verdict. */
  architecture: RfpArchitectureInput | null;
}

export const RFP_PROPOSAL_JOB_STATUSES = [
  'queued',
  'researching-prices',
  'writing',
  'ready',
  'failed',
  'superseded',
] as const;
export type RfpProposalJobStatus = (typeof RFP_PROPOSAL_JOB_STATUSES)[number];

export const RFP_PROPOSAL_JOB_ACTIVE_STATUSES = ['queued', 'researching-prices', 'writing'] as const;

export const RFP_PROPOSAL_JOB_STATUS_LABELS: Record<RfpProposalJobStatus, string> = {
  queued: 'Queued',
  'researching-prices': 'Researching prices',
  writing: 'Writing proposal',
  ready: 'Ready',
  failed: 'Failed',
  superseded: 'Superseded',
};

export function isRfpProposalJobActive(status: RfpProposalJobStatus): boolean {
  return (RFP_PROPOSAL_JOB_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export const RFP_DRAFT_KINDS = ['proposal', 'decision-summary'] as const;
export type RfpDraftKind = (typeof RFP_DRAFT_KINDS)[number];

/** Admin-only view of the current generation job. */
export interface RfpProposalGeneration {
  jobId: string;
  kind: RfpDraftKind;
  status: RfpProposalJobStatus;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const RFP_COST_SOURCE_TYPES = [
  'aws-price-list',
  'azure-retail-prices',
  'vendor-page',
  'internal-estimate',
] as const;
export type RfpCostSourceType = (typeof RFP_COST_SOURCE_TYPES)[number];

export const RFP_COST_SOURCE_TYPE_LABELS: Record<RfpCostSourceType, string> = {
  'aws-price-list': 'AWS Price List',
  'azure-retail-prices': 'Azure Retail Prices',
  'vendor-page': 'Vendor pricing page',
  'internal-estimate': 'Apex estimate',
};

export const RFP_PRICE_STATUSES = ['verified', 'unavailable', 'estimate'] as const;
export type RfpPriceStatus = (typeof RFP_PRICE_STATUSES)[number];

export const RFP_COST_CATEGORIES = ['implementation', 'operating'] as const;
export type RfpCostCategory = (typeof RFP_COST_CATEGORIES)[number];

export const RFP_COST_CADENCES = ['one-time', 'monthly'] as const;
export type RfpCostCadence = (typeof RFP_COST_CADENCES)[number];

export interface RfpCostAmounts {
  low: number;
  expected: number;
  high: number;
}

/** One priced line. `amounts` is null when no official price could be verified. */
export interface RfpCostLine {
  id: string;
  label: string;
  category: RfpCostCategory;
  cadence: RfpCostCadence;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  amounts: RfpCostAmounts | null;
  currency: 'USD';
  priceStatus: RfpPriceStatus;
  sourceType: RfpCostSourceType;
  sourceUrl: string | null;
  sourceTitle: string | null;
  retrievedAt: string | null;
  confidence: RfpConfidence;
  assumptions: string[];
  adminConfirmed: boolean;
}

export interface RfpCostTotals {
  oneTime: RfpCostAmounts;
  monthly: RfpCostAmounts;
  annual: RfpCostAmounts;
  unpricedLineCount: number;
}

export interface RfpDeliveryPhase {
  name: string;
  duration: string;
  outcomes: string[];
}

export interface RfpProposalRisk {
  risk: string;
  mitigation: string;
}

export interface RfpProposalSections {
  executiveSummary: string;
  recommendedSolution: string;
  scope: string[];
  deliveryPhases: RfpDeliveryPhase[];
  timeline: string;
  assumptions: string[];
  exclusions: string[];
  risks: RfpProposalRisk[];
  securityAndData: string;
  ownership: string;
  nextSteps: string[];
}

export const RFP_DRAFT_VERSION = 1 as const;

interface RfpDraftBase {
  version: typeof RFP_DRAFT_VERSION;
  jobId: string;
  inputFingerprint: string;
  verdict: RfpVerdict;
  generatedAt: string;
  editedBy: string | null;
  editedAt: string | null;
}

export interface RfpProposalDraft extends RfpDraftBase {
  kind: 'proposal';
  sections: RfpProposalSections;
  costLines: RfpCostLine[];
  totals: RfpCostTotals;
}

export interface RfpDecisionSummaryDraft extends RfpDraftBase {
  kind: 'decision-summary';
  summary: string;
  reasons: string[];
  alternatives: string[];
  nextSteps: string[];
}

export type RfpGeneratedDraft = RfpProposalDraft | RfpDecisionSummaryDraft;

export interface RfpPublishProposalInput {
  /** Required when the draft is a proposal; ignored for a decision summary. */
  productOwnerId?: string | null;
}

/** The admin-confirmed draft as the requester sees it. */
export interface RfpProposalRejection {
  rejectedAt: string;
  rejectedBy: string;
  reason: string;
}

export interface RfpProposal {
  document: RfpGeneratedDraft;
  productOwnerId: string | null;
  productOwnerName: string | null;
  publishedBy: string;
  publishedAt: string;
  rejection?: RfpProposalRejection | null;
}

export interface RfpApproval {
  approvedAt: string;
  repoName: string;
  repoUrl: string;
  apexProject: string;
}

export type RfpClarificationInput = Partial<RfpIntakePayload> & {
  clarifyingAnswers?: string[];
};

/** JSON create/clarify body. Owner and source project are never client-supplied. */
export type CreateRfpRequestDTO = RfpIntakePayload;

export interface CreateRfpCommentDTO {
  body: string;
  mentionedUserIds?: string[];
  attachmentIds?: string[];
}

export const RFP_STATUS_TRANSITIONS: Record<RfpHumanStatus, readonly RfpHumanStatus[]> = {
  submitted: [],
  evaluating: [],
  evaluated: ['in-review'],
  'in-review': ['accepted', 'declined', 'on-hold'],
  accepted: [],
  declined: [],
  'on-hold': ['in-review'],
  archived: [],
};

export function canTransitionRfpStatus(from: RfpHumanStatus, to: RfpHumanStatus): boolean {
  return (RFP_STATUS_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function canReopenRfp(status: RfpHumanStatus): boolean {
  return status === 'accepted' || status === 'declined';
}

export function rfpRequestorLink(id: string): string {
  return `/?request=${encodeURIComponent(id)}`;
}

export function rfpTriageLink(id: string): string {
  return `/rfp-intake/${id}`;
}

export interface RfpTriageListQuery {
  status?: RfpHumanStatus;
  verdict?: RfpVerdict;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface RfpTriageSummary extends RfpRequestSummary {
  ownerId: string;
  stakeholder: string;
}

export interface RfpTriageListResponse {
  items: RfpTriageSummary[];
  total: number;
}

export interface RfpTriageDetail extends RfpRequestDetail {
  evaluations: RfpEvaluation[];
}

export interface RfpStatusTransitionRequest {
  target: RfpHumanStatus;
  note?: string;
}

export interface RfpReopenRequest {
  reason: string;
}

export interface RfpMentionCandidate {
  userId: string;
  displayName: string;
  email: string;
}

export type RfpNotifyKind =
  | 'submitted'
  | 'evaluation-completed'
  | 'evaluation-failed'
  | 'status-changed'
  | 'reopened'
  | 'comment-added';

export interface RfpRecipient {
  userId: string;
  link: string;
  type: 'ai' | 'user-action';
}

export interface RfpRequestSummary {
  id: string;
  title: string;
  status: RfpHumanStatus;
  aiStatus: RfpAiStatus;
  currentVerdict: RfpVerdict | null;
  clarificationUsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RfpOwnerListResponse {
  items: RfpRequestSummary[];
  total: number;
}

export interface RfpRequestDetail extends RfpRequest {
  comments: RfpComment[];
  attachments: RfpAttachment[];
  activity: RfpRequestEvent[];
}

export const RFP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const RFP_ATTACHMENT_MAX_COUNT = 5;
export const RFP_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

export interface RfpAttachmentCandidate {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export function sanitizeRfpFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'file';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  return cleaned || 'file';
}

export function validateRfpAttachments(files: RfpAttachmentCandidate[]): string[] {
  const errors: string[] = [];
  if (files.length > RFP_ATTACHMENT_MAX_COUNT) {
    errors.push(`At most ${RFP_ATTACHMENT_MAX_COUNT} attachments are allowed`);
  }
  for (const file of files) {
    if (file.sizeBytes > RFP_ATTACHMENT_MAX_BYTES) {
      errors.push(`${file.filename} exceeds 10 MB`);
    }
    if (!(RFP_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.contentType)) {
      errors.push(`${file.filename} has an unsupported type`);
    }
  }
  return errors;
}

/** Untouched Product Intake Evaluation Skill JSON (authoritative output contract). */
export interface ProductIntakeEvaluationOutput {
  verdict: RfpVerdict;
  confidence: RfpConfidence;
  techVelocity: RfpTechVelocity;
  nativeBenefit: RfpNativeBenefit;
  audience: RfpAudience;
  dataLeavesTenant: boolean;
  priority: RfpPriority;
  risk: RfpRisk;
  deliveryApproach: RfpDeliveryApproach;
  recommendedLane: RfpRecommendedLane;
  recommendedTooling: string[];
  hostingRecommendation: RfpHostingRecommendation;
  operationalOwner: string;
  reuseOpportunity: string;
  entersInterviewFlow: boolean;
  buildBuyRentSummary: string;
  rationale: string;
  existingOverlap: string;
  clarifyingQuestions: string[];
}

export interface RfpEvaluation extends ProductIntakeEvaluationOutput {
  id: string;
  rfpRequestId: string;
  version: number;
  rawOutput: ProductIntakeEvaluationOutput;
  /** Informational badge when the lane is committed-product. */
  committedProductBadge: boolean;
  createdAt: string;
}

export interface RfpRequest {
  id: string;
  ownerId: string;
  title: string;
  stakeholder: string;
  request: string;
  problem: string;
  audience: RfpAudience;
  dataSensitivity: RfpDataSensitivity;
  existingSolution: string;
  advantage: string | null;
  constraints: string | null;
  requestType: RfpRequestType | null;
  existingSystemStack: string | null;
  expectedUsers: RfpExpectedUserScale | null;
  aiInApp: RfpAiIntent | null;
  status: RfpHumanStatus;
  aiStatus: RfpAiStatus;
  aiThreadId: string | null;
  sourceProject: string;
  currentEvaluationId: string | null;
  clarificationUsed: boolean;
  createdAt: string;
  updatedAt: string;
  currentEvaluation?: RfpEvaluation | null;
  reviewerDecision: RfpReviewerDecision | null;
  architecture: RfpArchitecture | null;
  reviewSubmittedAt: string | null;
  reviewSubmittedBy: string | null;
  /** Admin only; always null in requester responses. */
  proposalGeneration: RfpProposalGeneration | null;
  /** Admin only; always null in requester responses. */
  proposalDraft: RfpGeneratedDraft | null;
  proposal: RfpProposal | null;
  approval: RfpApproval | null;
}

export interface RfpComment {
  id: string;
  rfpRequestId: string;
  authorId: string;
  authorName?: string;
  body: string;
  mentionedUserIds: string[];
  createdAt: string;
}

export const RFP_EVALUATION_CHAT_ROLES = ['user', 'assistant'] as const;
export type RfpEvaluationChatRole = (typeof RFP_EVALUATION_CHAT_ROLES)[number];

export const RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS = 2000;

export interface RfpEvaluationChatMessage {
  id: string;
  rfpRequestId: string;
  evaluationId: string | null;
  authorId: string | null;
  role: RfpEvaluationChatRole;
  body: string;
  createdAt: string;
}

export interface CreateRfpEvaluationChatDTO {
  message: string;
}

/** Recorded Apex-triage override; the original AI evaluation versions stay immutable. */
export interface RfpReviewerDecision {
  verdict: RfpVerdict;
  rationale: string;
  reviewerId: string;
  decidedAt: string;
  sourceMessageIds: string[];
}

export interface SuggestedReviewerDecision {
  verdict: RfpVerdict;
  rationale: string;
  constraintsToAdd: string;
}

export interface ApplyRfpReviewerDecisionDTO {
  verdict: RfpVerdict;
  rationale: string;
  constraintsToAdd?: string | null;
  sourceMessageIds?: string[];
  reevaluate?: boolean;
}

export interface RfpAttachment {
  id: string;
  rfpRequestId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  createdAt: string;
}

export interface RfpRequestEvent {
  id: string;
  rfpRequestId: string;
  eventType: RfpRequestEventType;
  actorId: string | null;
  actorName?: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export function isRfpHumanStatus(value: unknown): value is RfpHumanStatus {
  return typeof value === 'string' && (RFP_HUMAN_STATUSES as readonly string[]).includes(value);
}

export function isRfpAiStatus(value: unknown): value is RfpAiStatus {
  return typeof value === 'string' && (RFP_AI_STATUSES as readonly string[]).includes(value);
}

export function isRfpVerdict(value: unknown): value is RfpVerdict {
  return typeof value === 'string' && (RFP_VERDICTS as readonly string[]).includes(value);
}

export function committedProductBadge(output: Pick<ProductIntakeEvaluationOutput, 'recommendedLane' | 'entersInterviewFlow'>): boolean {
  return output.recommendedLane === 'committed-product' || output.entersInterviewFlow === true;
}

export function isClarificationAvailable(
  clarificationUsed: boolean,
  currentVerdict: RfpVerdict | null | undefined,
): boolean {
  return currentVerdict === 'needs-clarification' && clarificationUsed === false;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validates the Product Intake Evaluation Skill JSON.
 * Returns null when the payload is missing required fields or enum values.
 */
export function parseProductIntakeEvaluationOutput(raw: unknown): ProductIntakeEvaluationOutput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!isOneOf(obj.verdict, RFP_VERDICTS)) return null;
  if (!isOneOf(obj.confidence, RFP_CONFIDENCE_LEVELS)) return null;
  if (!isOneOf(obj.techVelocity, RFP_TECH_VELOCITIES)) return null;
  if (!isOneOf(obj.nativeBenefit, RFP_NATIVE_BENEFITS)) return null;
  if (!isOneOf(obj.audience, RFP_AUDIENCES)) return null;
  if (typeof obj.dataLeavesTenant !== 'boolean') return null;
  if (!isOneOf(obj.priority, RFP_PRIORITIES)) return null;
  if (!isOneOf(obj.risk, RFP_RISKS)) return null;
  if (!isOneOf(obj.deliveryApproach, RFP_DELIVERY_APPROACHES)) return null;
  if (!isOneOf(obj.recommendedLane, RFP_RECOMMENDED_LANES)) return null;
  if (!isStringArray(obj.recommendedTooling)) return null;
  if (!isOneOf(obj.hostingRecommendation, RFP_HOSTING_RECOMMENDATIONS)) return null;
  if (typeof obj.operationalOwner !== 'string') return null;
  if (typeof obj.reuseOpportunity !== 'string') return null;
  if (typeof obj.entersInterviewFlow !== 'boolean') return null;
  if (typeof obj.buildBuyRentSummary !== 'string') return null;
  if (typeof obj.rationale !== 'string') return null;
  if (typeof obj.existingOverlap !== 'string') return null;
  if (!isStringArray(obj.clarifyingQuestions)) return null;

  return {
    verdict: obj.verdict,
    confidence: obj.confidence,
    techVelocity: obj.techVelocity,
    nativeBenefit: obj.nativeBenefit,
    audience: obj.audience,
    dataLeavesTenant: obj.dataLeavesTenant,
    priority: obj.priority,
    risk: obj.risk,
    deliveryApproach: obj.deliveryApproach,
    recommendedLane: obj.recommendedLane,
    recommendedTooling: obj.recommendedTooling,
    hostingRecommendation: obj.hostingRecommendation,
    operationalOwner: obj.operationalOwner,
    reuseOpportunity: obj.reuseOpportunity,
    entersInterviewFlow: obj.entersInterviewFlow,
    buildBuyRentSummary: obj.buildBuyRentSummary,
    rationale: obj.rationale,
    existingOverlap: obj.existingOverlap,
    clarifyingQuestions: obj.clarifyingQuestions,
  };
}

const REQUIRED_INTAKE_KEYS: Array<keyof RfpIntakePayload> = [
  'title',
  'stakeholder',
  'request',
  'problem',
  'audience',
  'dataSensitivity',
  'existingSolution',
];

export function validateRfpIntakePayload(
  payload: RfpIntakePayload,
  options: { requireScaleAndAi?: boolean } = {},
): string[] {
  const errors: string[] = [];
  for (const key of REQUIRED_INTAKE_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${key} is required`);
    }
  }
  if (payload.expectedUsers == null) {
    if (options.requireScaleAndAi) errors.push('expectedUsers is required');
  } else if (!isOneOf(payload.expectedUsers, RFP_EXPECTED_USER_SCALES)) {
    errors.push('expectedUsers is invalid');
  }
  if (payload.aiInApp == null) {
    if (options.requireScaleAndAi) errors.push('aiInApp is required');
  } else if (!isOneOf(payload.aiInApp, RFP_AI_INTENTS)) {
    errors.push('aiInApp is invalid');
  }
  if (payload.audience && !isOneOf(payload.audience, RFP_AUDIENCES)) {
    errors.push('audience is invalid');
  }
  if (payload.dataSensitivity && !isOneOf(payload.dataSensitivity, RFP_DATA_SENSITIVITIES)) {
    errors.push('dataSensitivity is invalid');
  }
  if (payload.requestType != null && payload.requestType !== undefined) {
    if (!isOneOf(payload.requestType, RFP_REQUEST_TYPES)) {
      errors.push('requestType is invalid');
    }
  }
  if (payload.requestType === 'change-existing') {
    if (typeof payload.existingSystemStack !== 'string' || payload.existingSystemStack.trim() === '') {
      errors.push('existingSystemStack is required for change-existing requests');
    }
  }
  return errors;
}

export function validateRfpArchitecture(input: RfpArchitectureInput): string[] {
  const errors: string[] = [];
  if (!isOneOf(input.appType, RFP_APP_TYPES)) errors.push('appType is invalid');
  if (!Array.isArray(input.resources)) {
    errors.push('resources is required');
  } else if (!input.resources.every((resource) => isOneOf(resource, RFP_CLOUD_RESOURCES))) {
    errors.push('resources contains an invalid value');
  }
  if (typeof input.requiresAi !== 'boolean') errors.push('requiresAi is required');
  if (input.appType === 'web' && !input.domainName?.trim()) {
    errors.push('domainName is required for web apps');
  }
  errors.push(...validateRfpArchitectureSizing(input.sizing, input.requiresAi === true));
  return errors;
}

function validateRfpArchitectureSizing(sizing: RfpArchitectureSizing | undefined, requiresAi: boolean): string[] {
  if (!sizing || typeof sizing !== 'object') return ['sizing is required'];
  const errors: string[] = [];
  if (!isOneOf(sizing.region, RFP_DEPLOYMENT_REGIONS)) errors.push('sizing.region is invalid');
  if (!isOneOf(sizing.sizingProfile, RFP_SIZING_PROFILES)) errors.push('sizing.sizingProfile is invalid');
  if (!Number.isInteger(sizing.environmentCount)
    || sizing.environmentCount < 1
    || sizing.environmentCount > RFP_MAX_ENVIRONMENTS) {
    errors.push(`sizing.environmentCount must be between 1 and ${RFP_MAX_ENVIRONMENTS}`);
  }
  if (!isOneOf(sizing.uptimePattern, RFP_UPTIME_PATTERNS)) errors.push('sizing.uptimePattern is invalid');
  if (!isNonNegativeNumber(sizing.storageGb) || sizing.storageGb > RFP_MAX_STORAGE_GB) {
    errors.push(`sizing.storageGb must be between 0 and ${RFP_MAX_STORAGE_GB}`);
  }
  if (requiresAi) {
    if (sizing.aiUsage == null) errors.push('sizing.aiUsage is required when the app requires AI');
    else if (!isOneOf(sizing.aiUsage, RFP_AI_USAGE_LEVELS)) errors.push('sizing.aiUsage is invalid');
  }
  return errors;
}

const SIZING_BY_SCALE: Record<RfpExpectedUserScale, Omit<RfpArchitectureSizing, 'region' | 'aiUsage'> & { aiUsage: RfpAiUsage }> = {
  small: { sizingProfile: 'small', environmentCount: 2, uptimePattern: 'business-hours', storageGb: 20, aiUsage: 'light' },
  medium: { sizingProfile: 'medium', environmentCount: 2, uptimePattern: 'always-on', storageGb: 100, aiUsage: 'moderate' },
  large: { sizingProfile: 'large', environmentCount: 3, uptimePattern: 'always-on', storageGb: 500, aiUsage: 'heavy' },
};

/** Starting assumptions an admin confirms before pricing. */
export function defaultRfpArchitectureSizing(
  expectedUsers: RfpExpectedUserScale | null | undefined,
  requiresAi: boolean,
): RfpArchitectureSizing {
  const preset = SIZING_BY_SCALE[expectedUsers ?? 'medium'];
  return {
    region: 'us-east',
    sizingProfile: preset.sizingProfile,
    environmentCount: preset.environmentCount,
    uptimePattern: preset.uptimePattern,
    storageGb: preset.storageGb,
    aiUsage: requiresAi ? preset.aiUsage : null,
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Reviewer override first, then the current AI verdict. */
export function effectiveRfpVerdict(
  request: Pick<RfpRequest, 'reviewerDecision' | 'currentEvaluation'>,
): RfpVerdict | null {
  return request.reviewerDecision?.verdict ?? request.currentEvaluation?.verdict ?? null;
}

export function rfpDraftKindForVerdict(verdict: RfpVerdict): RfpDraftKind | null {
  if (verdict === 'needs-clarification') return null;
  return verdict === 'decline' ? 'decision-summary' : 'proposal';
}

export function rfpReviewSubmitLabel(verdict: RfpVerdict): string {
  const kind = rfpDraftKindForVerdict(verdict);
  if (kind === 'proposal') return 'Submit for proposal';
  if (kind === 'decision-summary') return 'Submit decision summary';
  return 'Save review';
}

/** Admins unlock Proposal by submitting the review; everyone else waits for publication. */
export function rfpProposalUnlocked(
  request: Pick<RfpRequest, 'reviewSubmittedAt' | 'proposal' | 'approval' | 'reviewerDecision' | 'currentEvaluation'>,
  canManage: boolean,
): boolean {
  if (request.proposal || request.approval) return true;
  if (!canManage || !request.reviewSubmittedAt) return false;
  const verdict = effectiveRfpVerdict(request);
  return verdict !== null && rfpDraftKindForVerdict(verdict) !== null;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function sumAmounts(lines: RfpCostLine[]): RfpCostAmounts {
  const total = { low: 0, expected: 0, high: 0 };
  for (const line of lines) {
    if (!line.amounts) continue;
    total.low += line.amounts.low;
    total.expected += line.amounts.expected;
    total.high += line.amounts.high;
  }
  return { low: roundCents(total.low), expected: roundCents(total.expected), high: roundCents(total.high) };
}

export function computeRfpCostTotals(lines: RfpCostLine[]): RfpCostTotals {
  const monthly = sumAmounts(lines.filter((line) => line.cadence === 'monthly'));
  return {
    oneTime: sumAmounts(lines.filter((line) => line.cadence === 'one-time')),
    monthly,
    annual: {
      low: roundCents(monthly.low * 12),
      expected: roundCents(monthly.expected * 12),
      high: roundCents(monthly.high * 12),
    },
    unpricedLineCount: lines.filter((line) => !line.amounts).length,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function parseCostAmounts(raw: unknown): RfpCostAmounts | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return undefined;
  const { low, expected, high } = raw as Record<string, unknown>;
  if (!isNonNegativeNumber(low) || !isNonNegativeNumber(expected) || !isNonNegativeNumber(high)) return undefined;
  if (low > expected || expected > high) return undefined;
  return { low, expected, high };
}

function parseCostLine(raw: unknown): RfpCostLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.id) || !isNonEmptyString(obj.label)) return null;
  if (!isOneOf(obj.category, RFP_COST_CATEGORIES) || !isOneOf(obj.cadence, RFP_COST_CADENCES)) return null;
  if (!isNonNegativeNumber(obj.quantity) || typeof obj.unit !== 'string') return null;
  if (obj.unitPrice !== null && !isNonNegativeNumber(obj.unitPrice)) return null;
  const amounts = parseCostAmounts(obj.amounts);
  if (amounts === undefined) return null;
  if (obj.currency !== 'USD') return null;
  if (!isOneOf(obj.priceStatus, RFP_PRICE_STATUSES) || !isOneOf(obj.sourceType, RFP_COST_SOURCE_TYPES)) return null;
  if (obj.sourceUrl !== null && !isHttpsUrl(obj.sourceUrl)) return null;
  if (obj.priceStatus === 'verified' && (!isHttpsUrl(obj.sourceUrl) || !isNonEmptyString(obj.retrievedAt))) return null;
  if (obj.sourceTitle !== null && typeof obj.sourceTitle !== 'string') return null;
  if (obj.retrievedAt !== null && typeof obj.retrievedAt !== 'string') return null;
  if (!isOneOf(obj.confidence, RFP_CONFIDENCE_LEVELS) || !isStringArray(obj.assumptions)) return null;
  if (typeof obj.adminConfirmed !== 'boolean') return null;
  return {
    id: obj.id,
    label: obj.label,
    category: obj.category,
    cadence: obj.cadence,
    quantity: obj.quantity,
    unit: obj.unit,
    unitPrice: obj.unitPrice as number | null,
    amounts,
    currency: 'USD',
    priceStatus: obj.priceStatus,
    sourceType: obj.sourceType,
    sourceUrl: obj.sourceUrl as string | null,
    sourceTitle: obj.sourceTitle as string | null,
    retrievedAt: obj.retrievedAt as string | null,
    confidence: obj.confidence,
    assumptions: obj.assumptions,
    adminConfirmed: obj.adminConfirmed,
  };
}

function parseSections(raw: unknown): RfpProposalSections | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const text = ['executiveSummary', 'recommendedSolution', 'timeline', 'securityAndData', 'ownership'] as const;
  if (!text.every((key) => typeof obj[key] === 'string')) return null;
  const lists = ['scope', 'assumptions', 'exclusions', 'nextSteps'] as const;
  if (!lists.every((key) => isStringArray(obj[key]))) return null;
  if (!Array.isArray(obj.deliveryPhases) || !obj.deliveryPhases.every((phase) =>
    phase && typeof phase === 'object'
    && typeof (phase as RfpDeliveryPhase).name === 'string'
    && typeof (phase as RfpDeliveryPhase).duration === 'string'
    && isStringArray((phase as RfpDeliveryPhase).outcomes))) return null;
  if (!Array.isArray(obj.risks) || !obj.risks.every((risk) =>
    risk && typeof risk === 'object'
    && typeof (risk as RfpProposalRisk).risk === 'string'
    && typeof (risk as RfpProposalRisk).mitigation === 'string')) return null;
  return {
    executiveSummary: obj.executiveSummary as string,
    recommendedSolution: obj.recommendedSolution as string,
    scope: obj.scope as string[],
    deliveryPhases: (obj.deliveryPhases as RfpDeliveryPhase[]).map(({ name, duration, outcomes }) => ({ name, duration, outcomes })),
    timeline: obj.timeline as string,
    assumptions: obj.assumptions as string[],
    exclusions: obj.exclusions as string[],
    risks: (obj.risks as RfpProposalRisk[]).map(({ risk, mitigation }) => ({ risk, mitigation })),
    securityAndData: obj.securityAndData as string,
    ownership: obj.ownership as string,
    nextSteps: obj.nextSteps as string[],
  };
}

/** Validates a stored or admin-edited draft. Totals are always recomputed from the lines. */
export function parseRfpGeneratedDraft(raw: unknown): RfpGeneratedDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== RFP_DRAFT_VERSION) return null;
  if (!isNonEmptyString(obj.jobId) || !isNonEmptyString(obj.inputFingerprint)) return null;
  if (!isOneOf(obj.verdict, RFP_VERDICTS) || !isNonEmptyString(obj.generatedAt)) return null;
  if (obj.editedBy !== null && typeof obj.editedBy !== 'string') return null;
  if (obj.editedAt !== null && typeof obj.editedAt !== 'string') return null;
  const base = {
    version: RFP_DRAFT_VERSION,
    jobId: obj.jobId,
    inputFingerprint: obj.inputFingerprint,
    verdict: obj.verdict,
    generatedAt: obj.generatedAt,
    editedBy: obj.editedBy as string | null,
    editedAt: obj.editedAt as string | null,
  };

  if (obj.kind === 'decision-summary') {
    if (typeof obj.summary !== 'string') return null;
    if (!isStringArray(obj.reasons) || !isStringArray(obj.alternatives) || !isStringArray(obj.nextSteps)) return null;
    return {
      ...base,
      kind: 'decision-summary',
      summary: obj.summary,
      reasons: obj.reasons,
      alternatives: obj.alternatives,
      nextSteps: obj.nextSteps,
    };
  }

  if (obj.kind !== 'proposal') return null;
  const sections = parseSections(obj.sections);
  if (!sections || !Array.isArray(obj.costLines)) return null;
  const costLines = obj.costLines.map(parseCostLine);
  if (costLines.some((line) => line === null)) return null;
  const lines = costLines as RfpCostLine[];
  if (new Set(lines.map((line) => line.id)).size !== lines.length) return null;
  return { ...base, kind: 'proposal', sections, costLines: lines, totals: computeRfpCostTotals(lines) };
}

/** Publishing a proposal needs every cost priced and confirmed by an admin. */
export function validateRfpDraftForPublish(draft: RfpGeneratedDraft): string[] {
  if (draft.kind !== 'proposal') return [];
  const errors: string[] = [];
  for (const line of draft.costLines) {
    if (!line.amounts) errors.push(`${line.label} needs an amount`);
    if (!line.adminConfirmed) errors.push(`${line.label} needs admin confirmation`);
  }
  return errors;
}

const RFP_REPO_NAME_MAX = 64;

export function rfpRepoNameFromTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, RFP_REPO_NAME_MAX)
    .replace(/-+$/g, '');
  return slug || 'apex-app';
}

export type RfpWizardStep = 1 | 2 | 3;

export function rfpWizardInitialStep(request: Pick<RfpRequest, 'proposal' | 'approval'>): RfpWizardStep {
  return request.proposal || request.approval ? 3 : 1;
}
