import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import fs from 'fs/promises';
import path from 'path';
import { db } from '../db/drizzle';
import {
  appPermissions,
  appRolePermissions,
  appUserRoles,
  appUsers,
  rfpAttachments,
  rfpComments,
  rfpEvaluations,
  rfpProposalJobs,
  rfpRequestEvents,
  rfpRequests,
  userProjectAssignments,
} from '../db/schema';
import { DEV_MOCK_USERS } from '../../shared/constants/devMockUsers';
import {
  RFP_INTAKE_MANAGE,
  RFP_INTAKE_VIEW,
  canReopenRfp,
  canTransitionRfpStatus,
  committedProductBadge,
  isClarificationAvailable,
  isRfpHumanStatus,
  isRfpVerdict,
  rfpRequestorLink,
  rfpTriageLink,
  sanitizeRfpFilename,
  validateRfpAttachments,
  validateRfpIntakePayload,
  type ApplyRfpReviewerDecisionDTO,
  type CreateRfpCommentDTO,
  type ProductIntakeEvaluationOutput,
  type RfpApproval,
  type RfpAttachment,
  type RfpAttachmentCandidate,
  type RfpClarificationInput,
  type RfpComment,
  type RfpEvaluation,
  type RfpHumanStatus,
  type RfpIntakePayload,
  type RfpMentionCandidate,
  type RfpNotifyKind,
  type RfpOwnerListResponse,
  type RfpProposal,
  type RfpProposalGeneration,
  type RfpRecipient,
  type RfpRequest,
  type RfpRequestDetail,
  type RfpRequestEvent,
  type RfpRequestEventType,
  type RfpReviewerDecision,
  type RfpTriageDetail,
  type RfpTriageListQuery,
  type RfpTriageListResponse,
  type RfpVerdict,
} from '../../shared/types/rfpIntake';
import { appendReviewerConstraints } from '../../shared/utils/rfpReviewerDecision';
import { getUserPermissions } from './rbacService';
import { getSuperAdminEmails } from '../utils/superAdmin';
import { resolveDataRoot } from '../utils/dataDir';
import { createNotification } from './notificationService';
import { getAssignmentsForProject } from './userProjectAssignmentService';

export const APEX_PROJECT = 'Apex';

export class RfpIntakeError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'RfpIntakeError';
    this.status = status;
    this.code = code;
  }
}

export type RfpEvaluationNotificationHook = (payload: {
  kind: 'completed' | 'failed';
  request: RfpRequest;
  evaluation?: RfpEvaluation;
}) => Promise<void> | void;

let notificationHook: RfpEvaluationNotificationHook = async () => {};

export function setRfpEvaluationNotificationHook(hook: RfpEvaluationNotificationHook): void {
  notificationHook = hook;
}

type RequestRow = typeof rfpRequests.$inferSelect;
type EvaluationRow = typeof rfpEvaluations.$inferSelect;
type ProposalJobRow = typeof rfpProposalJobs.$inferSelect;

function nowIso(): string {
  return new Date().toISOString();
}

function mapReviewerDecision(row: RequestRow): RfpReviewerDecision | null {
  if (!row.reviewerVerdict || !row.reviewerRationale || !row.reviewerId || !row.reviewerDecidedAt) {
    return null;
  }
  return {
    verdict: row.reviewerVerdict,
    rationale: row.reviewerRationale,
    reviewerId: row.reviewerId,
    decidedAt: row.reviewerDecidedAt,
    sourceMessageIds: row.reviewerSourceMessageIds ?? [],
  };
}

function mapApproval(row: RequestRow): RfpApproval | null {
  if (!row.approvedAt || !row.approvedRepoName || !row.approvedRepoUrl || !row.apexProject) return null;
  return {
    approvedAt: row.approvedAt,
    repoName: row.approvedRepoName,
    repoUrl: row.approvedRepoUrl,
    apexProject: row.apexProject,
  };
}

function mapProposalGeneration(job: ProposalJobRow | null | undefined): RfpProposalGeneration | null {
  if (!job) return null;
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage ?? null,
    queuedAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
  };
}

/** Proposals published before generated drafts existed have no document and are no longer shown. */
function mapProposal(row: RequestRow): RfpProposal | null {
  return row.proposal && typeof row.proposal === 'object' && 'document' in row.proposal ? row.proposal : null;
}

/** Requesters never see drafts or generation state; only the published proposal. */
export function toRequesterView<T extends RfpRequest>(request: T): T {
  return { ...request, proposalDraft: null, proposalGeneration: null };
}

function mapRequest(
  row: RequestRow,
  currentEvaluation?: RfpEvaluation | null,
  proposalJob?: ProposalJobRow | null,
): RfpRequest {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    stakeholder: row.stakeholder,
    request: row.request,
    problem: row.problem,
    audience: row.audience,
    dataSensitivity: row.dataSensitivity,
    existingSolution: row.existingSolution,
    advantage: row.advantage ?? null,
    constraints: row.constraints ?? null,
    requestType: row.requestType ?? null,
    existingSystemStack: row.existingSystemStack ?? null,
    expectedUsers: row.expectedUsers ?? null,
    aiInApp: row.aiInApp ?? null,
    status: row.status,
    aiStatus: row.aiStatus,
    aiThreadId: row.aiThreadId ?? null,
    sourceProject: row.sourceProject,
    currentEvaluationId: row.currentEvaluationId ?? null,
    clarificationUsed: row.clarificationUsed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    currentEvaluation: currentEvaluation ?? null,
    reviewerDecision: mapReviewerDecision(row),
    architecture: row.architecture ?? null,
    reviewSubmittedAt: row.reviewSubmittedAt ?? null,
    reviewSubmittedBy: row.reviewSubmittedBy ?? null,
    proposalGeneration: mapProposalGeneration(proposalJob),
    proposalDraft: row.proposalDraft ?? null,
    proposal: mapProposal(row),
    approval: mapApproval(row),
  };
}

