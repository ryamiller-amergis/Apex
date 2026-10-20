import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlaybookRunDetail } from '../../../shared/types/playbook';
import { PlaybookFeedbackReviewPanel } from '../PlaybookFeedbackReviewPanel';

const mutate = jest.fn();

jest.mock('../../hooks/usePlaybookRuns', () => ({
  PlaybookRunApiError: class PlaybookRunApiError extends Error {},
  usePlaybookFeedbackDecision: () => ({ mutate, isPending: false, error: null }),
}));

const run: PlaybookRunDetail = {
  runId: 'run-1',
  project: 'Apex',
  definitionId: 'def-1',
  definitionName: 'ATS agent board',
  definitionVersionId: 'version-7',
  versionNumber: 7,
  status: 'suspended',
  initiatorUserId: 'owner',
  startedAt: '2026-10-20T12:00:00.000Z',
  completedAt: null,
  currentStepId: 'leadership-feedback',
  suspension: {
    stepId: 'leadership-feedback',
    reason: 'feedback_review',
    deadline: '2026-10-22T12:00:00.000Z',
  },
  steps: [
    {
      id: 'chair-run',
      runId: 'run-1',
      stepId: 'chair',
      stepType: 'cursor-agent',
      status: 'completed',
      agentRunId: null,
      resumeToken: null,
      outputInline: { reportMd: 'Phase 1 fills one assignment from an internal search.' },
      outputBlobRef: null,
      expiresAt: null,
      startedAt: '2026-10-20T12:00:00.000Z',
      completedAt: '2026-10-20T12:05:00.000Z',
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:05:00.000Z',
    },
    {
      id: 'feedback-run',
      runId: 'run-1',
      stepId: 'leadership-feedback',
      stepType: 'feedback-review',
      status: 'suspended',
      agentRunId: null,
      resumeToken: null,
      inputInline: {
        subject: 'Review the board plan',
        sourceStepIds: ['chair'],
      },
      outputInline: null,
      outputBlobRef: null,
      expiresAt: '2026-10-22T12:00:00.000Z',
      startedAt: '2026-10-20T12:05:00.000Z',
      completedAt: null,
      createdAt: '2026-10-20T12:05:00.000Z',
      updatedAt: '2026-10-20T12:05:00.000Z',
    },
  ],
};

describe('PlaybookFeedbackReviewPanel', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('asks for a note before sending a question about the selected AI step', async () => {
    const user = userEvent.setup();
    render(<PlaybookFeedbackReviewPanel project="Apex" run={run} />);

    expect(screen.getByRole('heading', { name: 'Review the board plan' })).toBeInTheDocument();
    expect(screen.getByText(/internal search/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('playbook-feedback-action-outcome'), 'question');
    expect(screen.getByTestId('playbook-feedback-continue')).toBeDisabled();
    await user.type(
      screen.getByTestId('playbook-feedback-note-outcome'),
      'Who approves the submission?'
    );
    await user.click(screen.getByTestId('playbook-feedback-continue'));

    expect(mutate).toHaveBeenCalledWith({
      stopped: false,
      items: [
        {
          sourceStepId: 'chair',
          itemId: 'outcome',
          action: 'question',
          note: 'Who approves the submission?',
        },
      ],
    });
  });
});
