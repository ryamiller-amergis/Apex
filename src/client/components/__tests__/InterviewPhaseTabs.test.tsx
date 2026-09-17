import { act, fireEvent, render, screen } from '@testing-library/react';
import { InterviewPhaseTabs } from '../InterviewPhaseTabs';

describe('InterviewPhaseTabs', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('PBI-009 AC-0 / TBI-006 DoD-0 Given draft both-sequential, Then both tabs render and Technical is locked', () => {
    render(
      <InterviewPhaseTabs
        phaseFlow="both_sequential"
        requirementsPhaseStatus="draft"
        activeTab="requirements"
        onTabChange={jest.fn()}
      />,
    );

    const tabs = screen.getByTestId('interview-phase-tabs');
    const requirements = screen.getByTestId('interview-phase-tab-requirements');
    const technical = screen.getByTestId('interview-phase-tab-technical');

    expect(tabs).toHaveAttribute('role', 'tablist');
    expect(requirements).toHaveAttribute('aria-selected', 'true');
    expect(requirements).toHaveAttribute('aria-controls', 'interview-phase-panel-requirements');
    expect(technical).toHaveAttribute('aria-selected', 'false');
    expect(technical).toHaveAttribute('aria-controls', 'interview-phase-panel-technical');
    expect(technical).toHaveAttribute('aria-disabled', 'true');
    expect(technical).toHaveAccessibleName(/Technical.*locked.*Requirements.*approved/i);
  });

  it('PBI-009 AC-1 / TBI-006 DoD-2 Given locked Technical, Then click is inert and notice auto-dismisses after 3 seconds', () => {
    jest.useFakeTimers();
    const onTabChange = jest.fn();
    render(
      <InterviewPhaseTabs
        phaseFlow="both_sequential"
        requirementsPhaseStatus="draft"
        activeTab="requirements"
        onTabChange={onTabChange}
      />,
    );

    fireEvent.click(screen.getByTestId('interview-phase-tab-technical'));

    expect(onTabChange).not.toHaveBeenCalled();
    const notice = screen.getByTestId('interview-phase-tab-technical-locked-tooltip');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveTextContent(
      'Approve the Requirements summary to unlock Technical.',
    );

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(
      screen.queryByTestId('interview-phase-tab-technical-locked-tooltip'),
    ).not.toBeInTheDocument();
  });

  it('PBI-009 AC-1 Given the locked notice is visible, When clicking outside, Then it dismisses', () => {
    render(
      <div>
        <InterviewPhaseTabs
          phaseFlow="both_sequential"
          requirementsPhaseStatus="draft"
          activeTab="requirements"
          onTabChange={jest.fn()}
        />
        <button type="button">Outside</button>
      </div>,
    );

    fireEvent.click(screen.getByTestId('interview-phase-tab-technical'));
    expect(
      screen.getByTestId('interview-phase-tab-technical-locked-tooltip'),
    ).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(
      screen.queryByTestId('interview-phase-tab-technical-locked-tooltip'),
    ).not.toBeInTheDocument();
  });

  it('PBI-009 AC-2 Given approval rerenders, Then Requirements remains active until Technical is clicked', () => {
    const onTabChange = jest.fn();
    const view = render(
      <InterviewPhaseTabs
        phaseFlow="both_sequential"
        requirementsPhaseStatus="draft"
        activeTab="requirements"
        onTabChange={onTabChange}
      />,
    );

    view.rerender(
      <InterviewPhaseTabs
        phaseFlow="both_sequential"
        requirementsPhaseStatus="approved"
        activeTab="requirements"
        onTabChange={onTabChange}
      />,
    );

    const requirements = screen.getByTestId('interview-phase-tab-requirements');
    const technical = screen.getByTestId('interview-phase-tab-technical');
    expect(requirements).toHaveAttribute('aria-selected', 'true');
    expect(technical).not.toHaveAttribute('aria-disabled');
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.click(technical);
    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith('technical');
  });
});
