import {
  isTechnicalTabLocked,
  shouldRenderPhaseTabs,
} from '../interviewPhaseFlow';
import type {
  InterviewPhaseFlow,
  InterviewPhaseStatus,
} from '../../../shared/types/interview';

describe('TBI-006 DoD-0/1 / VT-09 interview phase-flow helpers', () => {
  const flows: Array<InterviewPhaseFlow | null | undefined> = [
    'requirements_only',
    'technical_only',
    'both_sequential',
    null,
    undefined,
  ];
  const statuses: Array<InterviewPhaseStatus | null | undefined> = [
    'draft',
    'locked',
    'approved',
    null,
    undefined,
  ];

  it.each(flows)(
    'Given phaseFlow %s, When chrome is selected, Then tabs render only for both_sequential',
    (phaseFlow) => {
      expect(shouldRenderPhaseTabs(phaseFlow)).toBe(
        phaseFlow === 'both_sequential',
      );
    },
  );

  it.each(
    flows.flatMap((phaseFlow) =>
      statuses.map((requirementsPhaseStatus) => ({
        phaseFlow,
        requirementsPhaseStatus,
      })),
    ),
  )(
    'Given $phaseFlow and Requirements $requirementsPhaseStatus, When lock state is derived, Then only server-approved both_sequential unlocks',
    ({ phaseFlow, requirementsPhaseStatus }) => {
      expect(
        isTechnicalTabLocked(phaseFlow, requirementsPhaseStatus),
      ).toBe(
        phaseFlow === 'both_sequential'
          && requirementsPhaseStatus !== 'approved',
      );
    },
  );
});
