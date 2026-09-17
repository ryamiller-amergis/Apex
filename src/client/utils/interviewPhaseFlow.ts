import type {
  InterviewPhaseFlow,
  InterviewPhaseStatus,
} from '../../shared/types/interview';

export function shouldRenderPhaseTabs(
  phaseFlow: InterviewPhaseFlow | null | undefined,
): boolean {
  return phaseFlow === 'both_sequential';
}

export function isTechnicalTabLocked(
  phaseFlow: InterviewPhaseFlow | null | undefined,
  requirementsPhaseStatus: InterviewPhaseStatus | null | undefined,
): boolean {
  return phaseFlow === 'both_sequential'
    && requirementsPhaseStatus !== 'approved';
}
