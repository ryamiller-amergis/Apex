import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  SYNC_REVIEW_PAGE_SIZE,
  WalkthroughAnchorSyncReviewModal,
} from '../WalkthroughAnchorSyncReviewModal';
import { MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES } from '../walkthroughAnchorManagementMockData';

function classifiedCandidates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES[0],
    id: `classified-${i}`,
    testId: `classified-btn-${i}`,
    anchorKey: `classified-btn-${i}`,
    smartTags: ['adr', 'button'],
    aiProvenance: {
      provider: 'cursor' as const,
      model: 'anchor-classifier',
      skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
      generatedAt: '2026-07-30T04:00:00.000Z',
      confidence: 0.9,
      rationale: 'AdrChatView.tsx:705',
    },
  }));
}

describe('WalkthroughAnchorSyncReviewModal enrichment gating', () => {
  it('places classifier-tagged rows in Ready and keeps Save usable', async () => {
    const user = userEvent.setup();
    const classified = {
      ...MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES[0],
      id: 'classifier-ready-1',
      testId: 'ado-create-error',
      anchorKey: 'ado-create-error',
      smartTags: ['ado', 'create', 'error'],
      aiProvenance: {
        provider: 'cursor' as const,
        model: 'anchor-classifier',
        skillPath: '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        generatedAt: '2026-07-30T04:00:00.000Z',
        confidence: 0.9,
        rationale: 'CreateAdoItemsModal.tsx:415',
      },
    };

    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={[classified]}
        enrichmentStatus="idle"
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-anchor-sync-section-ready')).toBeInTheDocument();
    expect(screen.getByText('Classifier')).toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-anchor-sync-approve-ready'));
    expect(screen.getByTestId('walkthrough-anchor-sync-save')).not.toBeDisabled();
  });
  it('keeps Save enabled while background AI refine is running', () => {
    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES}
        enrichmentStatus="running"
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-anchor-sync-enrichment-running')).toBeInTheDocument();
    const save = screen.getByTestId('walkthrough-anchor-sync-save');
    expect(save).toHaveTextContent('Save decided (0)');
    expect(save).toBeDisabled();
  });

  it('allows Save after AI enrichment finishes', async () => {
    const user = userEvent.setup();
    const onSave = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();

    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES}
        enrichmentStatus="ready"
        enrichmentMessage="AI smart-tagging updated 2 candidate(s)."
        onClose={onClose}
        onSave={onSave}
      />,
    );

    expect(screen.getByTestId('walkthrough-anchor-sync-enrichment-ready')).toBeInTheDocument();
    const save = screen.getByTestId('walkthrough-anchor-sync-save');
    expect(save).toBeDisabled();

    await user.click(screen.getByTestId('walkthrough-anchor-sync-approve-ready'));
    expect(save).not.toBeDisabled();
    await user.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('walkthrough-anchor-sync-empty')).toBeInTheDocument();
  });

  it('select all in Ready section only selects AI-enriched rows', async () => {
    const user = userEvent.setup();
    const scannerOnly = {
      ...MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES[0],
      id: 'scanner-only-1',
      testId: 'scanner-only-1',
      anchorKey: 'scanner-only-1',
      smartTags: [] as string[],
      aiProvenance: null,
    };
    const candidates = [...MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES, scannerOnly];

    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={candidates}
        enrichmentStatus="ready"
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-anchor-sync-section-ready')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-anchor-sync-section-needs_ai')).toBeInTheDocument();

    await user.click(screen.getByTestId('walkthrough-anchor-sync-select-section-ready'));

    for (const row of MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES) {
      expect(screen.getByTestId(`walkthrough-anchor-sync-select-${row.id}`)).toBeChecked();
    }
    expect(screen.getByTestId('walkthrough-anchor-sync-select-scanner-only-1')).not.toBeChecked();
  });

  it('renders only a page of rows per section and reveals more on demand', async () => {
    const user = userEvent.setup();
    const total = SYNC_REVIEW_PAGE_SIZE * 2 + 10;

    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={classifiedCandidates(total)}
        enrichmentStatus="idle"
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );

    const ready = screen.getByTestId('walkthrough-anchor-sync-section-ready');
    expect(ready.querySelectorAll('[data-testid^="walkthrough-anchor-sync-row-"]')).toHaveLength(
      SYNC_REVIEW_PAGE_SIZE,
    );
    expect(screen.getByTestId('walkthrough-anchor-sync-pager-ready')).toBeInTheDocument();

    await user.click(screen.getByTestId('walkthrough-anchor-sync-show-more-ready'));
    expect(ready.querySelectorAll('[data-testid^="walkthrough-anchor-sync-row-"]')).toHaveLength(
      SYNC_REVIEW_PAGE_SIZE * 2,
    );

    // Bulk actions still cover the unrendered rows.
    expect(screen.getByTestId('walkthrough-anchor-sync-approve-ready')).toHaveTextContent(
      `Approve ready (${total})`,
    );
    await user.click(screen.getByTestId('walkthrough-anchor-sync-approve-ready'));
    expect(screen.getByTestId('walkthrough-anchor-sync-save')).toHaveTextContent(
      `Save decided (${total})`,
    );
  });

  it('exposes batch size options 10, 20, 50, and All', async () => {
    const user = userEvent.setup();
    const onBatchSizeChange = jest.fn();
    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES}
        enrichmentStatus="idle"
        batchSize={20}
        onBatchSizeChange={onBatchSizeChange}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-anchor-sync-batch-size-10')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-anchor-sync-batch-size-20')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-anchor-sync-batch-size-50')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-anchor-sync-batch-size-all')).toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-anchor-sync-batch-size-50'));
    expect(onBatchSizeChange).toHaveBeenCalledWith(50);
  });

  it('toggles the workflow info panel from the Planning-style info icon', async () => {
    const user = userEvent.setup();
    render(
      <WalkthroughAnchorSyncReviewModal
        candidates={MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES}
        enrichmentStatus="idle"
        onClose={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('walkthrough-anchor-sync-info-panel')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-anchor-sync-info'));
    expect(screen.getByTestId('walkthrough-anchor-sync-info-panel')).toBeInTheDocument();
    expect(screen.getByText(/What optional background AI does/i)).toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-anchor-sync-info-close'));
    expect(screen.queryByTestId('walkthrough-anchor-sync-info-panel')).not.toBeInTheDocument();
  });
});
