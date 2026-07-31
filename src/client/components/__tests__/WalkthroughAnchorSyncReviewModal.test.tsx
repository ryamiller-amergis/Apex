import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalkthroughAnchorSyncReviewModal } from '../WalkthroughAnchorSyncReviewModal';
import { MOCK_WALKTHROUGH_ANCHOR_SYNC_CANDIDATES } from '../walkthroughAnchorManagementMockData';

describe('WalkthroughAnchorSyncReviewModal enrichment gating', () => {
  it('disables Save while AI enrichment is running', () => {
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
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('Waiting for AI…');
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

  it('exposes batch size options 10, 20, and 50', async () => {
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
    expect(screen.getByText(/What AI smart-tagging does/i)).toBeInTheDocument();
    await user.click(screen.getByTestId('walkthrough-anchor-sync-info-close'));
    expect(screen.queryByTestId('walkthrough-anchor-sync-info-panel')).not.toBeInTheDocument();
  });
});
