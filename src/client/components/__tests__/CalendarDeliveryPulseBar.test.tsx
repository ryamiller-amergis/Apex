import { fireEvent, render, screen } from '@testing-library/react';
import {
  CalendarDeliveryPulseBar,
  WorkItemConfidenceBadge,
} from '../CalendarDeliveryPulseBar';
import type { CalendarDeliveryPulseResponse } from '../../../shared/types/standup';

const basePulse: CalendarDeliveryPulseResponse = {
  project: 'MaxView',
  deliveryModel: 'flow',
  teamGoal: 'Keep WIP <= 3 & zero stale PRs',
  goalSource: 'manual',
  enableTargetDateChecks: false,
  latestSessionId: 'sess-1',
  latestSessionDate: '2026-11-13',
  overallHealth: 'watch',
  counts: {
    onTrack: 4,
    uncertain: 1,
    atRisk: 2,
    blockedOrStale: 2,
    missingTargetDate: 0,
    pendingProposals: 1,
  },
  itemHealthById: {
    701: {
      workItemId: 701,
      confidence: 'at_risk',
      reasons: ['Unchanged in Active for 6d (threshold: 3d)'],
      isBlockedOrStale: true,
      carryover: true,
    },
  },
  proposals: [
    {
      id: 'prop-cal-1',
      sessionId: 'sess-1',
      participantId: 'p-1',
      project: 'MaxView',
      workItemId: 701,
      workItemTitle: 'Queue backpressure handler',
      proposalType: 'target_date',
      fieldName: 'dueDate',
      currentValue: null,
      proposedValue: '2026-11-20',
      reason: 'Proposed target date from standup review',
      confidence: 'at_risk',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      createdAt: '2026-11-13T10:00:00Z',
    },
  ],
  teamPulse: null,
};

describe('CalendarDeliveryPulseBar & WorkItemConfidenceBadge (AC-07, AC-08)', () => {
  it('shows Flow Aging metric instead of Missing Target Date in flow mode, and opens Proposals Drawer', () => {
    const onFilterChange = jest.fn();
    const onApplyProposal = jest.fn().mockResolvedValue(undefined);
    const onDismissProposal = jest.fn().mockResolvedValue(undefined);

    render(
      <CalendarDeliveryPulseBar
        pulse={basePulse}
        activeFilter="all"
        onFilterChange={onFilterChange}
        canWriteWorkItems={true}
        onApplyProposal={onApplyProposal}
        onDismissProposal={onDismissProposal}
      />,
    );

    expect(screen.getByTestId('calendar-pulse-model')).toHaveTextContent('Flow Pulse');
    expect(screen.getByTestId('calendar-pulse-goal')).toHaveTextContent(
      'Keep WIP <= 3 & zero stale PRs',
    );
    expect(screen.getByTestId('calendar-pulse-metric-blocked-stale')).toHaveTextContent(
      'Flow Aging / Stale:',
    );
    expect(screen.queryByTestId('calendar-pulse-metric-missing-date')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('calendar-pulse-filter-proposals'));
    expect(screen.getByTestId('calendar-proposals-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('calendar-proposal-apply-prop-cal-1'));
    expect(onApplyProposal).toHaveBeenCalledWith(basePulse.proposals[0]);
  });

  it('renders WorkItemConfidenceBadge and expands "Why at risk?" reasons popover on click', () => {
    render(<WorkItemConfidenceBadge health={basePulse.itemHealthById[701]} />);

    const badge = screen.getByTestId('work-item-confidence-701');
    expect(badge).toHaveTextContent('At Risk · Why?');
    expect(screen.queryByTestId('work-item-risk-reasons-701')).not.toBeInTheDocument();

    fireEvent.click(badge);
    expect(screen.getByTestId('work-item-risk-reasons-701')).toHaveTextContent(
      'Unchanged in Active for 6d (threshold: 3d)',
    );
  });
});
