import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProposedDesignDocChangesReview } from '../ProposedDesignDocChangesReview';

const mockApplyAll = jest.fn();
const mockSelective = jest.fn().mockResolvedValue(undefined);
const mockReject = jest.fn();
const mockRegenerate = jest.fn().mockResolvedValue({});

jest.mock('../../hooks/useInterviews', () => ({
  useApplyProposedDesignDoc: () => ({ mutate: mockApplyAll, isPending: false }),
  useApplyProposedDesignDocSelective: () => ({
    mutateAsync: mockSelective,
    isPending: false,
  }),
  useRejectProposedDesignDoc: () => ({ mutate: mockReject, isPending: false }),
  useRegenerateProposedDesignDocSection: () => ({
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
    onContinueReview,
    onAcceptAll,
    onRevert,
  }: {
    summaryLabel: string;
    onContinueReview: () => void;
    onAcceptAll: () => void;
    onRevert: () => void;
  }) => (
    <div data-testid="fix-action-strip">
      <span>{summaryLabel}</span>
      <button type="button" onClick={onContinueReview}>
        Continue review
      </button>
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
jest.mock('../PrdFixActionStrip.module.css', () => new Proxy({}, { get: (_t, k) => String(k) }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('ProposedDesignDocChangesReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when no proposed sections', () => {
    const { container } = render(
      <ProposedDesignDocChangesReview
        designDocId="doc-1"
        currentDesign="a"
        currentTechSpec="b"
        currentAssumptions="c"
      />,
      { wrapper },
    );
    expect(container.firstChild).toBeNull();
  });

  it('auto-opens the wizard and shows comment-fix strip label', () => {
    render(
      <ProposedDesignDocChangesReview
        designDocId="doc-1"
        currentDesign={'line1\nold\nline3'}
        currentTechSpec="tech"
        currentAssumptions="assumptions"
        proposedDesignContent={'line1\nnew\nline3'}
        fixCommentId="c1"
      />,
      { wrapper },
    );

    expect(screen.getByText('Comment fix ready')).toBeInTheDocument();
    expect(screen.getByTestId('change-review-wizard')).toBeInTheDocument();
  });

  it('calls selective apply when wizard finishes', async () => {
    render(
      <ProposedDesignDocChangesReview
        designDocId="doc-1"
        currentDesign={'line1\nold\nline3'}
        currentTechSpec="tech"
        currentAssumptions="assumptions"
        proposedDesignContent={'line1\nnew\nline3'}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /finish wizard/i }));
    await waitFor(() => expect(mockSelective).toHaveBeenCalled());
  });

  it('accept all / reject all use full apply/reject mutations', () => {
    render(
      <ProposedDesignDocChangesReview
        designDocId="doc-1"
        currentDesign={'line1\nold\nline3'}
        currentTechSpec="tech"
        currentAssumptions="assumptions"
        proposedDesignContent={'line1\nnew\nline3'}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: /accept all/i }));
    expect(mockApplyAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /reject all/i }));
    expect(mockReject).toHaveBeenCalled();
  });
});
