import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RfpEvaluationChat } from '../RfpEvaluationChat';
import { useAskRfpEvaluationChat, useRfpEvaluationChat } from '../../hooks/useRfpIntake';
import { useApplyRfpReviewerDecision } from '../../hooks/useRfpTriage';

jest.mock('../../hooks/useRfpIntake', () => ({
  useRfpEvaluationChat: jest.fn(),
  useAskRfpEvaluationChat: jest.fn(),
}));

jest.mock('../../hooks/useRfpTriage', () => ({
  useApplyRfpReviewerDecision: jest.fn(),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const mockChat = useRfpEvaluationChat as jest.MockedFunction<typeof useRfpEvaluationChat>;
const mockAsk = useAskRfpEvaluationChat as jest.MockedFunction<typeof useAskRfpEvaluationChat>;
const mockApply = useApplyRfpReviewerDecision as jest.MockedFunction<typeof useApplyRfpReviewerDecision>;

describe('RfpEvaluationChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApply.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null } as never);
  });

  it('posts a question to the evaluator', async () => {
    const mutateAsync = jest.fn().mockResolvedValue([]);
    mockChat.mockReturnValue({ data: [], isLoading: false, isError: false } as never);
    mockAsk.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null } as never);

    render(<RfpEvaluationChat requestId="rfp-1" />);
    fireEvent.change(screen.getByTestId('rfp-evaluation-chat-input'), {
      target: { value: 'Would a standalone SDLC build be valid?' },
    });
    fireEvent.click(screen.getByTestId('rfp-evaluation-chat-submit'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      id: 'rfp-1',
      message: 'Would a standalone SDLC build be valid?',
    }));
    expect(screen.queryByTestId('rfp-reviewer-decision-form')).not.toBeInTheDocument();
  });

  it('lets a manager apply a proposed reviewer decision', async () => {
    const mutateAsync = jest.fn().mockResolvedValue({});
    mockChat.mockReturnValue({
      data: [{
        id: 'm-ai',
        rfpRequestId: 'rfp-1',
        evaluationId: 'ev-1',
        authorId: null,
        role: 'assistant',
        body: 'Agreed.\n\n:::reviewer-decision\n{"verdict":"build","rationale":"Replace Cornerstone","constraintsToAdd":"Host outside Apex"}\n:::',
        createdAt: '2026-08-20T00:00:00.000Z',
      }],
      isLoading: false,
      isError: false,
    } as never);
    mockAsk.mockReturnValue({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null } as never);
    mockApply.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null } as never);

    render(<RfpEvaluationChat requestId="rfp-1" canManage />);
    expect(screen.getByTestId('rfp-reviewer-decision-suggestion')).toHaveTextContent(/Build/i);
    expect(screen.getByTestId('rfp-evaluation-chat-assistant-m-ai')).not.toHaveTextContent(':::reviewer-decision');
    fireEvent.click(screen.getByTestId('rfp-reviewer-decision-submit'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rfp-1',
      verdict: 'build',
      rationale: 'Replace Cornerstone',
      constraintsToAdd: 'Host outside Apex',
      sourceMessageIds: ['m-ai'],
      reevaluate: true,
    })));
  });
});
