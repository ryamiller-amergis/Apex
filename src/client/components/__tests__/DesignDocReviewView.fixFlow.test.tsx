/**
 * Fix-with-Apex / re-run-validation recovery paths in DesignDocReviewView.
 *
 * These cover the states that previously left the UI stuck: a fix run that
 * changed nothing, a leftover same-tab session marker, and a doc already
 * back in validation.
 */

import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DesignDocReviewView } from '../DesignDocReviewView';
import { markApexFixInProgress, readApexFixInProgress } from '../../utils/apexFixSession';

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
const mockFixMutateAsync = jest.fn();
const mockDismissMutateAsync = jest.fn();
const mockCreateValidationThreadMutateAsync = jest.fn();

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
  useCreateValidationThread: jest.fn(() => ({
    mutateAsync: mockCreateValidationThreadMutateAsync,
    isPending: false,
  })),
  useValidationReport: jest.fn(() => ({ data: null })),
  useDesignDocsByPrd: jest.fn(() => ({ data: [] })),
  useFixValidation: jest.fn(() => ({ mutateAsync: mockFixMutateAsync, isPending: false })),
  useAcceptFixValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDismissDesignDocFixSession: jest.fn(() => ({
    mutateAsync: mockDismissMutateAsync,
    isPending: false,
  })),
  useRevertDesignDocSection: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useFixDesignDocWithAi: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useFixDesignDocCommentWithAi: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useReassignApprovers: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDocumentAssignments: jest.fn(() => ({ data: [] })),
  useDesignDocOwnerApproval: jest.fn(() => ({ data: null })),
  useDesignDocOwnerApprove: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRetryGenerateDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useOverrideDesignDocValidation: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useApplyProposedDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useRejectProposedDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

const mockFetchChatThreadStatus = jest.fn();
jest.mock('../../utils/apexFixSession', () => ({
  ...jest.requireActual('../../utils/apexFixSession'),
  fetchChatThreadStatus: (...args: unknown[]) => mockFetchChatThreadStatus(...args),
  cancelChatThread: jest.fn(),
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
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../ArtifactUsageStrip', () => ({ ArtifactUsageStrip: () => null }));
jest.mock('../ProposedDesignDocChangesReview', () => ({
  ProposedDesignDocChangesReview: () => null,
}));

// Stubs that expose the pieces these tests drive.
jest.mock('../FixValidationPanel', () => ({
  FixValidationPanel: ({ onRetry }: { onRetry: () => void }) => (
    <button type="button" data-testid="retry-fix-with-apex" onClick={onRetry}>
      Retry Fix with Apex
    </button>
  ),
  FixingProgressView: () => null,
}));
jest.mock('../ApexFixRunningBanner', () => ({
  ApexFixRunningBanner: ({ title }: { title: string }) => (
    <div data-testid="apex-fix-running-banner">{title}</div>
  ),
}));

const DESIGN = '# Design\nContent.';
const TECH_SPEC = '# Tech Spec\nContent.';
const ASSUMPTIONS = '# Assumptions\nContent.';

const baseDoc = {
  id: 'doc-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  status: 'pending_review',
  authorId: 'user-author',
  authorName: 'Alice Author',
  ownerId: 'user-owner',
  ownerName: 'Bob Owner',
  chatThreadId: 'thread-gen',
  qaChatThreadId: null,
  docAssistantThreadId: 'thread-fix',
  validationThreadId: 'thread-val',
  designContent: DESIGN,
  techSpecContent: TECH_SPEC,
  assumptionsContent: ASSUMPTIONS,
  validationScore: 40,
  validationScoreThreshold: 90,
  validationScorecard: { features: [] },
  validationOverride: null,
  fixBaseline: null as unknown,
  reviewerId: null,
  reviewerName: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

/** Baseline whose content matches the doc — i.e. the fix changed nothing. */
const unchangedBaseline = {
  design: DESIGN,
  techSpec: TECH_SPEC,
  assumptions: ASSUMPTIONS,
  capturedAt: '2026-01-02T00:00:00Z',
  fixThreadId: 'thread-fix',
};

function renderView(doc: Record<string, unknown>, seedCache = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedCache) {
    queryClient.setQueryData(['design-doc', 'doc-1'], doc);
  }
  mockUseDesignDoc.mockReturnValue({ data: doc, isLoading: false, isError: false });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/backlog/design-doc/doc-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<DesignDocReviewView />, { wrapper: Wrapper });
}

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
  mockFixMutateAsync.mockResolvedValue({ threadId: 'thread-fix-2' });
  mockDismissMutateAsync.mockResolvedValue({ ok: true });
  mockCreateValidationThreadMutateAsync.mockResolvedValue({ threadId: 'thread-val-2' });
  mockFetchChatThreadStatus.mockResolvedValue({ status: 'idle' });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [] }),
  }) as unknown as typeof fetch;
  mockUseAppShell.mockReturnValue({
    can: (key: string) => key === 'interviews:manage' || key === 'design-docs:review',
    userId: 'user-author',
    isAdmin: false,
    groups: [],
  });
});