export function mapEvaluation(row: EvaluationRow): RfpEvaluation {
  const output: ProductIntakeEvaluationOutput = {
    verdict: row.verdict,
    confidence: row.confidence,
    techVelocity: row.techVelocity,
    nativeBenefit: row.nativeBenefit,
    audience: row.audience,
    dataLeavesTenant: row.dataLeavesTenant,
    priority: row.priority,
    risk: row.risk,
    deliveryApproach: row.deliveryApproach,
    recommendedLane: row.recommendedLane,
    recommendedTooling: row.recommendedTooling ?? [],
    hostingRecommendation: row.hostingRecommendation,
    operationalOwner: row.operationalOwner,
    reuseOpportunity: row.reuseOpportunity,
    entersInterviewFlow: row.entersInterviewFlow,
    buildBuyRentSummary: row.buildBuyRentSummary,
    rationale: row.rationale,
    existingOverlap: row.existingOverlap,
    clarifyingQuestions: row.clarifyingQuestions ?? [],
  };
  return {
    ...output,
    id: row.id,
    rfpRequestId: row.rfpRequestId,
    version: row.version,
    rawOutput: row.rawOutput,
    committedProductBadge: committedProductBadge(output),
    createdAt: row.createdAt,
  };
}

function intakeValues(payload: RfpIntakePayload) {
  const requestType = payload.requestType ?? null;
  return {
    title: payload.title.trim(),
    stakeholder: payload.stakeholder.trim(),
    request: payload.request.trim(),
    problem: payload.problem.trim(),
    audience: payload.audience,
    dataSensitivity: payload.dataSensitivity,
    existingSolution: payload.existingSolution.trim(),
    advantage: payload.advantage?.trim() || null,
    constraints: payload.constraints?.trim() || null,
    requestType,
    existingSystemStack:
      requestType === 'change-existing'
        ? (payload.existingSystemStack?.trim() || null)
        : null,
    expectedUsers: payload.expectedUsers ?? null,
    aiInApp: payload.aiInApp ?? null,
  };
}

async function appendEvent(
  rfpRequestId: string,
  eventType: RfpRequestEventType,
  actorId: string | null,
  payload: Record<string, unknown> | null = null,
): Promise<void> {
  await db.insert(rfpRequestEvents).values({
    rfpRequestId,
    eventType,
    actorId,
    payload,
  });
}

export async function getRequestById(rfpId: string): Promise<RfpRequest | null> {
  const row = await db.query.rfpRequests.findFirst({
    where: eq(rfpRequests.id, rfpId),
  });
  if (!row) return null;
  let current: RfpEvaluation | null = null;
  if (row.currentEvaluationId) {
    const evaluation = await db.query.rfpEvaluations.findFirst({
      where: eq(rfpEvaluations.id, row.currentEvaluationId),
    });
    current = evaluation ? mapEvaluation(evaluation) : null;
  }
  const proposalJob = row.currentProposalJobId
    ? await db.query.rfpProposalJobs.findFirst({ where: eq(rfpProposalJobs.id, row.currentProposalJobId) })
    : null;
  return mapRequest(row, current, proposalJob);
}

export async function listEvaluations(rfpId: string): Promise<RfpEvaluation[]> {
  const rows = await db.query.rfpEvaluations.findMany({
    where: eq(rfpEvaluations.rfpRequestId, rfpId),
    orderBy: [asc(rfpEvaluations.version)],
  });
  return rows.map(mapEvaluation);
}

async function currentVerdict(request: RfpRequest): Promise<RfpVerdict | null> {
  if (!request.currentEvaluation) return request.currentEvaluationId
    ? ((await getRequestById(request.id))?.currentEvaluation?.verdict ?? null)
    : null;
  return request.currentEvaluation.verdict;
}

export async function actorCanViewRfp(
  actorId: string,
  request: RfpRequest,
  options?: { isSuperAdmin?: boolean },
): Promise<boolean> {
  if (options?.isSuperAdmin) return true;
  if (request.ownerId === actorId) return true;
  const permissions = await getUserPermissions(actorId, APEX_PROJECT);
  return permissions.has(RFP_INTAKE_VIEW) || permissions.has(RFP_INTAKE_MANAGE);
}

export async function actorCanManageRfp(actorId: string): Promise<boolean> {
  const permissions = await getUserPermissions(actorId, APEX_PROJECT);
  return permissions.has(RFP_INTAKE_MANAGE);
}

async function requireManage(actorId: string): Promise<void> {
  if (!(await actorCanManageRfp(actorId))) {
    throw new RfpIntakeError('Forbidden', 403, 'FORBIDDEN');
  }
}

async function requireOwnedOrNotFound(rfpId: string, ownerId: string): Promise<RfpRequest> {
  const request = await getRequestById(rfpId);
  if (!request || request.ownerId !== ownerId) {
    throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  }
  return toRequesterView(request);
}

function mapComment(row: typeof rfpComments.$inferSelect, authorName?: string): RfpComment {
  return {
    id: row.id,
    rfpRequestId: row.rfpRequestId,
    authorId: row.authorId,
    authorName,
    body: row.body,
    mentionedUserIds: row.mentionedUserIds ?? [],
    createdAt: row.createdAt,
  };
}

