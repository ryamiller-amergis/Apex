import { fireEvent, render, screen } from '@testing-library/react';
import { InterviewPhaseBar } from '../InterviewPhaseBar';
import { deriveInterviewPhaseProgress } from '../../utils/interviewPhaseProgress';

const users = [
  { oid: 'zoe', displayName: 'Zoe User', email: 'zoe@example.com' },
  { oid: 'alice', displayName: 'Alice User', email: 'alice@example.com' },
];

describe('InterviewPhaseBar assignment', () => {
  it('lets an owner assign one phase from an A to Z list without clearing the others', () => {
    const onAssign = jest.fn();
    render(
      <InterviewPhaseBar
        progress={deriveInterviewPhaseProgress([])}
        assignment={{
          users,
          selectedIds: { delivery: 'zoe' },
          selectedNames: { delivery: 'Zoe User' },
          canAssign: true,
          onAssign,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('interview-phase-assignee-discovery'));
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Unassigned',
      'Alice User',
      'Zoe User',
    ]);
    fireEvent.mouseDown(options[1]);

    expect(onAssign).toHaveBeenCalledWith('discovery', 'alice');
    expect(screen.getByTestId('interview-phase-assignee-delivery')).toHaveTextContent('Zoe User');
  });

  it('shows the assigned name without a menu when the viewer cannot assign', () => {
    render(
      <InterviewPhaseBar
        progress={deriveInterviewPhaseProgress([])}
        assignment={{
          users,
          selectedIds: { discovery: 'alice' },
          selectedNames: { discovery: 'Alice User' },
          canAssign: false,
          onAssign: jest.fn(),
        }}
      />,
    );

    expect(screen.queryByTestId('interview-phase-assignee-discovery')).not.toBeInTheDocument();
    expect(screen.getByTestId('interview-phase-discovery')).toHaveTextContent('Alice User');
  });
});