describe('a fix run that changed nothing', () => {
  it('clears the server fix session and says so instead of sticking', async () => {
    renderView({ ...baseDoc, fixBaseline: unchangedBaseline });

    await waitFor(() => expect(mockDismissMutateAsync).toHaveBeenCalledWith('doc-1'));
    expect(await screen.findByText(/No changes applied/i)).toBeInTheDocument();
  });

  it('drops the same-tab marker so the next attempt is not blocked', async () => {
    markApexFixInProgress('design-doc-validation', 'doc-1', { threadId: 'thread-fix' });

    renderView({ ...baseDoc, fixBaseline: unchangedBaseline });

    await waitFor(() =>
      expect(readApexFixInProgress('design-doc-validation', 'doc-1')).toBeNull(),
    );
  });
});

describe('a leftover session marker with no server fix session', () => {
  it('leaves Fix with Apex usable', () => {
    markApexFixInProgress('design-doc-validation', 'doc-1', { threadId: 'thread-fix' });

    renderView({ ...baseDoc, fixBaseline: null });

    expect(screen.getByRole('button', { name: /Fix with Apex/i })).toBeEnabled();
    expect(screen.queryByTestId('apex-fix-running-banner')).not.toBeInTheDocument();
  });

  it('does not swallow the click', async () => {
    markApexFixInProgress('design-doc-validation', 'doc-1', { threadId: 'thread-fix' });

    renderView({ ...baseDoc, fixBaseline: null });
    fireEvent.click(screen.getByRole('button', { name: /Fix with Apex/i }));

    await waitFor(() => expect(mockFixMutateAsync).toHaveBeenCalledWith('doc-1'));
  });
});

describe('a doc already back in validation', () => {
  it('never shows the fixing spinner on top of it', () => {
    markApexFixInProgress('design-doc-validation', 'doc-1', { threadId: 'thread-fix' });

    renderView({ ...baseDoc, status: 'validating', fixBaseline: unchangedBaseline });

    expect(screen.queryByTestId('apex-fix-running-banner')).not.toBeInTheDocument();
  });

  it('does not reopen the review panel over the validating page', () => {
    renderView({ ...baseDoc, status: 'validating', fixBaseline: unchangedBaseline });

    expect(screen.queryByTestId('retry-fix-with-apex')).not.toBeInTheDocument();
    expect(mockDismissMutateAsync).not.toHaveBeenCalled();
  });
});

describe('Retry Fix with Apex from the review panel', () => {
  it('dismisses the finished session and starts a fresh run', async () => {
    // Baseline differs from current content, so the run produced real changes
    // and the review panel opens.
    renderView({
      ...baseDoc,
      fixBaseline: { ...unchangedBaseline, design: '# Design\nOlder content.' },
    });

    const retry = await screen.findByTestId('retry-fix-with-apex');
    fireEvent.click(retry);

    await waitFor(() => expect(mockFixMutateAsync).toHaveBeenCalledWith('doc-1'));
    expect(mockDismissMutateAsync).toHaveBeenCalledWith('doc-1');
  });
});

describe('Re-run Validation', () => {
  it('clears a leftover fix session before starting the new run', async () => {
    renderView({ ...baseDoc, status: 'draft', fixBaseline: unchangedBaseline });

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Re-run Validation/i }));

    await waitFor(() =>
      expect(mockCreateValidationThreadMutateAsync).toHaveBeenCalledWith('doc-1'),
    );
    expect(mockDismissMutateAsync).toHaveBeenCalledWith('doc-1');
  });
});
