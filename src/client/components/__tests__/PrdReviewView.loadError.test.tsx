/**
 * Tests for how PrdReviewView handles a failed PRD request.
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdReviewView } from '../PrdReviewView';
import { ApiFetchError } from '../../utils/apiFetch';

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

jest.mock('../../hooks/useInterviews', () => ({
  usePrd: (...args: unknown[]) => mockUsePrd(...args),
  usePrdTestCases: jest.fn(() => ({ data: null })),
  useInterview: jest.fn(() => ({ data: null })),
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
  useApplyProposedPrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useRejectProposedPrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useCreatePrdValidationThread: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCancelPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRefreshPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useAcceptFixPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixPrdCoverage: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useAcceptFixPrdCoverage: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useOverridePrdReadiness: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useForceSubmitPrd: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRevertPrdSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDismissPrdFixSession: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useScreenInventoryRoutes: jest.fn(() => ({ data: [] })),
  usePrdValidationReport: jest.fn(() => ({ data: null })),
  useDocumentAssignments: jest.fn(() => ({ data: [] })),
  useReviewTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDesignDocsByPrdId: jest.fn(() => ({ data: [] })),
  useGenerateTestCases: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRecalculateTestCaseCoverage: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreateDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useOwnerApprove: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useOwnerApproval: jest.fn(() => ({ data: null })),
  useActiveUsers: jest.fn(() => ({ data: [] })),
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

jest.mock('../../hooks/useDesignPrototypes', () => ({
  usePrototypesForPrd: jest.fn(() => ({ data: [] })),
  useGeneratePrototypesForPrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

jest.mock('../../hooks/useDesignPlan', () => ({
  useDesignPlan: jest.fn(() => ({ data: null })),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../hooks/useGroundingResumeGate', () => ({
  useGroundingResumeGate: () => ({
    composerBlocked: false,
    showCard: false,
    status: null,
    continueOnPin: jest.fn(),
    updateToLatest: jest.fn(),
    isUpdating: false,
    error: null,
  }),
}));
jest.mock('../ConfirmDeleteModal', () => ({ ConfirmDeleteModal: () => null }));
jest.mock('../ApproverSelectModal', () => ({ ApproverSelectModal: () => null }));
jest.mock('../AnnotationLayer', () => ({
  AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../BacklogViewer', () => ({ BacklogViewer: () => null }));
jest.mock('../ReviewerApprovalChecklist', () => ({ ReviewerApprovalChecklist: () => null }));
jest.mock('../CreateAdoItemsModal', () => ({ CreateAdoItemsModal: () => null }));
jest.mock('../ProposedChangesReview', () => ({ ProposedChangesReview: () => null }));
jest.mock('../ApexFixRunningBanner', () => ({ ApexFixRunningBanner: () => null }));
jest.mock('../PrdFixActionStrip', () => ({ PrdFixActionStrip: () => null }));

const generatingPrd = {
  id: 'prd-1',
  interviewId: 'interview-1',
  project: 'proj-alpha',
  title: 'Feature PRD',
  content: '',
  backlogJson: null,
  status: 'generating',
  authorId: 'user-author',
  ownerId: 'user-owner',
  reviewerId: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  testCasesRequired: false,
  prdValidationEnabled: false,
};

const mockRefetch = jest.fn();

function prdQuery(overrides: Record<string, unknown>) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: mockRefetch,
    ...overrides,
  };
}

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/prd/prd-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<PrdReviewView />, { wrapper: Wrapper });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-author', isAdmin: false });
});

describe('PrdReviewView load errors', () => {
  it('keeps showing a cached PRD when the latest refetch failed', () => {
    mockUsePrd.mockReturnValue(prdQuery({
      data: generatingPrd,
      isError: true,
      error: new ApiFetchError('Bad gateway', 502),
    }));

    renderView();

    expect(screen.getByTestId('prd-review')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Feature PRD' })).toBeInTheDocument();
    expect(screen.getByTestId('prd-reconnecting-hint')).toHaveTextContent('Reconnecting…');
    expect(screen.queryByText('PRD not found.')).not.toBeInTheDocument();
  });

  it('shows no reconnecting hint when the latest fetch succeeded', () => {
    mockUsePrd.mockReturnValue(prdQuery({ data: generatingPrd }));

    renderView();

    expect(screen.getByRole('heading', { name: 'Feature PRD' })).toBeInTheDocument();
    expect(screen.queryByTestId('prd-reconnecting-hint')).not.toBeInTheDocument();
  });

  it('shows PRD not found for a 404 with no cached PRD', () => {
    mockUsePrd.mockReturnValue(prdQuery({
      isError: true,
      error: new ApiFetchError('PRD not found', 404),
    }));

    renderView();

    expect(screen.getByText('PRD not found.')).toBeInTheDocument();
    expect(screen.queryByTestId('prd-load-retry-btn')).not.toBeInTheDocument();
  });

  it('shows a retryable message for a 5xx with no cached PRD', () => {
    mockUsePrd.mockReturnValue(prdQuery({
      isError: true,
      error: new ApiFetchError('Service unavailable', 503),
    }));

    renderView();

    expect(screen.queryByText('PRD not found.')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this PRD.");
    fireEvent.click(screen.getByTestId('prd-load-retry-btn'));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('disables Retry while a retry is in flight', () => {
    mockUsePrd.mockReturnValue(prdQuery({
      isError: true,
      error: new ApiFetchError('Service unavailable', 503),
      isFetching: true,
    }));

    renderView();

    expect(screen.getByTestId('prd-load-retry-btn')).toBeDisabled();
    expect(screen.getByTestId('prd-load-retry-btn')).toHaveTextContent('Retrying…');
  });
});
