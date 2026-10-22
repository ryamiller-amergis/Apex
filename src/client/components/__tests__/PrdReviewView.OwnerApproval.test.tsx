/**
 * Tests for the two-stage owner approval feature in PrdReviewView.
 *
 * Coverage:
 *  1. "Approve as Owner" button shown when status=pending_review and user is owner
 *  2. "Request Revision" is not shown (comments drive revision_requested)
 *  3. "Pending Review" label shown when status=pending_review and user is NOT owner
 *  4. Owner approval buttons hidden in other statuses
 *  5. Approvals modal opens and shows groups
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
const mockUseProjectSkillConfig = jest.fn();

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
  useOverridePrdReadiness: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useForceSubmitPrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRevertPrdSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDismissPrdFixSession: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
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
  useProjectSkillConfig: (...args: unknown[]) => mockUseProjectSkillConfig(...args),
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

const mockUseWorkflowEvaluationAccess = jest.fn();
jest.mock('../../hooks/useWorkflowEvaluationAccess', () => ({
  useWorkflowEvaluationAccess: (...args: unknown[]) => mockUseWorkflowEvaluationAccess(...args),
}));
const mockUseWorkflowEvaluationEvents = jest.fn();
jest.mock('../../hooks/useWorkflowEvaluations', () => ({
  useWorkflowEvaluationEvents: (...args: unknown[]) => mockUseWorkflowEvaluationEvents(...args),
}));
jest.mock('../PrdQualityFeedbackPrompt', () => ({ __esModule: true, default: () => null }));
jest.mock('../PrdQualityFeedbackTab', () => ({
  __esModule: true,
  default: () => <div data-testid="prd-quality-feedback-panel" />,
}));
jest.mock('../TestCasesQualityFeedbackPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="test-cases-quality-feedback-panel" />,
}));

const NO_FEEDBACK_ACCESS = {
  flagEnabled: false,
  canView: false,
  canSubmit: false,
  canAdmin: false,
  isPlatformAdmin: false,
  ready: true,
  onRefused: jest.fn(),
};

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
  mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false, isSuperAdmin: false });
  mockUseInterview.mockReturnValue({ data: null });
  mockUseActiveUsers.mockReturnValue({ data: [] });
  mockUseDocumentAssignments.mockReturnValue({ data: [] });
  mockUseProjectSkillConfig.mockReturnValue({ data: { approvalMode: 'any_one' } });
  mockUseWorkflowEvaluationAccess.mockReturnValue(NO_FEEDBACK_ACCESS);
  mockUseWorkflowEvaluationEvents.mockReturnValue({ data: undefined, isError: false });
});

describe('QA feedback before QA approval', () => {
  const READY_TEST_CASES = { id: 'tc-1', prdId: 'prd-1', status: 'ready', updatedAt: '2026-01-03T00:00:00Z' };

  function qaUser(
    userId: string,
    interview: Record<string, unknown>,
    shell: Record<string, unknown> = {},
  ) {
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, latestTestCase: READY_TEST_CASES },
      isLoading: false,
      isError: false,
    });
    mockUseAppShell.mockReturnValue({
      can: () => true,
      userId,
      isAdmin: false,
      isSuperAdmin: false,
      selectedProject: 'proj-alpha',
      ...shell,
    });
    mockUseInterview.mockReturnValue({ data: { id: 'interview-1', ...interview } });
    mockUseWorkflowEvaluationAccess.mockReturnValue({
      ...NO_FEEDBACK_ACCESS,
      flagEnabled: true,
      canView: true,
      canSubmit: true,
    });
  }

  function testCaseFeedback(response: { data?: unknown; isError: boolean }) {
    mockUseWorkflowEvaluationEvents.mockImplementation((args: { subjectType: string }) =>
      args.subjectType === 'test_cases' ? response : { data: undefined, isError: false });
  }

  function eventsFrom(userId: string, artifactContentHash = 'current-hash') {
    return {
      data: {
        events: [{ reviewerUserId: userId, reviewerRoleKey: 'qa', artifactContentHash }],
        truncated: false,
        currentArtifactHash: 'current-hash',
      },
      isError: false,
    };
  }

  const NO_EVENTS = { data: { events: [], truncated: false, currentArtifactHash: 'current-hash' }, isError: false };

  it('locks Approve QA until the QA approver rates the current test cases, and opens their feedback first', async () => {
    qaUser('qa-user', { testCaseApproverIds: ['qa-user'] });
    testCaseFeedback(NO_EVENTS);

    renderView();

    expect(screen.getByTestId('approve-qa-btn')).toBeDisabled();
    expect(mockUseWorkflowEvaluationEvents).toHaveBeenCalledWith(expect.objectContaining({
      subjectType: 'test_cases',
      subjectId: 'tc-1',
      stageKey: 'test_cases_human_review',
      enabled: true,
    }));
    fireEvent.click(screen.getByTestId('qa-approve-open-feedback'));
    const testCasePanel = await screen.findByTestId('test-cases-quality-feedback-panel');
    const prdPanel = screen.getByTestId('prd-quality-feedback-panel');
    expect(testCasePanel.compareDocumentPosition(prdPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('unlocks Approve QA once the approver has feedback on the current test cases', () => {
    qaUser('qa-user', { testCaseApproverIds: ['qa-user'] });
    testCaseFeedback(eventsFrom('qa-user'));

    renderView();

    expect(screen.getByTestId('approve-qa-btn')).toBeEnabled();
    expect(screen.queryByTestId('qa-approve-feedback-reason')).not.toBeInTheDocument();
  });

  it('keeps Approve QA locked when the feedback was for older test cases or from someone else', () => {
    qaUser('qa-user', { testCaseApproverIds: ['qa-user'] });
    testCaseFeedback({
      data: {
        events: [
          { reviewerUserId: 'qa-user', reviewerRoleKey: 'qa', artifactContentHash: 'older-hash' },
          { reviewerUserId: 'someone-else', reviewerRoleKey: 'qa', artifactContentHash: 'current-hash' },
        ],
        truncated: false,
        currentArtifactHash: 'current-hash',
      },
      isError: false,
    });

    renderView();

    expect(screen.getByTestId('approve-qa-btn')).toBeDisabled();
  });

  it('shows the feedback reason on Approve QA as Owner until the test-case owner rates the test cases', () => {
    qaUser('qa-owner', { testCaseOwnerId: 'qa-owner' });
    testCaseFeedback(NO_EVENTS);
    const { unmount } = renderView();

    expect(screen.getByTestId('approve-qa-owner-btn')).toBeDisabled();
    expect(screen.getByTestId('qa-owner-approve-feedback-reason')).toBeInTheDocument();
    unmount();

    testCaseFeedback(eventsFrom('qa-owner'));
    renderView();
    expect(screen.queryByTestId('qa-owner-approve-feedback-reason')).not.toBeInTheDocument();
  });

  it('does not lock when the lookup fails, for super admins, or before the test cases are ready', () => {
    qaUser('qa-user', { testCaseApproverIds: ['qa-user'] });
    testCaseFeedback({ data: undefined, isError: true });
    const first = renderView();
    expect(screen.getByTestId('approve-qa-btn')).toBeEnabled();
    first.unmount();

    qaUser('qa-user', { testCaseApproverIds: ['qa-user'] }, { isSuperAdmin: true });
    testCaseFeedback(NO_EVENTS);
    const second = renderView();
    expect(screen.queryByTestId('qa-approve-feedback-reason')).not.toBeInTheDocument();
    second.unmount();

    qaUser('qa-user', { testCaseApproverIds: ['qa-user'] });
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, latestTestCase: { ...READY_TEST_CASES, status: 'generating' } },
      isLoading: false,
      isError: false,
    });
    testCaseFeedback(NO_EVENTS);
    renderView();
    expect(screen.getByTestId('approve-qa-btn')).toBeEnabled();
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Owner Approval in PrdReviewView', () => {
  it('shows "Approve as Owner" button when status=pending_review and user is owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    expect(screen.getByText('Approve as Owner')).toBeInTheDocument();
    expect(screen.queryByText('Request Revision')).not.toBeInTheDocument();
  });

  it('PBI-006 AC-3 does not treat Project Admin as an owner-only approval bypass', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'admin-user', isAdmin: true, isSuperAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    const approve = screen.getByRole('button', { name: 'Approve as Owner' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-describedby', 'owner-approve-disabled-reason');
    expect(screen.getByTestId('owner-approve-disabled-reason')).toHaveTextContent(
      'Only the document owner or a Platform Admin can approve',
    );
  });

  it('PBI-006 AC-2 lets the author approve an owner-only PRD with no explicit section owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-author', isAdmin: false, isSuperAdmin: false });
    mockUsePrd.mockReturnValue({
      data: { ...basePrd, ownerId: null, ownerName: null },
      isLoading: false,
      isError: false,
    });
    mockUseDocumentAssignments.mockReturnValue({ data: [] });

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeEnabled();
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
    expect(screen.queryByText('Request Revision')).not.toBeInTheDocument();
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
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'admin-user', isAdmin: true, isSuperAdmin: true });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseDocumentAssignments.mockImplementation((_id: unknown, documentType: unknown) =>
      documentType === 'prd'
        ? { data: [{ approverUserId: 'user-rev-1', approverDisplayName: 'Rev One', status: 'pending' }] }
        : { data: [] },
    );

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).not.toBeDisabled();
  });

  it('PBI-006 uses the assignment snapshot, not the current interview reviewer list, for owner-only approval', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });
    mockUseDocumentAssignments.mockReturnValue({ data: [] });
    mockUseInterview.mockReturnValue({
      data: { id: 'interview-1', prdApproverIds: ['reviewer-1', 'reviewer-2'] },
    });

    renderView();

    const approveButton = screen.getByRole('button', { name: 'Approve as Owner' });
    expect(approveButton).toBeEnabled();
  });

  it('does not enable one-step owner approval when assignment loading fails', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUseDocumentAssignments.mockImplementation((_id: unknown, documentType: unknown) =>
      documentType === 'prd'
        ? { data: [], isLoading: false, isError: true }
        : { data: [], isLoading: false, isError: false },
    );

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeDisabled();
  });

  it('uses the PRD approval mode instead of the legacy project-wide mode', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false });
    mockUseProjectSkillConfig.mockReturnValue({
      data: {
        approvalMode: 'any_one',
        approvalModes: { prd: 'all_required' },
      },
    });
    mockUseDocumentAssignments.mockImplementation((_id: unknown, documentType: unknown) =>
      documentType === 'prd'
        ? {
            data: [
              { approverUserId: 'reviewer-1', status: 'approved' },
              { approverUserId: 'reviewer-2', status: 'pending' },
            ],
            isLoading: false,
            isError: false,
          }
        : { data: [], isLoading: false, isError: false },
    );

    renderView();

    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeDisabled();
  });

  it('shows owner-only QA approval only to the test-case owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'qa-owner', isAdmin: false, isSuperAdmin: false });
    mockUseInterview.mockReturnValue({
      data: { id: 'interview-1', testCaseOwnerId: 'qa-owner' },
    });

    renderView();

    expect(screen.getByTestId('approve-qa-owner-btn')).toBeInTheDocument();
  });

  it('does not show owner-only QA approval to the PRD owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-owner', isAdmin: false, isSuperAdmin: false });
    mockUseInterview.mockReturnValue({
      data: { id: 'interview-1', testCaseOwnerId: 'qa-owner' },
    });

    renderView();

    expect(screen.queryByTestId('approve-qa-owner-btn')).not.toBeInTheDocument();
  });

  it('shows "Pending Review" label when status=pending_review and user is NOT owner', () => {
    mockUseAppShell.mockReturnValue({ can: () => true, userId: 'user-viewer', isAdmin: false });
    mockUsePrd.mockReturnValue({ data: basePrd, isLoading: false, isError: false });

    renderView();

    const matches = screen.getAllByText('Pending Review');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Approve as Owner' })).toBeDisabled();
    expect(screen.getByTestId('owner-approve-disabled-reason')).toBeInTheDocument();
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
