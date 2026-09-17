import type {
  InterviewSummary,
  PrdStatus,
  PrdTriggerDisplayState,
} from '../../shared/types/interview';

export const PRD_TRIGGER_FAILURE_MS = 60_000;

/** Poll cadence while the server's fire-and-forget PRD trigger may still be writing the row. */
export const PRD_TRIGGER_POLL_MS = 5_000;

export function finalPhaseApprovedAt(interview: InterviewSummary): string | null | undefined {
  if (!interview.phaseFlow) return null;
  return interview.phaseFlow === 'requirements_only'
    ? interview.requirementsApprovedAt
    : interview.technicalApprovedAt;
}

export function isAwaitingAutomaticPrd(interview: InterviewSummary): boolean {
  if (!interview.phaseFlow || interview.prdCount > 0) return false;
  const finalStatus = interview.phaseFlow === 'requirements_only'
    ? interview.requirementsPhaseStatus
    : interview.technicalPhaseStatus;
  return finalStatus === 'approved' && !!finalPhaseApprovedAt(interview);
}

export function prdTriggerPollInterval(
  interviews: InterviewSummary | InterviewSummary[] | undefined,
): number | false {
  if (!interviews) return false;
  const list = Array.isArray(interviews) ? interviews : [interviews];
  return list.some(isAwaitingAutomaticPrd) ? PRD_TRIGGER_POLL_MS : false;
}

export function derivePrdTriggerDisplayState(
  interview: InterviewSummary,
  nowMs = Date.now(),
  existingPrdStatus?: PrdStatus,
): PrdTriggerDisplayState | null {
  if (!interview.phaseFlow) return null;

  if (interview.prdCount > 0 || existingPrdStatus) {
    return existingPrdStatus === 'generating' ? 'generating' : 'ready';
  }

  const finalApprovedAt = interview.phaseFlow === 'requirements_only'
    ? interview.requirementsApprovedAt
    : interview.technicalApprovedAt;
  const finalStatus = interview.phaseFlow === 'requirements_only'
    ? interview.requirementsPhaseStatus
    : interview.technicalPhaseStatus;

  if (finalStatus !== 'approved' || !finalApprovedAt) return 'pending';

  const approvedAtMs = Date.parse(finalApprovedAt);
  if (!Number.isFinite(approvedAtMs)) return 'pending';
  return nowMs - approvedAtMs >= PRD_TRIGGER_FAILURE_MS ? 'failed' : 'generating';
}