function mapAttachment(row: typeof rfpAttachments.$inferSelect): RfpAttachment {
  return {
    id: row.id,
    rfpRequestId: row.rfpRequestId,
    commentId: row.commentId ?? null,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    createdAt: row.createdAt,
  };
}

function mapEvent(row: typeof rfpRequestEvents.$inferSelect, actorName?: string): RfpRequestEvent {
  return {
    id: row.id,
    rfpRequestId: row.rfpRequestId,
    eventType: row.eventType,
    actorId: row.actorId ?? null,
    actorName,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
  };
}

const AI_EVENT_TYPES = new Set<RfpRequestEventType>([
  'evaluation-started',
  'evaluation-completed',
  'evaluation-failed',
]);

const DEV_MOCK_NAMES = new Map(DEV_MOCK_USERS.map((user) => [user.oid, user.displayName]));

function labelForActor(
  oid: string,
  row?: { displayName: string | null; email: string | null },
): string {
  const storedName = row?.displayName?.trim();
  if (storedName && storedName.toLowerCase() !== 'user') return storedName;
  const personaName = DEV_MOCK_NAMES.get(oid);
  if (personaName) return personaName;
  const emailName = row?.email?.trim();
  if (emailName) return emailName;
  return 'User';
}

async function loadRfpActorNames(
  commentRows: Array<typeof rfpComments.$inferSelect>,
  eventRows: Array<typeof rfpRequestEvents.$inferSelect>,
): Promise<Map<string, string>> {
  const ids = [...new Set([
    ...commentRows.map((row) => row.authorId),
    ...eventRows.flatMap((row) => row.actorId ? [row.actorId] : []),
  ])];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ oid: appUsers.oid, displayName: appUsers.displayName, email: appUsers.email })
    .from(appUsers)
    .where(inArray(appUsers.oid, ids));
  const byOid = new Map(rows.map((row) => [row.oid, row]));
  return new Map(ids.map((id) => [id, labelForActor(id, byOid.get(id))]));
}

function eventActorName(
  row: typeof rfpRequestEvents.$inferSelect,
  actorNames: Map<string, string>,
): string {
  if (AI_EVENT_TYPES.has(row.eventType)) return 'Apex Bot';
  if (!row.actorId) return 'Apex system';
  return actorNames.get(row.actorId) ?? 'User';
}

function attachmentDir(rfpId: string): string {
  return path.join(resolveDataRoot(), 'rfp-attachments', rfpId);
}

async function startEvaluation(rfpId: string): Promise<void> {
  const { autoStartEvaluation } = await import('./rfpEvaluationOrchestrationService');
  await autoStartEvaluation(rfpId);
}

async function abandonCreatedRequest(rfpId: string): Promise<void> {
  try {
    await fs.rm(attachmentDir(rfpId), { recursive: true, force: true });
  } catch {
    // Directory may not exist if no bytes were written.
  }
  await db.delete(rfpRequests).where(eq(rfpRequests.id, rfpId));
}

export async function createRequest(
  ownerId: string,
  payload: RfpIntakePayload,
  files: Array<RfpAttachmentCandidate & { buffer: Buffer }> = [],
): Promise<RfpRequest> {
  const errors = validateRfpIntakePayload(payload, { requireScaleAndAi: true });
  if (errors.length > 0) {
    throw new RfpIntakeError(errors.join('; '), 400, 'VALIDATION');
  }

  const [row] = await db.insert(rfpRequests).values({
    ownerId,
    sourceProject: APEX_PROJECT,
    status: 'evaluating',
    aiStatus: 'evaluating',
    clarificationUsed: false,
    ...intakeValues(payload),
  }).returning();

  if (!row) {
    throw new RfpIntakeError('Failed to create RFP', 500, 'CREATE_FAILED');
  }

  await appendEvent(row.id, 'submitted', ownerId, { title: row.title });
  try {
    for (const file of files) {
      await addAttachment(row.id, ownerId, file);
    }
    await startEvaluation(row.id);
  } catch (err) {
    try {
      await abandonCreatedRequest(row.id);
    } catch {
      // Keep the original persist error; rollback is best-effort.
    }
    throw err;
  }
  const created = await getRequestById(row.id);
  return created ?? mapRequest(row);
}

export async function answerClarification(
  rfpId: string,
  ownerId: string,
  payload: RfpClarificationInput,
): Promise<RfpRequest> {
  const request = await requireOwnedOrNotFound(rfpId, ownerId);

  const verdict = await currentVerdict(request);
  if (!isClarificationAvailable(request.clarificationUsed, verdict)) {
    throw new RfpIntakeError(
      'Clarification resubmission is not available',
      403,
      'CLARIFICATION_USED',
    );
  }

  const merged: RfpIntakePayload = {
    title: payload.title ?? request.title,
    stakeholder: payload.stakeholder ?? request.stakeholder,
    request: payload.request ?? request.request,
    problem: payload.problem ?? request.problem,
    audience: payload.audience ?? request.audience,
    dataSensitivity: payload.dataSensitivity ?? request.dataSensitivity,
    existingSolution: payload.existingSolution ?? request.existingSolution,
    advantage: payload.advantage !== undefined ? payload.advantage : request.advantage,
    constraints: payload.constraints !== undefined ? payload.constraints : request.constraints,
    requestType: payload.requestType !== undefined ? payload.requestType : request.requestType,
    existingSystemStack:
      payload.existingSystemStack !== undefined
        ? payload.existingSystemStack
        : request.existingSystemStack,
    expectedUsers: payload.expectedUsers ?? request.expectedUsers,
    aiInApp: payload.aiInApp ?? request.aiInApp,
  };
  const errors = validateRfpIntakePayload(merged);
  if (errors.length > 0) {
    throw new RfpIntakeError(errors.join('; '), 400, 'VALIDATION');
  }

  const timestamp = nowIso();
  await db.update(rfpRequests)
    .set({
      ...intakeValues(merged),
      clarificationUsed: true,
      status: 'evaluating',
      aiStatus: 'evaluating',
      aiThreadId: null,
      updatedAt: timestamp,
    })
    .where(eq(rfpRequests.id, rfpId));

  await appendEvent(rfpId, 'clarification-submitted', ownerId, {
    clarifyingAnswers: payload.clarifyingAnswers ?? [],
  });
  await startEvaluation(rfpId);
  const updated = await getRequestById(rfpId);
  if (!updated) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  return toRequesterView(updated);
}

