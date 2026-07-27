import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProposedAdrChangesReview } from '../ProposedAdrChangesReview';

const mockApplyAll = jest.fn();
const mockSelective = jest.fn().mockResolvedValue(undefined);
const mockReject = jest.fn();
const mockRegenerate = jest.fn().mockResolvedValue({});

jest.mock('../../hooks/useAdrs', () => ({
  useApplyProposedAdr: () => ({ mutate: mockApplyAll, isPending: false }),
  useApplyProposedAdrSelective: () => ({
    mutateAsync: mockSelective,
    isPending: false,
  }),
  useRejectProposedAdr: () => ({ mutate: mockReject, isPending: false }),
  useRegenerateProposedAdrSection: () => ({
    mutateAsync: mockRegenerate,
    isPending: false,
  }),
}));

jest.mock('../ChangeReviewWizard', () => ({
  ChangeReviewWizard: ({
    onFinish,
  }: {
    onFinish: (units: unknown[]) => void;
  }) => (
    <div data-testid="change-review-wizard">
      <button type="button" onClick={() => onFinish([])}>
        Finish wizard
      </button>
    </div>
  ),
}));

jest.mock('../PrdFixActionStrip', () => ({
  PrdFixActionStrip: ({
    summaryLabel,
    onAcceptAll,
    onRevert,
  }: {
    summaryLabel: string;
    onAcceptAll: () => void;
    onRevert: () => void;
  }) => (
    <div data-testid="fix-action-strip">
      <span>{summaryLabel}</span>
      <button type="button" onClick={onAcceptAll}>
        Accept all
      </button>
      <button type="button" onClick={onRevert}>
        Reject all
      </button>
    </div>
  ),
}));

jest.mock('../ProposedChangesReview.module.css', () => new Proxy({}, { get: (_t, k) => String(k) }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('ProposedAdrChangesReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when proposedContent is null', () => {
    const { container } = render(
      <ProposedAdrChangesReview adrId="adr-1" currentContent="# ADR" proposedContent={null} />,
      { wrapper },
    );
    expect(container.firstChild).toBeNull();
  });

  it('auto-opens wizard for proposed ADR edits', () => {
    render(
      <ProposedAdrChangesReview
        adrId="adr-1"
        currentContent={'line1\nold\nline3'}
        proposedContent={'line1\nnew\nline3'}
        fixCommentId="c1"
      />,
      { wrapper },
    );
    expect(screen.getByText('Comment fix ready')).toBeInTheDocument();
    expect(screen.getByTestId('change-review-wizard')).toBeInTheDocument();
  });

  it('calls selective apply on finish', async () => {
    render(
      <ProposedAdrChangesReview
        adrId="adr-1"
        currentContent={'line1\nold\nline3'}
        proposedContent={'line1\nnew\nline3'}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('button', { name: /finish wizard/i }));
    await waitFor(() => expect(mockSelective).toHaveBeenCalled());
  });
});
