import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews } from '../db/schema';
import { readOutputRequirementsPhaseSummary } from './chatAgentService';
import { editPhaseSummary } from './phaseLifecycleService';

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function syncRow(
  row: typeof interviews.$inferSelect,
  actingUserId: string,
): Promise<boolean> {
  if (
    row.phaseFlow !== 'requirements_only'
    && row.phaseFlow !== 'both_sequential'
  ) {
    return false;
  }
  if (row.requirementsPhaseStatus !== 'draft') return false;
  if (row.requirementsSummary?.trim()) return false;

  const content = readOutputRequirementsPhaseSummary(row.chatThreadId);
  if (!content?.trim()) return false;

  await editPhaseSummary(row.id, 'requirements', actingUserId, content, {
    onlyIfEmpty: true,
  });
  return true;
}

/** Persist the Requirements summary written by a completed chat turn. */
export async function syncRequirementsPhaseArtifacts(
  threadId: string,
  actingUserId: string,
): Promise<boolean> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
  });
  return row ? syncRow(row, actingUserId) : false;
}

/** Import an available generated artifact while serving the summary read model. */
export async function syncAvailableRequirementsPhaseSummary(
  interviewId: string,
): Promise<boolean> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
  });
  if (!row?.requirementsOwnerId) return false;
  return syncRow(row, row.requirementsOwnerId);
}

/** Retry artifact synchronization for an already-completed interview. */
export async function syncRequirementsPhaseSummary(
  interviewId: string,
  actingUserId: string,
): Promise<void> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
  });
  if (!row) throw httpError(404, 'Interview not found');
  if (row.requirementsOwnerId !== actingUserId) {
    throw httpError(403, 'Only the assigned Requirements owner can generate this summary.');
  }
  if (row.requirementsSummary?.trim()) return;

  const synced = await syncRow(row, actingUserId);
  if (!synced) {
    throw httpError(
      409,
      'The Requirements phase has not produced a summary artifact yet.',
    );
  }
}
