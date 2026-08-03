/**
 * Tests for ProposedChangesReview component (section-by-section wizard entry).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProposedChangesReview } from '../ProposedChangesReview';

const mockRejectMutate = jest.fn();
const mockSelectiveMutateAsync = jest.fn().mockResolvedValue(undefined);
const mockRegenerateMutateAsync = jest.fn().mockResolvedValue({});

jest.mock('../../hooks/useInterviews', () => ({
  useRejectProposedPrd: () => ({
    mutate: mockRejectMutate,
    isPending: false,
  }),
  useApplyProposedPrdSelective: () => ({
    mutateAsync: mockSelectiveMutateAsync,
    isPending: false,
  }),
  useRegenerateProposedPrdSection: () => ({
    mutateAsync: mockRegenerateMutateAsync,
    isPending: false,
  }),
  useUpdatePrdContent: () => ({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
  useUpdatePrdBacklog: () => ({
    mutateAsync: jest.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
}));

jest.mock('../DiffView', () => ({
  DiffView: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <div data-testid="diff-view" data-old={oldText} data-new={newText} />
  ),
}));

jest.mock('../ChangeReviewWizard', () => ({
  ChangeReviewWizard: ({
    onFinish,
    onCancel,
  }: {
    onFinish: (units: unknown[]) => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="change-review-wizard">
      <button type="button" onClick={() => onFinish([])}>
        Finish wizard
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          Minimize
        </button>
      )}
    </div>
  ),
}));

jest.mock('../ProposedChangesReview.module.css', () => new Proxy({}, { get: (_t, k) => String(k) }));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

const defaultProps = {
  prdId: 'prd-1',
  currentContent: '# Current Content\n\nSome text here.',
};

describe('ProposedChangesReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when both proposedContent and proposedBacklogJson are null/undefined', () => {
    const { container } = render(
      <ProposedChangesReview {...defaultProps} />,
      { wrapper: createWrapper() },
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a banner/notice when proposedContent is non-null', () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        proposedContent="# Proposed Content\n\nNew text."
      />,
      { wrapper: createWrapper() },
    );
    expect(screen.getByText(/apex assistant has proposed changes/i)).toBeInTheDocument();
  });

  it('expands preview when "Preview Changes" is clicked', () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        proposedContent="# Proposed"
      />,
      { wrapper: createWrapper() },
    );

    expect(screen.queryByTestId('diff-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    expect(screen.getByTestId('diff-view')).toBeInTheDocument();
  });

  it('opens the section-by-section wizard in a modal', () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        proposedContent={'line1\nold\nline3'}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: /review section by section/i }));
    expect(screen.getByTestId('change-review-wizard')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /review proposed changes/i })).toBeInTheDocument();
  });

  it('supports hideBanner with controlled modal for comment/assistant proposals', () => {
    const onProgress = jest.fn();
    render(
      <ProposedChangesReview
        {...defaultProps}
        proposedContent={'line1\nold\nline3'}
        hideBanner
        deferAutoOpen
        modalOpen
        onModalOpenChange={jest.fn()}
        onReviewProgress={onProgress}
      />,
      { wrapper: createWrapper() },
    );

    expect(screen.queryByText(/apex assistant has proposed changes/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('change-review-wizard')).toBeInTheDocument();
    expect(onProgress).toHaveBeenCalled();
  });

  it('calls reject mutation when "Reject all" is clicked', () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        proposedContent="# Proposed"
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: /reject all/i }));
    expect(mockRejectMutate).toHaveBeenCalledTimes(1);
  });

  it('calls selective apply when wizard finishes', async () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        proposedContent={'line1\nold\nline3'}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: /review section by section/i }));
    fireEvent.click(screen.getByRole('button', { name: /finish wizard/i }));

    await waitFor(() => {
      expect(mockSelectiveMutateAsync).toHaveBeenCalled();
    });
  });

  it('auto-opens the review modal in fix-baseline mode when there are changes', () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        reviewMode="fix-baseline"
        currentContent={'line1\nold\nline3'}
        proposedContent={'line1\nnew\nline3'}
      />,
      { wrapper: createWrapper() },
    );

    expect(screen.getByTestId('change-review-wizard')).toBeInTheDocument();
    expect(screen.getByText(/apex has applied fixes/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /review apex fixes/i })).toBeInTheDocument();
  });

  it('minimizes the modal and allows continuing review', () => {
    render(
      <ProposedChangesReview
        {...defaultProps}
        reviewMode="fix-baseline"
        currentContent={'line1\nold\nline3'}
        proposedContent={'line1\nnew\nline3'}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: /minimize review/i }));
    expect(screen.getByRole('button', { name: /continue review/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /continue review/i }));
    expect(screen.getByRole('dialog', { name: /review apex fixes/i })).toBeInTheDocument();
  });

  it('renders backlog changes via BacklogChangesView when proposedBacklogJson is provided', () => {
    const proposedBacklogJson = {
      epics: [
        { title: 'Epic Alpha', features: [{ title: 'Feature 1' }] },
        { title: 'Epic Beta' },
      ],
    };
    const currentBacklogJson = {
      epics: [
        { title: 'Epic Alpha', features: [{ title: 'Feature 1' }] },
      ],
    };

    render(
      <ProposedChangesReview
        {...defaultProps}
        currentBacklogJson={currentBacklogJson}
        proposedBacklogJson={proposedBacklogJson}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: /preview changes/i }));
    expect(screen.getByText('Backlog Changes')).toBeInTheDocument();
    expect(screen.getByText('1 added')).toBeInTheDocument();
    expect(screen.getByText('Epic Beta')).toBeInTheDocument();
  });
});
