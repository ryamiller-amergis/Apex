import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RfpEvaluationChat } from '../RfpEvaluationChat';
import { useAskRfpEvaluationChat, useRfpEvaluationChat } from '../../hooks/useRfpIntake';

jest.mock('../../hooks/useRfpIntake', () => ({
  useRfpEvaluationChat: jest.fn(),
  useAskRfpEvaluationChat: jest.fn(),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

const mockChat = useRfpEvaluationChat as jest.MockedFunction<typeof useRfpEvaluationChat>;
const mockAsk = useAskRfpEvaluationChat as jest.MockedFunction<typeof useAskRfpEvaluationChat>;

describe('RfpEvaluationChat', () => {
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
  });
});
