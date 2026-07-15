/**
 * Tests for the two-stage owner approval feature in DesignDocReviewView.
 *
 * Coverage:
 *  1. "Approve as Owner" shown when status=reviewer_approved and user is owner
 *  2. Reviewer "Approve" shown when status=pending_review (not owner-only stage)
 *  3. Owner approval UI hidden in draft / pending_review statuses
 */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesignDocReviewView } from '../DesignDocReviewView';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/backlog/design-doc/doc-1' }),
}));

const mockUseAppShell = jest.fn();
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: (...args: unknown[]) => mockUseAppShell(...args),
}));

const mockUseDesignDoc = jest.fn();
const mockUseDesignDocOwnerApprove = jest.fn();
const mockUseDocumentAssignments = jest.fn();

jest.mock('../../hooks/useInterviews', () => ({
  useDesignDoc: (...args: unknown[]) => mockUseDesignDoc(...args),
  usePrd: jest.fn(() => ({ data: null })),
  useUpdateDesignDocContent: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useSubmitDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useWithdrawDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReviewDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeleteDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useGenerateDesignDoc: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useMarkValidationReady: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRefreshValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCancelValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreateValidationThread: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useValidationReport: jest.fn(() => ({ data: null })),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useFixValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useAcceptFixValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRevertDesignDocSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixDesignDocWithAi: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixDesignDocCommentWithAi: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReassignApprovers: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDocumentAssignments: (...args: unknown[]) => mockUseDocumentAssignments(...args),
  useDesignDocOwnerApproval: jest.fn(() => ({ data: null })),
  useDesignDocOwnerApprove: (...args: unknown[]) => mockUseDesignDocOwnerApprove(...args),
  useRetryGenerateDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: jest.fn(() => ({
    messages: [],
    streamingText: '',
    status: 'idle',
    isConnected: true,
    prdReady: false,
    backlogReady: false,
  })),
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
jest.mock('mermaid', () => ({ initialize: jest.fn(), run: jest.fn() }));
jest.mock('../ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
jest.mock('../ApproverSelectModal', () => ({ ApproverSelectModal: () => null }));
jest.mock('../AnnotationLayer', () => ({
  AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../FixValidationPanel', () => ({
  FixValidationPanel: () => null,
  FixingProgressView: () => null,
}));

// ── Base fixtures ──────────────────────────────────────────────────────────────

const baseDoc = {
  id: 'doc-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  status: 'reviewer_approved',
  authorId: 'user-author',
  authorName: 'Alice Author',
  ownerId: 'user-owner',
  ownerName: 'Bob Owner',
  chatThreadId: 'thread-gen',
  qaChatThreadId: null,
  docAssistantThreadId: null,
  designContent: '# Design\nContent.',
  techSpecContent: '# Tech Spec\nContent.',
  assumptionsContent: '# Assumptions\nContent.',
  reviewerId: 'user-reviewer',
  reviewerName: 'Carol Reviewer',
  reviewComment: null,
  reviewedAt: '2026-01-03T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

// ── Render helper ──────────────────────────────────────────────────────────────

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/design-doc/doc-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<DesignDocReviewView />, { wrapper: Wrapper });
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUseDesignDoc.mockReturnValue({ data: baseDoc, isLoading: false, isError: false });
  mockUseDesignDocOwnerApprove.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
  mockUseAppShell.mockReturnValue({
    can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
    userId: 'user-viewer',
    isAdmin: false,
    groups: [],
  });
  mockUseDocumentAssignments.mockReturnValue({
    data: [{ approverUserId: 'user-reviewer', approverDisplayName: 'Carol Reviewer', status: 'approved' }],
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Owner Approval in DesignDocReviewView', () => {
  it('shows "Approve as Owner" when status=reviewer_approved and user is owner', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
      userId: 'user-owner',
      isAdmin: false,
      groups: [],
    });

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeInTheDocument();
  });

  it('shows "Approve as Owner" for admin even when not owner', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
      userId: 'admin-user',
      isAdmin: true,
      groups: [],
    });

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeInTheDocument();
  });

  it('does not show owner approval UI when status is pending_review', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
      userId: 'user-owner',
      isAdmin: false,
      groups: [],
    });
    mockUseDesignDoc.mockReturnValue({
      data: { ...baseDoc, status: 'pending_review', reviewerId: null, reviewerName: null },
      isLoading: false,
      isError: false,
    });

    renderView();

    expect(screen.queryByRole('button', { name: 'Approve as Owner' })).not.toBeInTheDocument();
  });

  it('shows reviewer Approve button during pending_review (first stage)', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
      userId: 'user-reviewer',
      isAdmin: false,
      groups: [],
    });
    mockUseDesignDoc.mockReturnValue({
      data: { ...baseDoc, status: 'pending_review', reviewerId: null, reviewerName: null },
      isLoading: false,
      isError: false,
    });
    mockUseDocumentAssignments.mockReturnValue({
      data: [{ approverUserId: 'user-reviewer', approverDisplayName: 'Carol Reviewer', status: 'pending' }],
    });

    renderView();

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve as Owner' })).not.toBeInTheDocument();
  });

  it('does not show owner approval UI when status is draft', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
      userId: 'user-owner',
      isAdmin: false,
      groups: [],
    });
    mockUseDesignDoc.mockReturnValue({
      data: { ...baseDoc, status: 'draft' },
      isLoading: false,
      isError: false,
    });

    renderView();

    expect(screen.queryByRole('button', { name: 'Approve as Owner' })).not.toBeInTheDocument();
  });

  it('hides owner approval from non-owner viewers at reviewer_approved', () => {
    mockUseAppShell.mockReturnValue({
      can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
      userId: 'user-viewer',
      isAdmin: false,
      groups: [],
    });

    renderView();

    expect(screen.queryByRole('button', { name: 'Approve as Owner' })).not.toBeInTheDocument();
  });
});
