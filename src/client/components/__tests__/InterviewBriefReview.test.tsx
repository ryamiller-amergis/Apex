import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InterviewBriefReview } from '../InterviewBriefReview';

const sections = {
  problemAndOutcome: 'Reduce rework',
  users: 'Business analysts',
  scope: 'Discovery',
  businessRules: '',
  scenarios: '',
  acceptanceCriteria: '',
  assumptions: '',
  unresolvedItems: ['Confirm SLA'],
};

const brief = {
  id: 'brief-1',
  interviewId: 'interview-1',
  status: 'draft' as const,
  version: 2,
  sections,
  approvedBy: null,
  approvedAt: null,
};

it('requires changed fields to be saved before approval', async () => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  const onApprove = jest.fn().mockResolvedValue(undefined);
  render(
    <InterviewBriefReview
      brief={brief}
      isLoading={false}
      isDrafting={false}
      isSaving={false}
      isApproving={false}
      onSave={onSave}
      onDraft={jest.fn()}
      onApprove={onApprove}
    />,
  );

  const problem = screen.getByTestId('interview-brief-problemAndOutcome');
  await userEvent.clear(problem);
  await userEvent.type(problem, 'Shorter interviews');

  expect(screen.getByTestId('approve-interview-brief')).toBeDisabled();
  await userEvent.click(screen.getByTestId('save-interview-brief'));

  expect(onSave).toHaveBeenCalledWith({
    ...sections,
    problemAndOutcome: 'Shorter interviews',
  });
});

it('freezes fields and hides actions after approval', () => {
  render(
    <InterviewBriefReview
      brief={{ ...brief, status: 'approved', approvedBy: 'ba-1', approvedAt: '2026-10-07T16:00:00Z' }}
      isLoading={false}
      isDrafting={false}
      isSaving={false}
      isApproving={false}
      onSave={jest.fn()}
      onDraft={jest.fn()}
      onApprove={jest.fn()}
    />,
  );

  expect(screen.getByText('Approved')).toBeInTheDocument();
  expect(screen.getByTestId('interview-brief-problemAndOutcome')).toBeDisabled();
  expect(screen.queryByTestId('approve-interview-brief')).not.toBeInTheDocument();
});
