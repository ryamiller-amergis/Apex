/**
 * Tests for the Owner / Reviewer(s) meta row in the PRD review header.
 *
 * Coverage:
 *  1. Owner display — uses ownerName, falls back to ownerId, authorName, authorId
 *  2. Reviewer(s) display — shows comma-separated approver names when assignments exist
 *  3. Reviewer(s) label is hidden when there are no assignments
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdReviewView } from '../PrdReviewView';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/backlog/prd/prd-1' }),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(() => ({
    can: () => false,
    userId: 'user-viewer',
    isAdmin: false,
  })),
}));

const mockUsePrd = jest.fn();
const mockUseDocumentAssignments = jest.fn();

jest.mock('../../hooks/useInterviews', () => ({
  usePrd: (...args: unknown[]) => mockUsePrd(...args),
  useInterview: jest.fn(() => ({ data: null })),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useUpdatePrdContent: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSubmitPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useWithdrawPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReopenPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReviewPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeletePrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useCreatePrdAdoItems: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSyncPrdAdoStatus: jest.fn(() => ({ data: null })),
  useReassignApprovers: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDocumentAssignments: (...args: unknown[]) => mockUseDocumentAssignments(...args),
  useDesignDocsByPrdId: jest.fn(() => ({ data: [] })),
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
  mockUseDocumentAssignments.mockReturnValue({ data: [] });
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

// ── 2. Reviewer(s) display ────────────────────────────────────────────────────

describe('Reviewer(s) display in header', () => {
  it('shows the "Reviewer(s):" label when assignments are present', () => {
    mockUseDocumentAssignments.mockReturnValue({
      data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Carol Reviewer', status: 'pending' }],
    });

    renderView();

    expect(screen.getByText('Reviewer(s):')).toBeInTheDocument();
  });

  it('shows the approver display name when available', () => {
    mockUseDocumentAssignments.mockReturnValue({
      data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Carol Reviewer', status: 'pending' }],
    });

    renderView();

    expect(screen.getByText('Carol Reviewer')).toBeInTheDocument();
  });

  it('falls back to approverUserId when display name is missing', () => {
    mockUseDocumentAssignments.mockReturnValue({
      data: [{ approverUserId: 'user-rev-fallback', approverDisplayName: null, status: 'pending' }],
    });

    renderView();

    expect(screen.getByText('user-rev-fallback')).toBeInTheDocument();
  });

  it('renders multiple reviewers as a comma-separated list', () => {
    mockUseDocumentAssignments.mockReturnValue({
      data: [
        { approverUserId: 'u1', approverDisplayName: 'Alice', status: 'pending' },
        { approverUserId: 'u2', approverDisplayName: 'Bob', status: 'pending' },
        { approverUserId: 'u3', approverDisplayName: 'Carol', status: 'approved' },
      ],
    });

    renderView();

    expect(screen.getByText('Alice, Bob, Carol')).toBeInTheDocument();
  });

  it('hides "Reviewer(s):" label when there are no assignments', () => {
    mockUseDocumentAssignments.mockReturnValue({ data: [] });

    renderView();

    expect(screen.queryByText('Reviewer(s):')).not.toBeInTheDocument();
  });

  it('hides "Reviewer(s):" when assignments data is undefined', () => {
    mockUseDocumentAssignments.mockReturnValue({ data: undefined });

    renderView();

    expect(screen.queryByText('Reviewer(s):')).not.toBeInTheDocument();
  });
});
