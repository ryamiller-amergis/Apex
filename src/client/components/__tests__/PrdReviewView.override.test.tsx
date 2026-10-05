/**
 * Tests for PRD readiness override UX in PrdReviewView.
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrdReviewView } from '../PrdReviewView';

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
const mockUsePrdTestCases = jest.fn();
const mockOverrideMutateAsync = jest.fn().mockResolvedValue({});
const mockUseOverridePrdReadiness = jest.fn(() => ({
  mutateAsync: mockOverrideMutateAsync,
  isPending: false,
}));

jest.mock('../../hooks/useInterviews', () => ({
  usePrd: (...args: unknown[]) => mockUsePrd(...args),
  usePrdTestCases: (...args: unknown[]) => mockUsePrdTestCases(...args),
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
  useFixPrdValidation: jest.fn(() => ({
    mutateAsync: jest.fn().mockResolvedValue({ threadId: 'validation-thread-1' }),
    isPending: false,
  })),
  useAcceptFixPrdValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixPrdCoverage: jest.fn(() => ({
    mutateAsync: jest.fn().mockResolvedValue({ threadId: 'coverage-thread-1' }),
    isPending: false,
  })),
  useAcceptFixPrdCoverage: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useOverridePrdReadiness: () => mockUseOverridePrdReadiness(),
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

const gapTestCases = {
  id: 'tc-1',
  prdId: 'prd-1',
  status: 'ready',
  coverageSummary: {
    totalCases: 2,
    pbisCovered: 1,
    acCovered: '1/2',
    brCovered: '1/1',
    gaps: 1,
  },
  validationStatus: 'passed',
};

const draftPrd = {
  id: 'prd-1',
  interviewId: 'interview-1',
  project: 'proj-alpha',
  title: 'Feature PRD',
  content: '# PRD\nContent here.',
  backlogJson: null,
  status: 'draft',
  authorId: 'user-author',
  ownerId: 'user-owner',
  reviewerId: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  testCasesRequired: true,
  prdValidationEnabled: false,
};

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
  mockOverrideMutateAsync.mockResolvedValue({});
  mockUseOverridePrdReadiness.mockReturnValue({
    mutateAsync: mockOverrideMutateAsync,
    isPending: false,
  });
  mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-author', isAdmin: false });
  mockUsePrd.mockReturnValue({ data: draftPrd, isLoading: false, isError: false });
  mockUsePrdTestCases.mockReturnValue({ data: gapTestCases });
});

describe('PRD readiness override UX', () => {
  it('shows Proceed anyway when coverage gaps block review', () => {
    renderView();
    expect(screen.getByRole('button', { name: 'Proceed anyway' })).toBeInTheDocument();
  });

  it('opens the reason modal and submits an override', async () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Proceed anyway' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Accepted residual AC gaps' } });
    fireEvent.click(dialog.querySelector('button[type="submit"]')!);

    await waitFor(() => {
      expect(mockOverrideMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        reason: 'Accepted residual AC gaps',
      });
    });
  });

  it('renders override audit history after an override is recorded', () => {
    mockUsePrd.mockReturnValue({
      data: {
        ...draftPrd,
        readinessOverride: {
          reason: 'Accepted residual AC gaps',
          userId: 'user-author',
          userDisplayName: 'Alice Author',
          at: '2026-07-01T00:00:00.000Z',
          states: ['coverage_gaps'],
          history: [{
            reason: 'Accepted residual AC gaps',
            userId: 'user-author',
            userDisplayName: 'Alice Author',
            at: '2026-07-01T00:00:00.000Z',
            summary: 'Overrode readiness state: coverage gaps',
          }],
        },
      },
      isLoading: false,
      isError: false,
    });

    renderView();

    expect(screen.getByRole('region', { name: 'Override audit history' })).toBeInTheDocument();
    expect(screen.getByText('Proceeding with unresolved gaps')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Proceed anyway' })).not.toBeInTheDocument();
  });
});
