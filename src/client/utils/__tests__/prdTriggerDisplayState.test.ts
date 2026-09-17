import {
  derivePrdTriggerDisplayState,
  isAwaitingAutomaticPrd,
} from '../prdTriggerDisplayState';
import type { InterviewSummary } from '../../../shared/types/interview';

const now = Date.parse('2026-09-17T16:00:00.000Z');

function interview(overrides: Partial<InterviewSummary>): InterviewSummary {
  return {
    id: 'iv-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    title: 'Phase interview',
    project: 'Apex',
    repo: 'Apex',
    status: 'complete',
    prdCount: 0,
    createdAt: '2026-09-17T15:00:00.000Z',
    updatedAt: '2026-09-17T15:00:00.000Z',
    ...overrides,
  };
}

describe('PBI-006 pure PRD trigger display state', () => {
  it('AC-0 / DoD timing: technical-only approval is generating before 60 seconds', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'technical_only',
      technicalPhaseStatus: 'approved',
      technicalApprovedAt: '2026-09-17T15:59:30.000Z',
    }), now)).toBe('generating');
  });

  it('AC-1 / DoD timing: technical-only approval is failed at 60 seconds without a PRD', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'technical_only',
      technicalPhaseStatus: 'approved',
      technicalApprovedAt: '2026-09-17T15:59:00.000Z',
    }), now)).toBe('failed');
  });

  it('DoD timing: requirements-only uses requirementsApprovedAt', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'requirements_only',
      requirementsPhaseStatus: 'approved',
      requirementsApprovedAt: '2026-09-17T15:59:30.000Z',
    }), now)).toBe('generating');
  });

  it('AC-2 / BR-003 / DoD timing: both-sequential remains pending after Requirements alone', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'both_sequential',
      requirementsPhaseStatus: 'approved',
      requirementsApprovedAt: '2026-09-17T15:00:00.000Z',
      technicalPhaseStatus: 'draft',
    }), now)).toBe('pending');
  });

  it('BR-003 / DoD timing: both-sequential uses technicalApprovedAt for the final phase', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'both_sequential',
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'approved',
      technicalApprovedAt: '2026-09-17T15:59:30.000Z',
    }), now)).toBe('generating');
  });

  it('BR-011: an existing generating PRD remains generating', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'requirements_only',
      prdCount: 1,
    }), now, 'generating')).toBe('generating');
  });

  it('BR-011: any existing non-generating PRD is ready', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: 'requirements_only',
      prdCount: 1,
    }), now, 'draft')).toBe('ready');
  });

  it('legacy interviews have no automatic display state', () => {
    expect(derivePrdTriggerDisplayState(interview({
      phaseFlow: null,
    }), now)).toBeNull();
  });
});

describe('PBI-006 automatic PRD polling condition', () => {
  it('awaits generation while the final configured phase is approved with no PRD', () => {
    expect(isAwaitingAutomaticPrd(interview({
      phaseFlow: 'technical_only',
      technicalPhaseStatus: 'approved',
      technicalApprovedAt: '2026-09-17T15:00:00.000Z',
    }))).toBe(true);
  });

  it('stops awaiting once a PRD row exists', () => {
    expect(isAwaitingAutomaticPrd(interview({
      phaseFlow: 'technical_only',
      technicalPhaseStatus: 'approved',
      technicalApprovedAt: '2026-09-17T15:00:00.000Z',
      prdCount: 1,
    }))).toBe(false);
  });

  it('does not await for both_sequential until Technical is approved', () => {
    expect(isAwaitingAutomaticPrd(interview({
      phaseFlow: 'both_sequential',
      requirementsPhaseStatus: 'approved',
      requirementsApprovedAt: '2026-09-17T15:00:00.000Z',
      technicalPhaseStatus: 'draft',
    }))).toBe(false);
  });

  it('does not await on legacy interviews', () => {
    expect(isAwaitingAutomaticPrd(interview({ phaseFlow: null }))).toBe(false);
  });
});