export async function retryEvaluation(rfpId: string, actorId: string): Promise<RfpRequest> {
  await requireManage(actorId);
  const request = await getRequestById(rfpId);
  if (!request) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  if (request.aiStatus !== 'failed') {
    throw new RfpIntakeError('Retry is only available after a failed evaluation', 409, 'INVALID_STATE');
  }

  await db.update(rfpRequests)
    .set({
      aiStatus: 'evaluating',
      aiThreadId: null,
      status: 'evaluating',
      updatedAt: nowIso(),
    })
    .where(eq(rfpRequests.id, rfpId));

  await appendEvent(rfpId, 'evaluation-retried', actorId, {
    clarificationUsed: request.clarificationUsed,
  });
  await startEvaluation(rfpId);
  const updated = await getRequestById(rfpId);
  if (!updated) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  return updated;
}

export async function reevaluate(rfpId: string, actorId: string): Promise<RfpRequest> {
  await requireManage(actorId);
  const request = await getRequestById(rfpId);
  if (!request) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  if (request.aiStatus === 'evaluating') {
    throw new RfpIntakeError('An evaluation is already in progress', 409, 'INVALID_STATE');
  }

  await db.update(rfpRequests)
    .set({
      aiStatus: 'evaluating',
      aiThreadId: null,
      status: 'evaluating',
      updatedAt: nowIso(),
    })
    .where(eq(rfpRequests.id, rfpId));

  await appendEvent(rfpId, 'reevaluation-requested', actorId, null);
  await startEvaluation(rfpId);
  const updated = await getRequestById(rfpId);
  if (!updated) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  return updated;
}

function sanitizeSourceMessageIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
    .slice(0, 20);
}

export async function applyReviewerDecision(
  rfpId: string,
  actorId: string,
  dto: ApplyRfpReviewerDecisionDTO,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpRequest> {
  if (!options?.isSuperAdmin) await requireManage(actorId);
  if (!isRfpVerdict(dto.verdict)) {
    throw new RfpIntakeError('verdict is invalid', 400, 'VALIDATION');
  }
  const rationale = typeof dto.rationale === 'string' ? dto.rationale.trim() : '';
  if (!rationale) {
    throw new RfpIntakeError('rationale is required', 400, 'VALIDATION');
  }

  const request = await getRequestById(rfpId);
  if (!request) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  if (request.aiStatus === 'evaluating') {
    throw new RfpIntakeError('An evaluation is already in progress', 409, 'INVALID_STATE');
  }

  const constraintsToAdd = typeof dto.constraintsToAdd === 'string' ? dto.constraintsToAdd.trim() : '';
  const nextConstraints = appendReviewerConstraints(request.constraints, rationale, constraintsToAdd || null);
  const sourceMessageIds = sanitizeSourceMessageIds(dto.sourceMessageIds);
  const shouldReevaluate = dto.reevaluate !== false;
  const decidedAt = nowIso();

  await db.update(rfpRequests)
    .set({
      constraints: nextConstraints,
      reviewerVerdict: dto.verdict,
      reviewerRationale: rationale,
      reviewerId: actorId,
      reviewerDecidedAt: decidedAt,
      reviewerSourceMessageIds: sourceMessageIds,
      ...(shouldReevaluate
        ? { aiStatus: 'evaluating' as const, aiThreadId: null, status: 'evaluating' as const }
        : {}),
      updatedAt: decidedAt,
    })
    .where(eq(rfpRequests.id, rfpId));

  await appendEvent(rfpId, 'reviewer-decision-applied', actorId, {
    verdict: dto.verdict,
    previousAiVerdict: request.currentEvaluation?.verdict ?? null,
    reevaluate: shouldReevaluate,
    sourceMessageIds,
  });

  if (shouldReevaluate) {
    await appendEvent(rfpId, 'reevaluation-requested', actorId, null);
    await startEvaluation(rfpId);
  }

  const updated = await getRequestById(rfpId);
  if (!updated) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  return updated;
}

export async function persistSuccessfulEvaluation(
  rfpId: string,
  output: ProductIntakeEvaluationOutput,
): Promise<RfpEvaluation | null> {
  const evaluation = await db.transaction(async (tx) => {
    const existing = await tx.query.rfpEvaluations.findMany({
      where: eq(rfpEvaluations.rfpRequestId, rfpId),
      columns: { version: true },
    });
    const nextVersion = existing.reduce((maxVersion, row) => Math.max(maxVersion, row.version), 0) + 1;
    const [inserted] = await tx.insert(rfpEvaluations).values({
      rfpRequestId: rfpId,
      version: nextVersion,
      verdict: output.verdict,
      confidence: output.confidence,
      techVelocity: output.techVelocity,
      nativeBenefit: output.nativeBenefit,
      audience: output.audience,
      dataLeavesTenant: output.dataLeavesTenant,
      priority: output.priority,
      risk: output.risk,
      deliveryApproach: output.deliveryApproach,
      recommendedLane: output.recommendedLane,
      recommendedTooling: output.recommendedTooling,
      hostingRecommendation: output.hostingRecommendation,
      operationalOwner: output.operationalOwner,
      reuseOpportunity: output.reuseOpportunity,
      entersInterviewFlow: output.entersInterviewFlow,
      buildBuyRentSummary: output.buildBuyRentSummary,
      rationale: output.rationale,
      existingOverlap: output.existingOverlap,
      clarifyingQuestions: output.clarifyingQuestions,
      rawOutput: output,
    }).returning();

    if (!inserted) return null;

    await tx.update(rfpRequests)
      .set({
        currentEvaluationId: inserted.id,
        status: 'evaluated',
        aiStatus: 'complete',
        updatedAt: nowIso(),
      })
      .where(eq(rfpRequests.id, rfpId));

    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'evaluation-completed',
      actorId: null,
      payload: {
        evaluationId: inserted.id,
        version: nextVersion,
        verdict: output.verdict,
      },
    });

    return mapEvaluation(inserted);
  });

  if (evaluation) {
    const request = await getRequestById(rfpId);
    if (request) {
      await notificationHook({ kind: 'completed', request, evaluation });
    }
  }
  return evaluation;
}

