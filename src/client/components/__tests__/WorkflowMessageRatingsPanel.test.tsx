import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WorkflowMessageRatingsPanel } from '../WorkflowMessageRatingsPanel';

const mockUseSummary = jest.fn();
jest.mock('../../hooks/useWorkflowEvaluationsAdmin', () => ({
  useMessageRatingSummary: (...args: unknown[]) => mockUseSummary(...args),
}));

const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const INTERVIEW_ID = '33333333-3333-4333-8333-333333333333';

function summary(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      days: 30,
      interview: { up: 4, down: 3 },
      chat: { good: 5, needs_improvement: 2, bad: 1 },
      downvotedQuestions: [
        {
          interviewId: INTERVIEW_ID,
          interviewTitle: 'Billing export',
          messageId: MESSAGE_ID,
          excerpt: 'Who owns the invoice?',
          up: 1,
          down: 2,
        },
      ],
      chatComments: [
        {
          threadId: 't1',
          threadTitle: null,
          messageId: 'm1',
          excerpt: 'Here is a plan',
          rating: 'bad',
          comment: 'Missed the question',
          reviewerName: 'Ada',
          updatedAt: '2026-10-22T10:00:00.000Z',
        },
      ],
      ...overrides,
    },
    isLoading: false,
    isError: false,
    error: null,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <WorkflowMessageRatingsPanel project="proj-a" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseSummary.mockReturnValue(summary());
});

describe('WorkflowMessageRatingsPanel', () => {
  it('stays closed and does not fetch until opened', () => {
    renderPanel();
    expect(mockUseSummary).toHaveBeenLastCalledWith('proj-a', 30, false);
    expect(screen.queryByTestId('workflow-message-ratings-interview-counts')).toBeNull();
    expect(screen.getByTestId('workflow-message-ratings-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows counts, downvoted questions and chat comments when opened', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('workflow-message-ratings-toggle'));

    expect(mockUseSummary).toHaveBeenLastCalledWith('proj-a', 30, true);
    expect(screen.getByTestId('workflow-message-ratings-interview-counts')).toHaveTextContent('👍 4');
    expect(screen.getByTestId('workflow-message-ratings-interview-counts')).toHaveTextContent('👎 3');
    expect(screen.getByTestId('workflow-message-ratings-chat-counts')).toHaveTextContent('Needs improvement: 2');
    expect(screen.getByTestId(`workflow-message-ratings-interview-${MESSAGE_ID}`)).toHaveAttribute(
      'href',
      `/backlog/interview/${INTERVIEW_ID}`,
    );
    const comments = screen.getByTestId('workflow-message-ratings-comments');
    expect(comments).toHaveTextContent('Missed the question');
    expect(comments).toHaveTextContent('Untitled chat');
    expect(comments).toHaveTextContent('Ada');
  });

  it('refetches for the chosen period', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('workflow-message-ratings-toggle'));
    fireEvent.change(screen.getByTestId('workflow-message-ratings-days'), { target: { value: '90' } });
    expect(mockUseSummary).toHaveBeenLastCalledWith('proj-a', 90, true);
  });

  it('says so when there is nothing to list', () => {
    mockUseSummary.mockReturnValue(summary({ downvotedQuestions: [], chatComments: [] }));
    renderPanel();
    fireEvent.click(screen.getByTestId('workflow-message-ratings-toggle'));
    expect(screen.getByText('No thumbs down in this period.')).toBeInTheDocument();
    expect(screen.getByText('No comments in this period.')).toBeInTheDocument();
  });

  it('shows the error when loading fails', () => {
    mockUseSummary.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { message: 'boom' } });
    renderPanel();
    fireEvent.click(screen.getByTestId('workflow-message-ratings-toggle'));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load ratings: boom');
  });
});
