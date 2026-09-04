/**
 * Tests for design-doc validation override UX in DesignDocReviewView.
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesignDocReviewView } from '../DesignDocReviewView';

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
const mockOverrideMutateAsync = jest.fn().mockResolvedValue({});
const mockUseOverrideDesignDocValidation = jest.fn(() => ({
  mutateAsync: mockOverrideMutateAsync,
  isPending: false,
}));

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
  useDismissDesignDocFixSession: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRevertDesignDocSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixDesignDocWithAi: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixDesignDocCommentWithAi: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReassignApprovers: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDocumentAssignments: jest.fn(() => ({ data: [] })),
  useDesignDocOwnerApproval: jest.fn(() => ({ data: null })),
  useDesignDocOwnerApprove: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRetryGenerateDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useOverrideDesignDocValidation: () => mockUseOverrideDesignDocValidation(),
  useApplyProposedDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useRejectProposedDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
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
  unwrapCommentMarks: jest.fn(),
}));
jest.mock('../FixValidationPanel', () => ({
  FixValidationPanel: () => null,
  FixingProgressView: () => null,
}));
jest.mock('../ProposedDesignDocChangesReview', () => ({ ProposedDesignDocChangesReview: () => null }));
jest.mock('../ApexFixRunningBanner', () => ({ ApexFixRunningBanner: () => null }));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));

const lowScoreDoc = {
  id: 'doc-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  status: 'draft',
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
  validationScore: 40,
  validationScoreThreshold: 90,
  validationScorecard: { features: [] },
  validationOverride: null,
  reviewerId: null,
  reviewerName: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/design-doc/doc-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<DesignDocReviewView />, { wrapper: Wrapper });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOverrideMutateAsync.mockResolvedValue({});
  mockUseOverrideDesignDocValidation.mockReturnValue({
    mutateAsync: mockOverrideMutateAsync,
    isPending: false,
  });
  mockUseAppShell.mockReturnValue({
    can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
    userId: 'user-author',
    isAdmin: false,
    groups: [],
  });
  mockUseDesignDoc.mockReturnValue({ data: lowScoreDoc, isLoading: false, isError: false });
});

describe('Design doc validation override UX', () => {
  it('shows Proceed anyway when score is below threshold', () => {
    renderView();
    expect(screen.getByRole('button', { name: 'Proceed anyway' })).toBeInTheDocument();
  });

  it('opens the reason modal and submits a validation override', async () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Proceed anyway' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Accepted score risk' } });
    fireEvent.click(dialog.querySelector('button[type="submit"]')!);

    await waitFor(() => {
      expect(mockOverrideMutateAsync).toHaveBeenCalledWith({
        designDocId: 'doc-1',
        reason: 'Accepted score risk',
      });
    });
  });

  it('renders override audit copy and hides Proceed anyway after override', () => {
    mockUseDesignDoc.mockReturnValue({
      data: {
        ...lowScoreDoc,
        validationOverride: {
          reason: 'Accepted score risk',
          userId: 'user-author',
          userDisplayName: 'Alice Author',
          at: '2026-07-01T00:00:00.000Z',
          validationScore: 40,
          validationThreshold: 90,
          history: [{
            reason: 'Accepted score risk',
            userId: 'user-author',
            userDisplayName: 'Alice Author',
            at: '2026-07-01T00:00:00.000Z',
            summary: 'Overrode validation score 40% (threshold 90%)',
          }],
        },
      },
      isLoading: false,
      isError: false,
    });

    renderView();

    expect(screen.getByText(/authorized override allows review to proceed/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /override audit/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Proceed anyway' })).not.toBeInTheDocument();
  });
});