export async function markEvaluationFailedIfEvaluating(rfpId: string, reason?: string): Promise<boolean> {
  const updated = await db.update(rfpRequests)
    .set({ aiStatus: 'failed', updatedAt: nowIso() })
    .where(and(
      eq(rfpRequests.id, rfpId),
      eq(rfpRequests.aiStatus, 'evaluating'),
    ))
    .returning();

  if (updated.length === 0) return false;

  const trimmed = reason?.trim();
  await appendEvent(rfpId, 'evaluation-failed', null, trimmed ? { reason: trimmed.slice(0, 500) } : null);
  const request = await getRequestById(rfpId);
  if (request) {
    await notificationHook({ kind: 'failed', request });
  }
  return true;
}

export async function setEvaluationThread(rfpId: string, threadId: string): Promise<void> {
  await db.update(rfpRequests)
    .set({
      aiStatus: 'evaluating',
      aiThreadId: threadId,
      updatedAt: nowIso(),
    })
    .where(eq(rfpRequests.id, rfpId));
  await appendEvent(rfpId, 'evaluation-started', null, { threadId });
}

/**
 * FEAT-003 owns the production recipient resolver. This stub mirrors the
 * feature-request reviewer pattern: Apex `rfp-intake:manage` holders plus
 * Platform Admins (super-admin emails).
 */
export async function resolveRfpSubmissionRecipients(): Promise<string[]> {
  const permissionRows = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .innerJoin(appUserRoles, eq(userProjectAssignments.userId, appUserRoles.userId))
    .innerJoin(appRolePermissions, eq(appUserRoles.roleId, appRolePermissions.roleId))
    .innerJoin(appPermissions, eq(appRolePermissions.permissionId, appPermissions.id))
    .where(
      and(
        eq(userProjectAssignments.project, APEX_PROJECT),
        eq(appPermissions.key, RFP_INTAKE_MANAGE),
      ),
    );

  const userIds = new Set(permissionRows.map((row) => row.userId));
  const superAdminEmails = getSuperAdminEmails().map((email) => email.toLowerCase());
  if (superAdminEmails.length > 0) {
    const superAdminRows = await db
      .select({ oid: appUsers.oid })
      .from(appUsers)
      .where(or(...superAdminEmails.map((email) => sql`lower(${appUsers.email}) = ${email}`)));
    for (const row of superAdminRows) {
      userIds.add(row.oid);
    }
  }
  return [...userIds];
}

export async function listOwnerRequests(
  ownerId: string,
  page: { limit: number; offset: number },
): Promise<RfpOwnerListResponse> {
  const limit = Math.min(Math.max(page.limit, 1), 50);
  const offset = Math.max(page.offset, 0);

  const [rows, totals] = await Promise.all([
    db.query.rfpRequests.findMany({
      where: eq(rfpRequests.ownerId, ownerId),
      orderBy: [desc(rfpRequests.createdAt)],
      limit,
      offset,
      with: { currentEvaluation: true },
    }),
    db.select({ total: count() }).from(rfpRequests).where(eq(rfpRequests.ownerId, ownerId)),
  ]);

  return {
    total: Number(totals[0]?.total ?? 0),
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      aiStatus: row.aiStatus,
      currentVerdict: row.currentEvaluation?.verdict ?? null,
      clarificationUsed: row.clarificationUsed,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  };
}

export async function getOwnerRequestDetail(rfpId: string, ownerId: string): Promise<RfpRequestDetail> {
  const request = await requireOwnedOrNotFound(rfpId, ownerId);
  const [commentRows, attachmentRows, eventRows] = await Promise.all([
    db.query.rfpComments.findMany({
      where: eq(rfpComments.rfpRequestId, rfpId),
      orderBy: [asc(rfpComments.createdAt)],
    }),
    db.query.rfpAttachments.findMany({
      where: eq(rfpAttachments.rfpRequestId, rfpId),
      orderBy: [asc(rfpAttachments.createdAt)],
    }),
    db.query.rfpRequestEvents.findMany({
      where: eq(rfpRequestEvents.rfpRequestId, rfpId),
      orderBy: [asc(rfpRequestEvents.createdAt)],
    }),
  ]);
  const actorNames = await loadRfpActorNames(commentRows, eventRows);

  return {
    ...request,
    comments: commentRows.map((row) => mapComment(row, actorNames.get(row.authorId) ?? 'User')),
    attachments: attachmentRows.map(mapAttachment),
    activity: eventRows.map((row) => mapEvent(row, eventActorName(row, actorNames))),
  };
}

