import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews } from '../db/schema';
import type {
  ApprovePhaseSummaryResponse,
  InterviewPhaseFlow,
  InterviewPhaseStatus,
  PhaseName,
  PhaseSummary,
} from '../../shared/types/interview';
import { createNotification } from './notificationService';

type InterviewRow = typeof interviews.$inferSelect & {
  requirementsOwner?: { displayName: string | null } | null;
  technicalOwner?: { displayName: string | null } | null;
};

export interface AmendRequirementsSummaryResponse {
  ok: true;
  notifiedOwnerId: string | null;
}

function httpError(status: number, message: string): Error {
  const error = new Error(message);
  (error as Error & { status: number }).status = status;
  return error;
}

function phaseIsConfigured(flow: InterviewPhaseFlow, phase: PhaseName): boolean {
  return flow === 'both_sequential'
    || (flow === 'requirements_only' && phase === 'requirements')
    || (flow === 'technical_only' && phase === 'technical');
}

function phaseOwnerId(row: InterviewRow, phase: PhaseName): string | null {
  return phase === 'requirements' ? row.requirementsOwnerId : row.technicalOwnerId;
}

function phaseStatus(row: InterviewRow, phase: PhaseName): InterviewPhaseStatus | null {
  const status = phase === 'requirements'
    ? row.requirementsPhaseStatus
    : row.technicalPhaseStatus;
  return status as InterviewPhaseStatus | null;
}

export function isPhaseOwner(
  row: InterviewRow,
  phase: PhaseName,
  userId: string,
): boolean {
  return phaseOwnerId(row, phase) === userId;
}

export function isTechnicalOwner(row: InterviewRow, userId: string): boolean {
  return row.technicalOwnerId === userId;
}

async function loadInterview(interviewId: string): Promise<InterviewRow> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
    with: {
      requirementsOwner: true,
      technicalOwner: true,
    },
  });
  if (!row) throw httpError(404, 'Interview not found');
  return row;
}

function configuredFlow(row: InterviewRow, phase: PhaseName): InterviewPhaseFlow {
  const flow = row.phaseFlow as InterviewPhaseFlow | null;
  if (!flow || !phaseIsConfigured(flow, phase)) {
    throw httpError(409, `The ${phase} phase is not configured for this interview.`);
  }
  return flow;
}

async function dispatchWithoutBlocking(
  userId: string | null,
  payload: { type: 'user-action'; title: string; body: string; link: string },
): Promise<void> {
  if (!userId) return;
  const [result] = await Promise.allSettled([
    Promise.resolve().then(() => createNotification(userId, payload)),
  ]);
  if (result.status === 'rejected') {
    console.error('[phaseLifecycleService] Notification dispatch failed:', result.reason);
  }
}

export async function getPhaseSummary(
  interviewId: string,
  phase: PhaseName,
): Promise<PhaseSummary | null> {
  const row = await loadInterview(interviewId);
  const flow = row.phaseFlow as InterviewPhaseFlow | null;
  if (!flow || !phaseIsConfigured(flow, phase)) return null;

  const technicalLocked =
    flow === 'both_sequential' && row.requirementsPhaseStatus !== 'approved';
  const technicalUnlocked =
    flow === 'both_sequential'
    && row.requirementsPhaseStatus === 'approved'
    && row.technicalPhaseStatus !== 'locked';

  return {
    phase,
    status: phaseStatus(row, phase) ?? 'draft',
    content:
      (phase === 'requirements' ? row.requirementsSummary : row.technicalSummary)
      ?? '',
    ownerId: phaseOwnerId(row, phase),
    ownerName:
      (phase === 'requirements'
        ? row.requirementsOwner?.displayName
        : row.technicalOwner?.displayName)
      ?? undefined,
    approvedAt:
      (phase === 'requirements'
        ? row.requirementsApprovedAt
        : row.technicalApprovedAt)
      ?? null,
    locked: phase === 'technical' && technicalLocked,
    amendable: phase === 'requirements' && technicalUnlocked,
  };
}

export async function editPhaseSummary(
  interviewId: string,
  phase: PhaseName,
  userId: string,
  content: string,
): Promise<void> {
  const row = await loadInterview(interviewId);
  configuredFlow(row, phase);
  if (!isPhaseOwner(row, phase, userId)) {
    throw httpError(403, 'Only the assigned phase owner can edit this summary.');
  }
  if (phaseStatus(row, phase) !== 'draft') {
    throw httpError(409, 'Approved summaries are frozen and cannot be edited.');
  }

  const ownerColumn =
    phase === 'requirements' ? interviews.requirementsOwnerId : interviews.technicalOwnerId;
  const statusColumn =
    phase === 'requirements'
      ? interviews.requirementsPhaseStatus
      : interviews.technicalPhaseStatus;
  const values = phase === 'requirements'
    ? { requirementsSummary: content, updatedAt: new Date().toISOString() }
    : { technicalSummary: content, updatedAt: new Date().toISOString() };

  const updated = await db
    .update(interviews)
    .set(values)
    .where(and(
      eq(interviews.id, interviewId),
      eq(ownerColumn, userId),
      eq(statusColumn, 'draft'),
    ))
    .returning({ id: interviews.id });
  if (updated.length === 0) {
    throw httpError(409, 'The phase changed before the summary could be saved.');
  }
}

