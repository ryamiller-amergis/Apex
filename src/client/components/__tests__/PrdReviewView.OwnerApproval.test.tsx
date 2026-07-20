/**
 * Tests for the two-stage owner approval feature in PrdReviewView.
 *
 * Coverage:
 *  1. "Approve as Owner" button shown when status=pending_review and user is owner
 *  2. "Pending Review" label shown when status=pending_review and user is NOT owner
 *  3. Owner approval buttons hidden in other statuses
 *  4. Approvals modal opens and shows groups
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdReviewView } from '../PrdReviewView';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/backlog/prd/prd-1' }),
}));

const mockUseAppShell = jest.fn();
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: (...args: unknown[]) => mockUseAppShell(...args),
}));

const mockUsePrd = jest.fn();
const mockUseOwnerApprove = jest.fn();
const mockUseInterview = jest.fn();
const mockUseActiveUsers = jest.fn();
const mockUseDocumentAssignments = jest.fn();

jest.mock('../../hooks/useInterviews', () => ({
  usePrd: (...args: unknown[]) => mockUsePrd(...args),
  usePrdTestCases: jest.fn(() => ({ data: null })),
  useInterview: (...args: unknown[]) => mockUseInterview(...args),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useUpdatePrdContent: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useUpdatePrdBacklog: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSubmitPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useWithdrawPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReopenPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReviewPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeletePrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useCreatePrdAdoItems: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSyncPrdAdoStatus: jest.fn(() => ({ data: null })),
  useReassignApprovers: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixPrdWithAi: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixPrdCommentWithAi: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreatePrdValidationThread: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCancelPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRefreshPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixPrdValidation: jest.fn(() => ({
    mutateAsync: jest.fn().mockResolvedValue({ threadId: 'validation-thread-1' }),
    isPending: false,
  })),
  useAcceptFixPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRevertPrdSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useScreenInventoryRoutes: jest.fn(() => ({ data: [] })),
  usePrdValidationReport: jest.fn(() => ({ data: null })),
  useDocumentAssignments: (...args: unknown[]) => mockUseDocumentAssignments(...args),
  useReviewTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDesignDocsByPrdId: jest.fn(() => ({ data: [] })),
  useGenerateTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRecalculateTestCaseCoverage: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreateDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useOwnerApprove: (...args: unknown[]) => mockUseOwnerApprove(...args),
  useOwnerApproval: jest.fn(() => ({ data: null })),
  useActiveUsers: (...args: unknown[]) => mockUseActiveUsers(...args),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn(() => ({ data: { approvalMode: 'any_one' } })),
}));

jest.mock('../../hooks/useReviewComments', () => ({
  useReviewComments: jest.fn(() => ({ data: [] })),
  useUnresolvedCommentCount: jest.fn(() => ({ data: { count: 0 } })),
  useCreateComment: jest.fn(() => ({ mutateAsync: jest.fn() })),
  useResolveComment: jest.fn(() => ({ mutate: jest.fn() })),
  useReopenComment: jest.fn(() => ({ mutate: jest.fn() })),
  useDeleteComment: jest.fn(() => ({ mutate: jest.fn() })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
jest.mock('../ApproverSelectModal', () => ({ ApproverSelectModal: () => null }));
jest.mock('../AnnotationLayer', () => ({
  AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../BacklogViewer', () => ({ BacklogViewer: () => null }));
jest.mock('../ReviewerApprovalChecklist', () => ({
  ReviewerApprovalChecklist: ({ groups }: { groups: { label: string; rows: { name: string; status: string }[] }[] }) => (
    <div data-testid="reviewer-approval-checklist">
      {groups.map((g) => (
        <div key={g.label}><span>{g.label}</span></div>
      ))}
    </div>
  ),
}));
jest.mock('../CreateAdoItemsModal', () => ({ CreateAdoItemsModal: () => null }));

jest.mock('../../hooks/useDesignPrototypes', () => ({
  usePrototypesForPrd: jest.fn(() => ({ data: [] })),
  useGeneratePrototypesForPrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

jest.mock('../../hooks/useDesignPlan', () => ({
  useDesignPlan: jest.fn(() => ({ data: null })),
}));

// ── Base fixtures ──────────────────────────────────────────────────────────────

const basePrd = {
  id: 'prd-1',
  interviewId: 'interview-1',
  project: 'proj-alpha',
  title: 'Feature PRD',
  content: '# PRD\nContent here.',
  backlogJson: null,
  status: 'pending_review',
  authorId: 'user-author',
  authorName: 'Alice Author',
  ownerId: 'user-owner',
  ownerName: 'Bob Owner',
  reviewerId: null,
  reviewerName: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

// ── Render helper ──────────────────────────────────────────────────────────────

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/prd/prd-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<PrdReviewView />, { wrapper: Wrapper });
}

function openApprovalsModal() {
  fireEvent.click(screen.getByRole('button', { name: /More actions/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Approvals/i }));
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
  mockUseOwnerApprove.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
  mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false });
  mockUseInterview.mockReturnValue({ data: null });
  mockUseActiveUsers.mockReturnValue({ data: [] });
  mockUseDocumentAssignments.mockReturnValue({ data: [] });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Owner Approval in PrdReviewView', () => {
  it('shows "Approve as Owner" button when status=pending_review and user is owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    expect(screen.getByText('Approve as Owner')).toBeInTheDocument();
    expect(screen.getByText('Request Revision')).toBeInTheDocument();
  });

  it('shows "Approve as Owner" button for admin even if not owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'admin-user', isAdmin: true });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    expect(screen.getByText('Approve as Owner')).toBeInTheDocument();
  });

  it('disables "Approve as Owner" when an assigned reviewer is still pending', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseDocumentAssignments.mockImplementation((_id: unknown, documentType: unknown) =>
      documentType === 'prd'
        ? { data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Rev One', status: 'pending' }] }
        : { data: [] },
    );

    renderView();

    const approveButton = screen.getByRole('button', { name: 'Approve as Owner' });
    expect(approveButton).toBeDisabled();
    expect(approveButton).toHaveAttribute(
      'title',
      'Reviewers must approve the PRD before owner approval',
    );
    expect(screen.getByText('Request Revision')).not.toBeDisabled();
  });

  it('enables "Approve as Owner" once the assigned reviewer is approved', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseDocumentAssignments.mockImplementation((_id: unknown, documentType: unknown) =>
      documentType === 'prd'
        ? { data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Rev One', status: 'approved' }] }
        : { data: [] },
    );

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).not.toBeDisabled();
  });

  it('allows an admin to approve even when a reviewer is still pending', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'admin-user', isAdmin: true });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseDocumentAssignments.mockImplementation((_id: unknown, documentType: unknown) =>
      documentType === 'prd'
        ? { data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Rev One', status: 'pending' }] }
        : { data: [] },
    );

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).not.toBeDisabled();
  });

  it('disables "Approve as Owner" when reviewers are configured on interview but no assignment records', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseDocumentAssignments.mockReturnValue({ data: [] });
    mockUseInterview.mockReturnValue({
      data: { id: 'interview-1', prdApproverIds: ['reviewer-1', 'reviewer-2'] },
    });

    renderView();

    const approveButton = screen.getByRole('button', { name: 'Approve as Owner' });
    expect(approveButton).toBeDisabled();
  });

  it('shows "Pending Review" label when status=pending_review and user is NOT owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    const matches = screen.getAllByText('Pending Review');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Approve as Owner')).not.toBeInTheDocument();
  });

  it('does not show owner approval UI when status is not pending_review', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, status: 'draft' },
      isLoading: false, isError: false,
    });

    renderView();

    expect(screen.queryByText('Approve as Owner')).not.toBeInTheDocument();
  });

  it('shows "Pending Review" status label in the badge area', () => {
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    expect(screen.getAllByText('Pending Review').length).toBeGreaterThanOrEqual(1);
  });

  it('opens the approvals modal from the overflow menu', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    openApprovalsModal();

    expect(screen.getByRole('dialog', { name: 'Approvals' })).toBeInTheDocument();
    expect(screen.getByText('Owner Approval')).toBeInTheDocument();
  });

  it('shows "Design Prototype Review" group when prototype approvers are set', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseInterview.mockReturnValue({
      data: {
        id: 'interview-1',
        designPrototypeApproverIds: ['proto-reviewer-1'],
      },
    });
    mockUseActiveUsers.mockReturnValue({
      data: [{ oid: 'proto-reviewer-1', displayName: 'Proto Reviewer', email: null }],
    });

    renderView();

    openApprovalsModal();

    expect(screen.getByText('Design Prototype Review')).toBeInTheDocument();
  });

  it('does not show "approved on the design doc" text in the modal', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    openApprovalsModal();

    expect(screen.queryByText('approved on the design doc')).not.toBeInTheDocument();
  });
});