export async function listOwnerComments(rfpId: string, ownerId: string): Promise<RfpComment[]> {
  await requireOwnedOrNotFound(rfpId, ownerId);
  const rows = await db.query.rfpComments.findMany({
    where: eq(rfpComments.rfpRequestId, rfpId),
    orderBy: [asc(rfpComments.createdAt)],
  });
  return rows.map((row) => mapComment(row));
}

export async function addOwnerComment(
  rfpId: string,
  ownerId: string,
  dto: CreateRfpCommentDTO,
): Promise<RfpComment> {
  return addComment(rfpId, ownerId, dto);
}

export async function addOwnerAttachment(
  rfpId: string,
  ownerId: string,
  file: RfpAttachmentCandidate & { buffer: Buffer },
  commentId?: string | null,
): Promise<RfpAttachment> {
  return addAttachment(rfpId, ownerId, file, commentId);
}

export async function getOwnerAttachment(
  rfpId: string,
  attachmentId: string,
  ownerId: string,
): Promise<{ attachment: RfpAttachment; filePath: string }> {
  return getAttachment(rfpId, attachmentId, ownerId);
}

async function requireView(actorId: string, isSuperAdmin = false): Promise<void> {
  if (isSuperAdmin) return;
  const permissions = await getUserPermissions(actorId, APEX_PROJECT);
  if (!permissions.has(RFP_INTAKE_VIEW) && !permissions.has(RFP_INTAKE_MANAGE)) {
    throw new RfpIntakeError('Forbidden', 403, 'FORBIDDEN');
  }
}

async function loadAuthorizedRequest(
  rfpId: string,
  actorId: string,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpRequest> {
  const request = await getRequestById(rfpId);
  if (!request || !(await actorCanViewRfp(actorId, request, options))) {
    throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  }
  return request;
}

export async function listMentionCandidates(rfpId: string, q = ''): Promise<RfpMentionCandidate[]> {
  const request = await getRequestById(rfpId);
  const assignments = await getAssignmentsForProject(APEX_PROJECT);
  const byId = new Map<string, RfpMentionCandidate>();
  for (const row of assignments) {
    byId.set(row.userId, {
      userId: row.userId,
      displayName: row.displayName,
      email: row.email,
    });
  }
  if (request && !byId.has(request.ownerId)) {
    const ownerRows = await db
      .select({ oid: appUsers.oid, displayName: appUsers.displayName, email: appUsers.email })
      .from(appUsers)
      .where(eq(appUsers.oid, request.ownerId));
    const owner = ownerRows[0];
    if (owner) {
      byId.set(owner.oid, {
        userId: owner.oid,
        displayName: owner.displayName ?? owner.oid,
        email: owner.email ?? '',
      });
    }
  }
  const term = q.trim().toLowerCase();
  return [...byId.values()].filter((candidate) => {
    if (!term) return true;
    return (
      candidate.displayName.toLowerCase().includes(term)
      || candidate.email.toLowerCase().includes(term)
      || candidate.userId.toLowerCase().includes(term)
    );
  });
}

export async function resolveMentions(rfpId: string, candidateIds: string[]): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const allowed = new Set((await listMentionCandidates(rfpId)).map((row) => row.userId));
  return [...new Set(candidateIds)].filter((id) => allowed.has(id));
}

export async function resolveRecipients(event: {
  kind: RfpNotifyKind;
  request: Pick<RfpRequest, 'id' | 'ownerId' | 'title'>;
  actorId?: string | null;
  mentionUserIds?: string[];
}): Promise<RfpRecipient[]> {
  const requestorLink = rfpRequestorLink(event.request.id);
  const triageLink = rfpTriageLink(event.request.id);
  const needsReviewers =
    event.kind === 'submitted'
    || event.kind === 'evaluation-completed'
    || event.kind === 'evaluation-failed';
  const reviewers = needsReviewers ? await resolveRfpSubmissionRecipients() : [];
  const actorId = event.actorId ?? null;
  const unique = new Map<string, RfpRecipient>();

  const add = (userId: string, link: string, type: RfpRecipient['type']) => {
    if (!userId || userId === actorId) return;
    unique.set(`${userId}:${link}`, { userId, link, type });
  };

  switch (event.kind) {
    case 'submitted':
      for (const userId of reviewers) add(userId, triageLink, 'user-action');
      break;
    case 'evaluation-completed':
      for (const userId of reviewers) add(userId, triageLink, 'ai');
      add(event.request.ownerId, requestorLink, 'ai');
      break;
    case 'evaluation-failed':
      for (const userId of reviewers) add(userId, triageLink, 'user-action');
      add(event.request.ownerId, requestorLink, 'user-action');
      break;
    case 'status-changed':
    case 'reopened':
      add(event.request.ownerId, requestorLink, 'user-action');
      break;
    case 'comment-added':
      add(event.request.ownerId, requestorLink, 'user-action');
      for (const mentionId of event.mentionUserIds ?? []) {
        add(mentionId, mentionId === event.request.ownerId ? requestorLink : triageLink, 'user-action');
      }
      break;
    default:
      break;
  }

  return [...unique.values()];
}

