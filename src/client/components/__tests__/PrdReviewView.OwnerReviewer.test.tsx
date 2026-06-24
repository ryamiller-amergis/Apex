/**
 * Tests for the Owner / Reviewer approval checklist in the PRD review header.
 *
 * Coverage:
 *  1. Owner display — uses ownerName, falls back to ownerId, authorName, authorId
 *  2. Reviewer approval checklist — shows grouped reviewer names with status indicators
 *  3. Checklist is hidden when there are no assignments
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
const mockUseDocumentAssignments = jest.fn();
const mockUseInterview = jest.fn();
const mockUseActiveUsers = jest.fn();
const mockSubmitPrdMutateAsync = jest.fn();

jest.mock('../../hooks/useInterviews', () => ({
  usePrd: (...args: unknown[]) => mockUsePrd(...args),
  usePrdTestCases: jest.fn(() => ({ data: null })),
  useInterview: (...args: unknown[]) => mockUseInterview(...args),
  useActiveUsers: (...args: unknown[]) => mockUseActiveUsers(...args),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useUpdatePrdContent: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useUpdatePrdBacklog: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSubmitPrd: jest.fn(() => ({ mutateAsync: mockSubmitPrdMutateAsync, isPending: false })),
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
  useDesignDocsByPrdId: jest.fn(() => ({ data: [] })),
  useGenerateTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreateDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useOwnerApprove: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useOwnerApproval: jest.fn(() => ({ data: null })),
  useReviewTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
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
jest.mock('../CreateAdoItemsModal', () => ({ CreateAdoItemsModal: () => null }));
jest.mock('../ReviewerApprovalChecklist', () => ({
  ReviewerApprovalChecklist: ({ groups }: { groups: { label: string; rows: { name: string; status: string }[] }[] }) => (
    <div data-testid="reviewer-approval-checklist">
      {groups.map((g) => (
        <div key={g.label}>
          <span>{g.label}</span>
          {g.rows.map((r) => (
            <span key={r.name} data-status={r.status}>{r.name}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

// ── Base fixtures ──────────────────────────────────────────────────────────────

const basePrd = {
  id: 'prd-1',
  interviewId: 'interview-1',
  project: 'proj-alpha',
  title: 'Feature PRD',
  content: '# PRD\nContent here.',
  backlogJson: null,
  status: 'draft',
  authorId: 'user-author',
  authorName: 'Alice Author',
  ownerId: undefined as string | undefined,
  ownerName: undefined as string | undefined,
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

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
  mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
    if (documentType === 'prd') return { data: [] };
    return { data: [] };
  });
  mockUseInterview.mockReturnValue({ data: null });
  mockUseActiveUsers.mockReturnValue({ data: [] });
  mockUseAppShell.mockReturnValue({
    can: () => false,
    userId: 'user-viewer',
    isAdmin: false,
  });
  mockSubmitPrdMutateAsync.mockResolvedValue(undefined);
});

// ── 1. Owner display ──────────────────────────────────────────────────────────

describe('Owner display in header', () => {
  it('shows ownerName when it is available', () => {
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, ownerId: 'user-owner', ownerName: 'Bob Owner' },
      isLoading: false, isError: false,
    });

    renderView();

    expect(screen.getByText('Owner:')).toBeInTheDocument();
    expect(screen.getByText('Bob Owner')).toBeInTheDocument();
  });

  it('falls back to ownerId when ownerName is missing', () => {
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, ownerId: 'user-owner-id', ownerName: undefined },
      isLoading: false, isError: false,
    });

    renderView();

    expect(screen.getByText('user-owner-id')).toBeInTheDocument();
  });

  it('falls back to authorName when no owner fields are set', () => {
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, ownerId: undefined, ownerName: undefined, authorName: 'Alice Author' },
      isLoading: false, isError: false,
    });

    renderView();

    expect(screen.getByText('Alice Author')).toBeInTheDocument();
  });

  it('falls back to authorId as a last resort when no display names exist', () => {
    mockUsePrd.mockReturnValue({
      data: {
        ...basePrd,
        ownerId: undefined,
        ownerName: undefined,
        authorName: undefined,
        authorId: 'user-fallback-id',
      },
      isLoading: false, isError: false,
    });

    renderView();

    expect(screen.getByText('user-fallback-id')).toBeInTheDocument();
  });

  it('always renders the "Owner:" label', () => {
    renderView();
    expect(screen.getByText('Owner:')).toBeInTheDocument();
  });
});

describe('Submit for review', () => {
  it('uses the reviewer selections already captured on the source interview', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage',
      userId: 'user-author',
      isAdmin: false,
    });
    mockUsePrd.mockReturnValue({
      data: {
        ...basePrd,
        backlogJson: { epics: [] },
        latestTestCase: {
          id: 'test-case-1',
          prdId: 'prd-1',
          chatThreadId: null,
          status: 'ready',
          validationStatus: 'not_available',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
      isLoading: false,
      isError: false,
    });
    mockUseInterview.mockReturnValue({
      data: {
        id: 'interview-1',
        title: 'Kickoff Interview',
        prdApproverIds: ['prd-reviewer'],
        designDocApproverIds: ['design-doc-reviewer'],
        designPrototypeApproverIds: ['prototype-reviewer'],
        testCaseApproverIds: ['qa-reviewer'],
      },
    });

    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Submit for Review/i }));

    expect(mockSubmitPrdMutateAsync).toHaveBeenCalledWith({
      prdId: 'prd-1',
      prdApproverIds: ['prd-reviewer'],
      designDocApproverIds: ['design-doc-reviewer'],
      designPrototypeApproverIds: ['prototype-reviewer'],
      qaApproverIds: ['qa-reviewer'],
    });
  });
});

// ── 2. Reviewer approval checklist (inside Approvals modal) ─────────────────

function openApprovalsModal() {
  fireEvent.click(screen.getByRole('button', { name: /More actions/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Approvals/i }));
}

describe('Reviewer approval checklist in Approvals modal', () => {
  it('shows "PRD Review" group with reviewer names when assignments are present', () => {
    mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
      if (documentType === 'prd') {
        return { data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Carol Reviewer', status: 'pending' }] };
      }
      return { data: [] };
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByTestId('reviewer-approval-checklist')).toBeInTheDocument();
    expect(screen.getByText('PRD Review')).toBeInTheDocument();
    expect(screen.getByText('Carol Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Owner:')).toBeInTheDocument();
  });

  it('shows the approver display name when available', () => {
    mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
      if (documentType === 'prd') {
        return { data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Carol Reviewer', status: 'pending' }] };
      }
      return { data: [] };
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByText('Carol Reviewer')).toBeInTheDocument();
  });

  it('falls back to approverUserId when display name is missing', () => {
    mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
      if (documentType === 'prd') {
        return { data: [{ approverUserId: 'user-rev-fallback', approverDisplayName: null, status: 'pending' }] };
      }
      return { data: [] };
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByText('user-rev-fallback')).toBeInTheDocument();
  });

  it('renders multiple approvers as individual rows', () => {
    mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
      if (documentType === 'prd') {
        return {
          data: [
            { approverUserId: 'u1', approverDisplayName: 'Alice', status: 'pending' },
            { approverUserId: 'u2', approverDisplayName: 'Bob', status: 'pending' },
            { approverUserId: 'u3', approverDisplayName: 'Carol', status: 'approved' },
          ],
        };
      }
      return { data: [] };
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
  });

  it('shows approved status on reviewers that have approved', () => {
    mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
      if (documentType === 'prd') {
        return {
          data: [
            { approverUserId: 'u1', approverDisplayName: 'Alice', status: 'approved', respondedAt: '2026-06-20T12:00:00Z' },
            { approverUserId: 'u2', approverDisplayName: 'Bob', status: 'pending' },
          ],
        };
      }
      return { data: [] };
    });

    renderView();
    openApprovalsModal();

    const aliceEl = screen.getByText('Alice');
    expect(aliceEl).toHaveAttribute('data-status', 'approved');
    const bobEl = screen.getByText('Bob');
    expect(bobEl).toHaveAttribute('data-status', 'pending');
  });

  it('shows kick-off interview reviewers when document assignments are empty', () => {
    mockUseInterview.mockReturnValue({
      data: {
        id: 'interview-1',
        prdApproverIds: ['user-rev-1', 'user-rev-2'],
      },
    });
    mockUseActiveUsers.mockReturnValue({
      data: [
        { oid: 'user-rev-1', displayName: 'Carol Reviewer', email: null },
        { oid: 'user-rev-2', displayName: 'Dan Reviewer', email: null },
      ],
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByText('PRD Review')).toBeInTheDocument();
    expect(screen.getByText('Carol Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Dan Reviewer')).toBeInTheDocument();
  });

  it('prefers document assignments over interview kick-off reviewers', () => {
    mockUseDocumentAssignments.mockImplementation((_id, documentType) => {
      if (documentType === 'prd') {
        return { data: [{ approverUserId: 'u1', approverDisplayName: 'Assigned Alice', status: 'pending' }] };
      }
      return { data: [] };
    });
    mockUseInterview.mockReturnValue({
      data: { id: 'interview-1', prdApproverIds: ['user-kickoff'] },
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByText('Assigned Alice')).toBeInTheDocument();
    expect(screen.queryByText('user-kickoff')).not.toBeInTheDocument();
  });

  it('hides the Approvals menu item when there are no assignments or kick-off reviewers', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage',
      userId: 'user-author',
      isAdmin: false,
    });

    renderView();

    fireEvent.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Approvals/i })).not.toBeInTheDocument();
  });

  it('hides the Approvals menu item when assignments data is undefined', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage',
      userId: 'user-author',
      isAdmin: false,
    });
    mockUseDocumentAssignments.mockReturnValue({ data: undefined });

    renderView();

    fireEvent.click(screen.getByRole('button', { name: /More actions/i }));
    expect(screen.queryByRole('menuitem', { name: /Approvals/i })).not.toBeInTheDocument();
  });

  it('shows Owner Approval group when PRD is pending_review', () => {
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, status: 'pending_review', ownerName: 'Bob Owner' },
      isLoading: false, isError: false,
    });
    mockUseDocumentAssignments.mockReturnValue({
      data: [{ approverUserId: 'u1', approverDisplayName: 'Alice', status: 'pending' }],
    });

    renderView();
    openApprovalsModal();

    expect(screen.getByText('Owner Approval')).toBeInTheDocument();
    expect(screen.getAllByText('Bob Owner').length).toBeGreaterThanOrEqual(1);
  });
});
