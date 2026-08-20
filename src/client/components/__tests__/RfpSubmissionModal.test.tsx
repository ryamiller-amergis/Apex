import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RfpSubmissionModal } from '../RfpSubmissionModal';
import { useSubmitRfpRequest } from '../../hooks/useRfpIntake';

jest.mock('../../hooks/useRfpIntake', () => ({
  useSubmitRfpRequest: jest.fn(),
}));

const mockUseSubmit = useSubmitRfpRequest as jest.MockedFunction<typeof useSubmitRfpRequest>;

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RfpSubmissionModal onClose={jest.fn()} />
    </QueryClientProvider>,
  );
}

describe('RfpSubmissionModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSubmit.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
      isError: false,
      error: null,
    } as never);
  });

  it('PBI-003 AC-2 shows existing system stack only for change-existing', () => {
    renderModal();
    expect(screen.queryByTestId('rfp-existing-system-stack')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rfp-field-requestType'), { target: { value: 'change-existing' } });
    expect(screen.getByTestId('rfp-existing-system-stack')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rfp-field-requestType'), { target: { value: 'new-app' } });
    expect(screen.queryByTestId('rfp-existing-system-stack')).not.toBeInTheDocument();
  });

  it('PBI-003 AC-1 preserves entered values when create fails', async () => {
    const mutateAsync = jest.fn().mockRejectedValue(new Error('create failed'));
    mockUseSubmit.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: true,
      error: new Error('create failed'),
    } as never);

    renderModal();
    fireEvent.change(screen.getByTestId('rfp-field-title'), { target: { value: 'Keep me' } });
    fireEvent.change(screen.getByTestId('rfp-field-stakeholder'), { target: { value: 'BA' } });
    fireEvent.change(screen.getByTestId('rfp-field-request'), { target: { value: 'Need a tracker' } });
    fireEvent.change(screen.getByTestId('rfp-field-problem'), { target: { value: 'Fragmented' } });
    fireEvent.change(screen.getByTestId('rfp-field-existingSolution'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('rfp-submit-button'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(screen.getByTestId('rfp-field-title')).toHaveValue('Keep me');
    expect(screen.getByTestId('rfp-submit-error')).toHaveTextContent(/create failed/i);
  });

  it('shows a success confirmation after submit', async () => {
    const mutateAsync = jest.fn().mockResolvedValue({ id: 'rfp-9', title: 'Keep me' });
    mockUseSubmit.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: false,
      error: null,
    } as never);

    renderModal();
    fireEvent.change(screen.getByTestId('rfp-field-title'), { target: { value: 'Keep me' } });
    fireEvent.change(screen.getByTestId('rfp-field-stakeholder'), { target: { value: 'BA' } });
    fireEvent.change(screen.getByTestId('rfp-field-request'), { target: { value: 'Need a tracker' } });
    fireEvent.change(screen.getByTestId('rfp-field-problem'), { target: { value: 'Fragmented' } });
    fireEvent.change(screen.getByTestId('rfp-field-existingSolution'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('rfp-submit-button'));

    await waitFor(() => expect(screen.getByTestId('rfp-submit-success')).toBeInTheDocument());
    expect(screen.getByTestId('rfp-submit-success')).toHaveTextContent(/submitted successfully/i);
    expect(screen.queryByTestId('rfp-submission-form')).not.toBeInTheDocument();
  });
});