const NOTIFY_TITLES: Record<RfpNotifyKind, string> = {
  submitted: 'New request for product',
  'evaluation-completed': 'Product intake evaluation complete',
  'evaluation-failed': 'Product intake evaluation failed',
  'status-changed': 'Request for product status updated',
  reopened: 'Request for product reopened',
  'comment-added': 'New comment on a request for product',
};

export async function dispatchRfpNotifications(event: {
  kind: RfpNotifyKind;
  request: Pick<RfpRequest, 'id' | 'ownerId' | 'title'>;
  actorId?: string | null;
  mentionUserIds?: string[];
}): Promise<void> {
  const recipients = await resolveRecipients(event);
  for (const recipient of recipients) {
    try {
      await createNotification(recipient.userId, {
        type: recipient.type,
        title: NOTIFY_TITLES[event.kind],
        body: event.request.title,
        link: recipient.link,
      });
    } catch {
      // Delivery is best-effort and must not roll back the persisted action.
    }
  }
}

async function loadTriageCollections(rfpId: string): Promise<Pick<RfpTriageDetail, 'comments' | 'attachments' | 'activity' | 'evaluations'>> {
  const [commentRows, attachmentRows, eventRows, evaluationRows] = await Promise.all([
    db.query.rfpComments.findMany({
      where: eq(rfpComments.rfpRequestId, rfpId),
      orderBy: [asc(rfpComments.createdAt)],
    }),
    db.query.rfpAttachments.findMany({
      where: eq(rfpAttachments.rfpRequestId, rfpId),
      orderBy: [asc(rfpAttachments.createdAt)],
    }),
    db.query.rfpRequestEvents.findMany({
      where: eq(rfpRequestEvents.rfpRequestId, rfpId),
      orderBy: [asc(rfpRequestEvents.createdAt)],
    }),
    db.query.rfpEvaluations.findMany({
      where: eq(rfpEvaluations.rfpRequestId, rfpId),
      orderBy: [asc(rfpEvaluations.version)],
    }),
  ]);
  const actorNames = await loadRfpActorNames(commentRows, eventRows);
  return {
    comments: commentRows.map((row) => mapComment(row, actorNames.get(row.authorId) ?? 'User')),
    attachments: attachmentRows.map(mapAttachment),
    activity: eventRows.map((row) => mapEvent(row, eventActorName(row, actorNames))),
    evaluations: evaluationRows.map(mapEvaluation),
  };
}

export async function listTriageRequests(
  actorId: string,
  query: RfpTriageListQuery,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpTriageListResponse> {
  await requireView(actorId, options?.isSuperAdmin);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
  const offset = Math.max(query.offset ?? 0, 0);
  const filters = [];
  if (query.status && isRfpHumanStatus(query.status)) {
    filters.push(eq(rfpRequests.status, query.status));
  }
  if (query.q?.trim()) {
    const term = `%${query.q.trim()}%`;
    filters.push(or(ilike(rfpRequests.title, term), ilike(rfpRequests.stakeholder, term)));
  }
  if (query.verdict && isRfpVerdict(query.verdict)) {
    filters.push(eq(rfpEvaluations.verdict, query.verdict));
  }
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        request: rfpRequests,
        evaluation: rfpEvaluations,
      })
      .from(rfpRequests)
      .leftJoin(rfpEvaluations, eq(rfpRequests.currentEvaluationId, rfpEvaluations.id))
      .where(whereClause)
      .orderBy(desc(rfpRequests.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(rfpRequests)
      .leftJoin(rfpEvaluations, eq(rfpRequests.currentEvaluationId, rfpEvaluations.id))
      .where(whereClause),
  ]);

  return {
    total: Number(totals[0]?.total ?? 0),
    items: rows.map(({ request, evaluation }) => ({
      id: request.id,
      ownerId: request.ownerId,
      title: request.title,
      stakeholder: request.stakeholder,
      status: request.status,
      aiStatus: request.aiStatus,
      currentVerdict: evaluation?.verdict ?? null,
      clarificationUsed: request.clarificationUsed,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    })),
  };
}

export async function getTriageDetail(
  rfpId: string,
  actorId: string,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpTriageDetail> {
  await requireView(actorId, options?.isSuperAdmin);
  const request = await getRequestById(rfpId);
  if (!request) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  const collections = await loadTriageCollections(rfpId);
  return { ...request, ...collections };
}

export async function transitionStatus(
  rfpId: string,
  target: RfpHumanStatus,
  actorId: string,
  options?: { note?: string; isSuperAdmin?: boolean },
): Promise<RfpTriageDetail> {
  if (!options?.isSuperAdmin) await requireManage(actorId);
  if (!isRfpHumanStatus(target)) {
    throw new RfpIntakeError('Invalid status', 400, 'VALIDATION');
  }
  const request = await getRequestById(rfpId);
  if (!request) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  if (!canTransitionRfpStatus(request.status, target)) {
    throw new RfpIntakeError('Invalid status transition', 409, 'INVALID_TRANSITION');
  }

  await db.transaction(async (tx) => {
    await tx.update(rfpRequests)
      .set({ status: target, updatedAt: nowIso() })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'status-changed',
      actorId,
      payload: { from: request.status, to: target, note: options?.note ?? null },
    });
  });

  await dispatchRfpNotifications({ kind: 'status-changed', request, actorId });
  return getTriageDetail(rfpId, actorId, options);
}

