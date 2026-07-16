import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeatureRequestModal } from '../FeatureRequestModal';

const mockMutate = jest.fn();
const mockUseAvailableAdrs = jest.fn();

jest.mock('../../hooks/useFeatureRequests', () => ({
  useSubmitFeatureRequest: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useAvailableFeatureRequestAdrs: (...args: unknown[]) => mockUseAvailableAdrs(...args),
}));

describe('FeatureRequestModal ADR associations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAvailableAdrs.mockReturnValue({
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Use an event bus',
        repo: 'AI-Pilot',
        slug: 'use-event-bus',
        status: 'accepted',
      }],
      isLoading: false,
      isError: false,
    });
  });

  it('submits selected ADR IDs for a feature request', async () => {
    render(<FeatureRequestModal selectedProject="Apex" type="feature" onClose={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Event delivery' } });
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: 'Add reliable delivery' } });
    fireEvent.change(screen.getByLabelText('Advantage'), { target: { value: 'Fewer lost events' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Use an event bus/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feature',
        adrIds: ['11111111-1111-4111-8111-111111111111'],
      }),
      expect.any(Object),
    ));
  });

  it('does not show or submit ADRs for an issue', async () => {
    render(<FeatureRequestModal selectedProject="Apex" type="issue" onClose={jest.fn()} />);
    expect(screen.queryByText(/Related accepted ADRs/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Save fails' } });
    fireEvent.change(screen.getByLabelText('Request'), { target: { value: 'Saving returns an error' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalled());
    expect(mockMutate.mock.calls[0][0]).not.toHaveProperty('adrIds');
    expect(mockUseAvailableAdrs).toHaveBeenCalledWith('Apex', false);
  });
});