export async function approvePhaseSummary(
  interviewId: string,
  phase: PhaseName,
  userId: string,
): Promise<ApprovePhaseSummaryResponse> {
  const row = await loadInterview(interviewId);
  const flow = configuredFlow(row, phase);
  if (!isPhaseOwner(row, phase, userId)) {
    throw httpError(403, 'Only the assigned phase owner can approve this summary.');
  }

  const status = phaseStatus(row, phase);
  if (status === 'approved') {
    throw httpError(409, 'This phase summary has already been approved.');
  }
  if (status !== 'draft') {
    throw httpError(409, 'This phase is locked and cannot be approved yet.');
  }
  const content =
    (phase === 'requirements' ? row.requirementsSummary : row.technicalSummary)
    ?? '';
  if (content.trim().length === 0) {
    throw httpError(400, 'Please add content to the summary before approving.');
  }

  const approvedAt = new Date().toISOString();
  const ownerColumn =
    phase === 'requirements' ? interviews.requirementsOwnerId : interviews.technicalOwnerId;
  const statusColumn =
    phase === 'requirements'
      ? interviews.requirementsPhaseStatus
      : interviews.technicalPhaseStatus;
  const unlocksTechnical = phase === 'requirements' && flow === 'both_sequential';
  const values = phase === 'requirements'
    ? {
        requirementsPhaseStatus: 'approved',
        requirementsApprovedAt: approvedAt,
        ...(unlocksTechnical ? { technicalPhaseStatus: 'draft' } : {}),
        updatedAt: approvedAt,
      }
    : {
        technicalPhaseStatus: 'approved',
        technicalApprovedAt: approvedAt,
        updatedAt: approvedAt,
      };

  const updated = await db
    .update(interviews)
    .set(values)
    .where(and(
      eq(interviews.id, interviewId),
      eq(ownerColumn, userId),
      eq(statusColumn, 'draft'),
    ))
    .returning({ id: interviews.id });
  if (updated.length === 0) {
    throw httpError(409, 'The phase changed before it could be approved.');
  }

  if (unlocksTechnical) {
    await dispatchWithoutBlocking(row.technicalOwnerId, {
      type: 'user-action',
      title: 'Technical Phase Unlocked',
      body: `The Requirements summary for "${row.title}" was approved. You can now start the Technical phase.`,
      link: `/backlog/interview/${interviewId}`,
    });
  }

  return {
    ok: true,
    ...(unlocksTechnical && row.technicalOwnerId
      ? { unlockedTechnicalOwnerId: row.technicalOwnerId }
      : {}),
    isLastConfiguredPhase:
      flow === 'requirements_only'
      || phase === 'technical',
  };
}

export async function amendRequirementsSummary(
  interviewId: string,
  userId: string,
  content: string,
): Promise<AmendRequirementsSummaryResponse> {
  const row = await loadInterview(interviewId);
  if (!isTechnicalOwner(row, userId)) {
    throw httpError(403, 'Only the assigned Technical owner can amend this summary.');
  }
  if (
    row.phaseFlow !== 'both_sequential'
    || row.requirementsPhaseStatus !== 'approved'
    || row.technicalPhaseStatus === 'locked'
  ) {
    throw httpError(409, 'The Requirements summary cannot be amended until Technical is unlocked.');
  }

  const updated = await db
    .update(interviews)
    .set({
      requirementsSummary: content,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(interviews.id, interviewId),
      eq(interviews.phaseFlow, 'both_sequential'),
      eq(interviews.technicalOwnerId, userId),
      eq(interviews.requirementsPhaseStatus, 'approved'),
      ne(interviews.technicalPhaseStatus, 'locked'),
    ))
    .returning({ id: interviews.id });
  if (updated.length === 0) {
    throw httpError(409, 'The phase changed before the amendment could be saved.');
  }

  await dispatchWithoutBlocking(row.requirementsOwnerId, {
    type: 'user-action',
    title: 'Requirements Summary Amended',
    body: `The Technical owner updated the approved Requirements summary for "${row.title}".`,
    link: `/backlog/interview/${interviewId}`,
  });

  return { ok: true, notifiedOwnerId: row.requirementsOwnerId };
}