export async function reopenRequest(
  rfpId: string,
  actorId: string,
  reason: string,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpTriageDetail> {
  if (!options?.isSuperAdmin) await requireManage(actorId);
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new RfpIntakeError('reason is required', 400, 'VALIDATION');
  }
  const request = await getRequestById(rfpId);
  if (!request) throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  if (!canReopenRfp(request.status)) {
    throw new RfpIntakeError('Reopen is only available from Accepted or Declined', 409, 'INVALID_TRANSITION');
  }

  await db.transaction(async (tx) => {
    await tx.update(rfpRequests)
      .set({ status: 'in-review', updatedAt: nowIso() })
      .where(eq(rfpRequests.id, rfpId));
    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'reopened',
      actorId,
      payload: { from: request.status, to: 'in-review', reason: trimmed },
    });
  });

  await dispatchRfpNotifications({ kind: 'reopened', request, actorId });
  return getTriageDetail(rfpId, actorId, options);
}

export async function addComment(
  rfpId: string,
  actorId: string,
  dto: CreateRfpCommentDTO,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpComment> {
  const request = await loadAuthorizedRequest(rfpId, actorId, options);
  const body = dto.body?.trim() ?? '';
  if (!body) {
    throw new RfpIntakeError('body is required', 400, 'VALIDATION');
  }
  const mentionedUserIds = await resolveMentions(rfpId, dto.mentionedUserIds ?? []);
  const isTriageAuthor = request.ownerId !== actorId;

  const comment = await db.transaction(async (tx) => {
    const [row] = await tx.insert(rfpComments).values({
      rfpRequestId: rfpId,
      authorId: actorId,
      body,
      mentionedUserIds,
    }).returning();
    if (!row) {
      throw new RfpIntakeError('Failed to create comment', 500, 'CREATE_FAILED');
    }

    await tx.insert(rfpRequestEvents).values({
      rfpRequestId: rfpId,
      eventType: 'comment-added',
      actorId,
      payload: { commentId: row.id },
    });

    if (isTriageAuthor && request.status === 'evaluated') {
      await tx.update(rfpRequests)
        .set({ status: 'in-review', updatedAt: nowIso() })
        .where(eq(rfpRequests.id, rfpId));
      await tx.insert(rfpRequestEvents).values({
        rfpRequestId: rfpId,
        eventType: 'status-changed',
        actorId,
        payload: { from: 'evaluated', to: 'in-review', trigger: 'triage-comment' },
      });
    }

    if (dto.attachmentIds?.length) {
      for (const attachmentId of dto.attachmentIds) {
        await tx.update(rfpAttachments)
          .set({ commentId: row.id })
          .where(and(eq(rfpAttachments.id, attachmentId), eq(rfpAttachments.rfpRequestId, rfpId)));
      }
    }

    return mapComment({ ...row, mentionedUserIds });
  });

  await dispatchRfpNotifications({
    kind: 'comment-added',
    request,
    actorId,
    mentionUserIds: mentionedUserIds,
  });
  return comment;
}

export async function addAttachment(
  rfpId: string,
  actorId: string,
  file: RfpAttachmentCandidate & { buffer: Buffer },
  commentId?: string | null,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpAttachment> {
  await loadAuthorizedRequest(rfpId, actorId, options);

  const existing = await db.query.rfpAttachments.findMany({
    where: and(
      eq(rfpAttachments.rfpRequestId, rfpId),
      commentId
        ? eq(rfpAttachments.commentId, commentId)
        : isNull(rfpAttachments.commentId),
    ),
  });
  const errors = validateRfpAttachments([
    ...existing.map((row) => ({
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
    })),
    { filename: file.filename, contentType: file.contentType, sizeBytes: file.sizeBytes },
  ]);
  if (errors.length > 0) {
    throw new RfpIntakeError(errors.join('; '), 400, 'VALIDATION');
  }

  const filename = sanitizeRfpFilename(file.filename);
  const [row] = await db.insert(rfpAttachments).values({
    rfpRequestId: rfpId,
    commentId: commentId ?? null,
    filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    storageKey: 'pending',
  }).returning();

  if (!row) {
    throw new RfpIntakeError('Failed to store attachment', 500, 'CREATE_FAILED');
  }

  const storageKey = path.join(attachmentDir(rfpId), row.id);
  await fs.mkdir(path.dirname(storageKey), { recursive: true });
  await fs.writeFile(storageKey, file.buffer);
  await db.update(rfpAttachments)
    .set({ storageKey })
    .where(eq(rfpAttachments.id, row.id));
  await appendEvent(rfpId, 'attachment-added', actorId, { attachmentId: row.id, filename });
  return mapAttachment({ ...row, storageKey, filename });
}

export async function getAttachment(
  rfpId: string,
  attachmentId: string,
  actorId: string,
  options?: { isSuperAdmin?: boolean },
): Promise<{ attachment: RfpAttachment; filePath: string }> {
  await loadAuthorizedRequest(rfpId, actorId, options);
  const row = await db.query.rfpAttachments.findFirst({
    where: and(eq(rfpAttachments.id, attachmentId), eq(rfpAttachments.rfpRequestId, rfpId)),
  });
  if (!row) {
    throw new RfpIntakeError('RFP not found', 404, 'NOT_FOUND');
  }
  return { attachment: mapAttachment(row), filePath: row.storageKey };
}

export async function listComments(
  rfpId: string,
  actorId: string,
  options?: { isSuperAdmin?: boolean },
): Promise<RfpComment[]> {
  await loadAuthorizedRequest(rfpId, actorId, options);
  const rows = await db.query.rfpComments.findMany({
    where: eq(rfpComments.rfpRequestId, rfpId),
    orderBy: [asc(rfpComments.createdAt)],
  });
  return rows.map((row) => mapComment(row));
}
