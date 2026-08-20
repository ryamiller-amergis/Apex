/**
 * Shared RFP Intake contracts.
 * Evaluation enums and output shape match `.cursor/skills/product-intake-evaluation/SKILL.md`.
 */

export const RFP_INTAKE_VIEW = 'rfp-intake:view';
export const RFP_INTAKE_MANAGE = 'rfp-intake:manage';

export const RFP_HUMAN_STATUSES = [
  'submitted',
  'evaluating',
  'evaluated',
  'in-review',
  'accepted',
  'declined',
  'on-hold',
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
  status: RfpHumanStatus;
  aiStatus: RfpAiStatus;
  aiThreadId: string | null;
  sourceProject: string;
  currentEvaluationId: string | null;
  clarificationUsed: boolean;
  createdAt: string;
  updatedAt: string;
  currentEvaluation?: RfpEvaluation | null;
}

export interface RfpComment {
  id: string;
  rfpRequestId: string;
  authorId: string;
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

export function validateRfpIntakePayload(payload: RfpIntakePayload): string[] {
  const errors: string[] = [];
  for (const key of REQUIRED_INTAKE_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${key} is required`);
    }
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
