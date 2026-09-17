import { act, fireEvent, render, screen } from '@testing-library/react';
import { PrdTriggerStatus } from '../PrdTriggerStatus';
import type { InterviewSummary } from '../../../shared/types/interview';

const mockMutate = jest.fn();
jest.mock('../../hooks/useInterviews', () => ({
  useRetryPrdFromPhase: jest.fn(() => ({
    mutate: (...args: unknown[]) => mockMutate(...args),
    isPending: false,
  })),
}));

function failedInterview(overrides: Partial<InterviewSummary> = {}): InterviewSummary {
  return {
    id: 'iv-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    title: 'Phase interview',
    project: 'Apex',
    repo: 'Apex',
    status: 'complete',
    prdCount: 0,
    phaseFlow: 'technical_only',
    technicalPhaseStatus: 'approved',
    technicalApprovedAt: new Date(Date.now() - 300_000).toISOString(),
    createdAt: '2026-09-17T12:00:00Z',
    updatedAt: '2026-09-17T12:00:00Z',
    ...overrides,
  };
}

function renderStatus(interview = failedInterview()) {
  return render(
    <PrdTriggerStatus
      interview={interview}
      canManage
      onOpenPrd={jest.fn()}
      {...{ 'data-testid': 'prd-trigger-status' }}
    />,
  );
}

describe('PBI-006 AC-1 PrdTriggerStatus retry attempt state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('switches failed to generating immediately when Retry is clicked', () => {
    renderStatus();

    expect(screen.getByTestId('prd-trigger-status')).toHaveTextContent('PRD generation failed');

    fireEvent.click(screen.getByRole('button', { name: 'Retry automatic PRD generation' }));

    expect(mockMutate).toHaveBeenCalledWith('iv-1', expect.any(Object));
    expect(screen.getByTestId('prd-trigger-status')).toHaveTextContent('PRD generating');
    expect(
      screen.queryByRole('button', { name: 'Retry automatic PRD generation' }),
    ).not.toBeInTheDocument();
  });

  it('returns to failed and announces the error when the retry request fails', () => {
    renderStatus();

    fireEvent.click(screen.getByRole('button', { name: 'Retry automatic PRD generation' }));
    expect(screen.getByTestId('prd-trigger-status')).toHaveTextContent('PRD generating');

    const [, callbacks] = mockMutate.mock.calls[0] as [
      string,
      { onError: (error: Error) => void },
    ];
    act(() => callbacks.onError(new Error('Retry rejected by server')));

    const status = screen.getByTestId('prd-trigger-status');
    expect(status).toHaveTextContent('PRD generation failed');
    expect(status).toHaveTextContent('Retry rejected by server');
    expect(screen.getByRole('button', { name: 'Retry automatic PRD generation' })).toBeInTheDocument();
  });

  it('returns to failed once the retry window elapses without a PRD', () => {
    jest.useFakeTimers();
    try {
      renderStatus();
      fireEvent.click(screen.getByRole('button', { name: 'Retry automatic PRD generation' }));
      expect(screen.getByTestId('prd-trigger-status')).toHaveTextContent('PRD generating');

      act(() => jest.advanceTimersByTime(60_000));

      expect(screen.getByTestId('prd-trigger-status')).toHaveTextContent('PRD generation failed');
    } finally {
      jest.useRealTimers();
    }
  });
});
