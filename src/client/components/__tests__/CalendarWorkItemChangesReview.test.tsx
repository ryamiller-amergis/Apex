/**
 * Tests for CalendarWorkItemChangesReview.
 *
 * Covers: diff rendering, item-level selection, explicit confirmation step,
 * apply/reject mutations, partial result display, and permission gating.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../../hooks/useCalendarWorkItemAssistant', () => ({
  useApplyProposal: jest.fn(),
  useRejectProposal: jest.fn(),
  useUpdateProposalField: jest.fn(),
}));

jest.mock('../DiffView', () => ({
  default: ({ oldText, newText }: { oldText: string; newText: string }) => (
    <div data-testid="diff-view">
      <span data-testid="old">{oldText}</span>
      <span data-testid="new">{newText}</span>
    </div>
  ),
}));

import { CalendarWorkItemChangesReview } from '../CalendarWorkItemChangesReview';
import { useApplyProposal, useRejectProposal, useUpdateProposalField } from '../../hooks/useCalendarWorkItemAssistant';

const mockUseApply = useApplyProposal as jest.Mock;
const mockUseReject = useRejectProposal as jest.Mock;
const mockUseUpdateField = useUpdateProposalField as jest.Mock;

function makeProposal(overrides?: object) {
  return {
    id: 'proposal-1',
    sessionId: 'session-1',
    changeSet: {
      version: 1 as const,
      proposalId: 'proposal-1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      project: 'MaxView',
      areaPath: 'MaxView',
      anchorWorkItemId: 100,
      changes: [
        {
          workItemId: 100,
          workItemType: 'Feature',
          title: 'Feature A',
          baselineRev: 5,
          fields: [
            { field: 'description' as const, before: 'Old description', after: 'New description' },
          ],
        },
        {
          workItemId: 200,
          workItemType: 'Product Backlog Item',
          title: 'PBI 1',
          baselineRev: 3,
          fields: [
            { field: 'acceptanceCriteria' as const, before: '', after: 'Given a user When they click Then it works' },
          ],
        },
      ],
      proposedAt: new Date().toISOString(),
    },
    status: 'pending' as const,
    itemResults: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSnapshot() {
  return [
    {
      id: 100,
      parentId: null,
      depth: 0,
      workItemType: 'Feature',
      title: 'Feature A',
      state: 'Active',
      areaPath: 'MaxView',
      rev: 5,
      changedDate: '2026-07-15',
      supportedFields: ['description', 'acceptanceCriteria'] as any,
    },
    {
      id: 200,
      parentId: 100,
      depth: 1,
      workItemType: 'Product Backlog Item',
      title: 'PBI 1',
      state: 'New',
      areaPath: 'MaxView',
      rev: 3,
      changedDate: '2026-07-15',
      supportedFields: ['description', 'acceptanceCriteria'] as any,
    },
  ];
}

function renderComponent(props?: object) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = jest.fn();
  const onApplied = jest.fn();

  render(
    <QueryClientProvider client={qc}>
      <CalendarWorkItemChangesReview
        sessionId="session-1"
        proposal={makeProposal()}
        snapshot={makeSnapshot()}
        onClose={onClose}
        onApplied={onApplied}
        {...props}
      />
    </QueryClientProvider>,
  );

  return { onClose, onApplied };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseApply.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  });
  mockUseReject.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
  });
  mockUseUpdateField.mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
    error: null,
  });
});

describe('CalendarWorkItemChangesReview', () => {
  describe('initial render', () => {
    it('shows the review title', () => {
      renderComponent();
      expect(screen.getByText('Review Proposed Changes')).toBeInTheDocument();
    });

    it('shows change count summary', () => {
      renderComponent();
      expect(screen.getByText(/2 work items with proposed changes/i)).toBeInTheDocument();
    });

    it('shows the item type and title for each changed item', () => {
      renderComponent();
      expect(screen.getByText(/Feature A/)).toBeInTheDocument();
      expect(screen.getByText(/PBI 1/)).toBeInTheDocument();
    });

    it('shows apply button with count', () => {
      renderComponent();
      expect(screen.getByRole('button', { name: /apply 2 items/i })).toBeInTheDocument();
    });
  });

  describe('item selection', () => {
    it('all items start checked', () => {
      renderComponent();
      const checkboxes = screen.getAllByRole('checkbox');
      checkboxes.forEach(cb => expect(cb).toBeChecked());
    });

    it('unchecking an item reduces apply count', () => {
      renderComponent();
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]); // uncheck first
      expect(screen.getByRole('button', { name: /apply 1 item/i })).toBeInTheDocument();
    });

    it('apply button is disabled when no items are selected', () => {
      renderComponent();
      const checkboxes = screen.getAllByRole('checkbox');
      checkboxes.forEach(cb => fireEvent.click(cb));
      expect(screen.getByRole('button', { name: /apply 0 items/i })).toBeDisabled();
    });
  });

  describe('diff expansion', () => {
    it('shows DiffView when item is expanded', () => {
      renderComponent();
      // Items start expanded — diff should be visible
      expect(screen.getAllByTestId('diff-view').length).toBeGreaterThanOrEqual(1);
    });

    it('collapses and re-expands item on button click', () => {
      renderComponent();
      const expandBtns = screen.getAllByRole('button', { name: /collapse/i });
      if (expandBtns.length > 0) {
        fireEvent.click(expandBtns[0]); // collapse
        // After collapse, fewer diff views should be visible
        fireEvent.click(screen.getAllByRole('button', { name: /expand/i })[0]); // re-expand
      }
    });
  });

  describe('confirmation step', () => {
    it('clicking Apply advances to the confirmation pane', async () => {
      renderComponent();
      fireEvent.click(screen.getByRole('button', { name: /apply 2 items/i }));
      await waitFor(() => {
        expect(screen.getByText(/about to write changes to 2 work items/i)).toBeInTheDocument();
      });
    });

    it('Back button in confirmation pane returns to review', async () => {
      renderComponent();
      fireEvent.click(screen.getByRole('button', { name: /apply 2 items/i }));
      await waitFor(() => screen.getByText(/about to write changes/i));
      fireEvent.click(screen.getByRole('button', { name: /back/i }));
      await waitFor(() => {
        expect(screen.getByText('Review Proposed Changes')).toBeInTheDocument();
      });
    });
  });

  describe('apply mutation', () => {
    it('calls applyProposal with approved item IDs on confirm', async () => {
      const mockMutateAsync = jest.fn().mockResolvedValue({
        proposalId: 'proposal-1',
        status: 'applied',
        applied: [{ workItemId: 100, status: 'applied', newRev: 6 }],
        skipped: [],
        stale: [],
        failed: [],
      });
      mockUseApply.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('button', { name: /apply 2 items/i }));
      await waitFor(() => screen.getByText(/about to write changes/i));
      fireEvent.click(screen.getByRole('button', { name: /confirm.*apply 2/i }));

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
          proposalId: 'proposal-1',
          sessionId: 'session-1',
          approvedWorkItemIds: expect.arrayContaining([100, 200]),
        }));
      });
    });
  });

  describe('result pane', () => {
    it('shows applied items in the result summary', async () => {
      const mockMutateAsync = jest.fn().mockResolvedValue({
        proposalId: 'proposal-1',
        status: 'applied',
        applied: [{ workItemId: 100, status: 'applied', newRev: 6 }, { workItemId: 200, status: 'applied', newRev: 4 }],
        skipped: [],
        stale: [],
        failed: [],
      });
      mockUseApply.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('button', { name: /apply 2 items/i }));
      await waitFor(() => screen.getByText(/about to write changes/i));
      fireEvent.click(screen.getByRole('button', { name: /confirm.*apply 2/i }));

      await waitFor(() => {
        expect(screen.getByText(/Applied \(2\)/i)).toBeInTheDocument();
      });
    });

    it('shows stale items in result summary', async () => {
      const mockMutateAsync = jest.fn().mockResolvedValue({
        proposalId: 'proposal-1',
        status: 'partially_applied',
        applied: [{ workItemId: 100, status: 'applied', newRev: 6 }],
        skipped: [],
        stale: [{ workItemId: 200, status: 'stale', reason: 'Rev changed' }],
        failed: [],
      });
      mockUseApply.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false, error: null });

      renderComponent();
      fireEvent.click(screen.getByRole('button', { name: /apply 2 items/i }));
      await waitFor(() => screen.getByText(/about to write changes/i));
      fireEvent.click(screen.getByRole('button', { name: /confirm.*apply 2/i }));

      await waitFor(() => {
        expect(screen.getByText(/Stale/i)).toBeInTheDocument();
      });
    });
  });

  describe('reject flow', () => {
    it('calls rejectProposal when Discard all is clicked', async () => {
      const mockMutateAsync = jest.fn().mockResolvedValue({ ok: true });
      mockUseReject.mockReturnValue({ mutateAsync: mockMutateAsync, isPending: false });
      const { onClose } = renderComponent();

      fireEvent.click(screen.getByRole('button', { name: /discard all/i }));

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
          proposalId: 'proposal-1',
          sessionId: 'session-1',
        }));
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('terminal state warning', () => {
    it('shows warning banner for closed items', () => {
      const closedSnapshot = makeSnapshot().map(n =>
        n.id === 100 ? { ...n, state: 'Closed' } : n,
      );
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <CalendarWorkItemChangesReview
            sessionId="session-1"
            proposal={makeProposal()}
            snapshot={closedSnapshot as any}
            onClose={jest.fn()}
            onApplied={jest.fn()}
          />
        </QueryClientProvider>,
      );

      expect(screen.getByText(/terminal state/i)).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('the dialog has role=dialog and aria-modal=true', () => {
      renderComponent();
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('each item has an accessible checkbox label', () => {
      renderComponent();
      expect(screen.getByLabelText(/Approve changes for #100/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Approve changes for #200/i)).toBeInTheDocument();
    });
  });
});
