import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdrChatView } from '../AdrChatView';
import type { AgentRunPhase } from '../../../shared/types/chat';
import type { Adr } from '../../../shared/types/adr';

const mockNavigate = jest.fn();
const deleteMutate = jest.fn();
const createCommentMutateAsync = jest.fn();
const mockCan = jest.fn((key: string) => key === 'adr:delete' || key === 'adr:edit' || key === 'adr:review');
let mockUserId = 'owner-1';
let mockIsSuperAdmin = false;
let mockAssignments: Array<{ approverUserId: string; status: 'pending' | 'approved' | 'revision_requested' }> = [];
let mockAssignmentsError = false;
let mockReviewConfig: {
  approvalMode?: 'any_one' | 'all_required';
  approvalModes?: { adr?: 'any_one' | 'all_required' };
} | null = null;
let mockStreamState: {
  messages: Array<{ id: string; role: 'agent' | 'user'; text: string }>;
  streamingText: string;
  status: 'idle' | 'running' | 'error';
  progressLabel?: string | null;
  progressPhase?: AgentRunPhase | null;
  lastError?: string | null;
} = { messages: [], streamingText: '', status: 'idle' };

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
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: mockCan,
    userId: mockUserId,
    isSuperAdmin: mockIsSuperAdmin,
    permissionsLoaded: true,
  }),
}));

jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: () => mockStreamState,
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: () => ({ data: null }),
  useSkillRepos: () => ({ data: [] }),
  useStartChat: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: () => ({ data: mockReviewConfig }),
  useGlobalDefaultModel: () => ({ data: { value: 'composer-2' } }),
  useAvailableModels: () => ({ data: [] }),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    attachmentError: null,
    addFiles: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  }),
  formatAttachmentSize: () => '0B',
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: () => ({
    isListening: false,
    isSpeechSupported: false,
    speechError: null,
    toggle: jest.fn(),
    stop: jest.fn(),
  }),
}));

jest.mock('../../hooks/useAdrs', () => ({
  useAdr: jest.fn(),
  useAdrAssignments: () => ({ data: mockAssignments, isLoading: false, isError: mockAssignmentsError }),
  useAdrComments: () => ({ data: [] }),
  useAdrOwnerApproval: () => ({ data: null }),
  useAssignAdrReviewers: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateAdr: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreateAdrComment: () => ({ mutateAsync: createCommentMutateAsync, isPending: false }),
  useDeleteAdr: () => ({ mutate: deleteMutate, isPending: false }),
  useDeleteAdrComment: () => ({ mutate: jest.fn() }),
  useFixAdrCommentWithAi: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useFixAdrWithAi: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useGenerateAdr: () => ({ mutate: jest.fn(), isPending: false }),
  useReopenAdrComment: () => ({ mutate: jest.fn() }),
  useReplyToAdrComment: () => ({ mutate: jest.fn() }),
  useResolveAdrComment: () => ({ mutate: jest.fn() }),
  useRespondToAdrOwnerApproval: () => ({ mutate: jest.fn(), isPending: false }),
  useRespondToAdrReview: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateAdr: () => ({ mutate: jest.fn() }),
}));

jest.mock('../AdrAssistantPanel', () => ({ AdrAssistantPanel: () => null }));
jest.mock('../ProposedAdrChangesReview', () => ({ ProposedAdrChangesReview: () => null }));
jest.mock('../AdrReviewerModal', () => ({ AdrReviewerModal: () => null }));
jest.mock('../MarkdownWithMermaid', () => ({
  MarkdownWithMermaid: ({ content }: { content: string }) => (
    <div data-testid="adr-markdown-with-mermaid" data-content={content}>{content}</div>
  ),
}));
jest.mock('../AnnotationLayer', () => ({
  AnnotationLayer: ({
    children,
    onAddComment,
  }: {
    children: ReactNode;
    onAddComment: (sectionKey: 'adr', selector: {
      exact: string;
      prefix: string;
      suffix: string;
      start: number;
      end: number;
    }) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onAddComment('adr', {
          exact: 'selected ADR text',
          prefix: '',
          suffix: '',
          start: 0,
          end: 17,
        })}
      >
        Add ADR comment
      </button>
      {children}
    </>
  ),
}));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));

import { useAdr } from '../../hooks/useAdrs';

const sampleAdr: Adr = {
  id: 'adr-1',
  chatThreadId: 'thread-1',
  authorId: 'owner-1',
  ownerName: 'Owner One',
  reviewerIds: [],
  reviewers: [],
  title: 'Choose event transport',
  project: 'Apex',
  repo: 'Apex',
  status: 'in_progress',
  content: '',
  createdAt: '2026-07-17T00:00:00Z',
  updatedAt: '2026-07-17T00:00:00Z',
};

function renderAdrView() {
  return render(
    <MemoryRouter initialEntries={['/adr/adr-1']}>
      <AdrChatView />
    </MemoryRouter>,
  );
}

describe('AdrChatView — delete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = 'owner-1';
    mockIsSuperAdmin = false;
    mockAssignments = [];
    mockAssignmentsError = false;
    mockReviewConfig = null;
    createCommentMutateAsync.mockResolvedValue(undefined);
    mockStreamState = { messages: [], streamingText: '', status: 'idle' };
    mockCan.mockImplementation((key: string) => key === 'adr:delete' || key === 'adr:edit' || key === 'adr:review');
    (useAdr as jest.Mock).mockReturnValue({ data: sampleAdr, isLoading: false, isError: false });
  });

  it('shows a Delete action for the author with adr:delete', () => {
    renderAdrView();

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides Delete when the viewer is not the author', () => {
    mockUserId = 'reviewer-1';
    renderAdrView();

    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('hides Delete when adr:delete is not allowed', () => {
    mockCan.mockImplementation((key: string) => key === 'adr:edit');
    renderAdrView();

    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('opens ConfirmDeleteModal and deletes, then navigates to /adr', () => {
    renderAdrView();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog', { name: 'Delete ADR' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/permanently delete the ADR/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(deleteMutate).toHaveBeenCalledWith('adr-1', expect.objectContaining({
      onSuccess: expect.any(Function),
      onError: expect.any(Function),
    }));

    const [, options] = deleteMutate.mock.calls[0] as [string, { onSuccess: () => void }];
    options.onSuccess();
    expect(mockNavigate).toHaveBeenCalledWith('/adr');
  });

  it('surfaces the delete error and closes the modal on failure', () => {
    renderAdrView();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete ADR' })).getByRole('button', { name: 'Delete' }));

    const [, options] = deleteMutate.mock.calls[0] as [string, { onError: (err: Error) => void }];
    act(() => {
      options.onError(new Error('update or delete on table "adrs" violates foreign key'));
    });

    expect(screen.queryByRole('dialog', { name: 'Delete ADR' })).not.toBeInTheDocument();
    expect(screen.getByText(/violates foreign key/i)).toBeInTheDocument();
  });

  it('renders persisted ADR content with Mermaid-aware Markdown', () => {
    const content = '## Proposed Architecture\n\nflowchart LR\n  A --> B';
    (useAdr as jest.Mock).mockReturnValue({
      data: { ...sampleAdr, content, status: 'proposed' },
      isLoading: false,
      isError: false,
    });

    renderAdrView();

    expect(screen.getByTestId('adr-markdown-with-mermaid')).toHaveAttribute('data-content', content);
  });

  it('PBI-007 AC-0 owner-only ADR omits reviewer management and revision actions', () => {
    mockUserId = 'viewer-1';
    (useAdr as jest.Mock).mockReturnValue({
      data: { ...sampleAdr, content: '# ADR', status: 'proposed' },
      isLoading: false,
      isError: false,
    });

    renderAdrView();

    expect(screen.queryByTestId('adr-manage-reviewers-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('adr-request-revision-btn')).not.toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Accept ADR' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-describedby', 'owner-approve-disabled-reason');
    expect(screen.getByTestId('owner-approve-disabled-reason')).toHaveTextContent(
      'Only the document owner or a Platform Admin can approve',
    );
  });

  it('PBI-007 AC-2 keeps assigned-at-creation reviewer actions visible', () => {
    mockUserId = 'reviewer-1';
    mockAssignments = [{ approverUserId: 'reviewer-1', status: 'pending' }];
    (useAdr as jest.Mock).mockReturnValue({
      data: {
        ...sampleAdr,
        content: '# ADR',
        status: 'proposed',
        reviewerIds: ['reviewer-1'],
        reviewers: [{ id: 'reviewer-1', displayName: 'Reviewer One', email: null }],
      },
      isLoading: false,
      isError: false,
    });

    renderAdrView();

    expect(screen.getByTestId('adr-approve-btn')).toBeInTheDocument();
    expect(screen.getByTestId('adr-request-revision-btn')).toBeInTheDocument();
  });

  it('does not infer owner-only review when assignment loading fails', () => {
    mockUserId = 'viewer-1';
    mockAssignmentsError = true;
    (useAdr as jest.Mock).mockReturnValue({
      data: { ...sampleAdr, content: '# ADR', status: 'proposed' },
      isLoading: false,
      isError: false,
    });

    renderAdrView();

    expect(screen.queryByRole('button', { name: 'Accept ADR' })).not.toBeInTheDocument();
  });

  it('uses the ADR approval mode when deciding whether owner approval is ready', () => {
    mockAssignments = [
      { approverUserId: 'reviewer-1', status: 'approved' },
      { approverUserId: 'reviewer-2', status: 'pending' },
    ];
    mockReviewConfig = {
      approvalMode: 'any_one',
      approvalModes: { adr: 'all_required' },
    };
    (useAdr as jest.Mock).mockReturnValue({
      data: { ...sampleAdr, content: '# ADR', status: 'proposed' },
      isLoading: false,
      isError: false,
    });

    renderAdrView();

    expect(screen.getByRole('button', { name: 'Accept ADR' })).toBeDisabled();
  });

  it('PBI-007 AC-1 surfaces owner-only comment failure without losing the typed comment', async () => {
    mockUserId = 'viewer-1';
    createCommentMutateAsync.mockRejectedValue(new Error('Unable to save review comment'));
    (useAdr as jest.Mock).mockReturnValue({
      data: { ...sampleAdr, content: '# ADR', status: 'proposed' },
      isLoading: false,
      isError: false,
    });

    renderAdrView();
    fireEvent.click(screen.getByRole('button', { name: 'Add ADR comment' }));
    fireEvent.change(screen.getByTestId('adr-comment-input'), {
      target: { value: 'Preserve this feedback' },
    });
    fireEvent.click(screen.getByTestId('adr-comment-post-btn'));

    await waitFor(() => {
      expect(screen.getByText('Unable to save review comment')).toBeInTheDocument();
    });
    expect(screen.getByTestId('adr-comment-input')).toHaveValue('Preserve this feedback');
  });

  it('numbers questions cumulatively across ADR agent messages', () => {
    mockStreamState = {
      messages: [
        { id: 'agent-1', role: 'agent', text: 'First decision?\n\na. Option A\nb. Option B' },
        { id: 'user-1', role: 'user', text: 'Q1: a. Option A' },
        { id: 'agent-2', role: 'agent', text: 'Second decision?\n\na. Option C\nb. Option D' },
      ],
      streamingText: '',
      status: 'idle',
    };

    renderAdrView();

    expect(screen.getByText('Q1')).toBeInTheDocument();
    expect(screen.getByText('Q2')).toBeInTheDocument();
  });

  it('shows a preparation spinner while the ADR workspace is setting up', () => {
    mockStreamState = {
      messages: [{ id: 'begin-1', role: 'user', text: 'Begin.' }],
      streamingText: '',
      status: 'running',
      progressLabel: 'Refreshing the repository mirror…',
      progressPhase: 'analysis',
    };

    renderAdrView();

    expect(screen.getByTestId('adr-preparation-state')).toHaveTextContent(
      'Loading…',
    );
    expect(screen.getByPlaceholderText(/Preparing the workspace/i)).toBeDisabled();
    expect(screen.queryByTestId('adr-agent-processing')).not.toBeInTheDocument();
  });

  it('shows the kickoff prompt immediately while waiting for the first agent reply', () => {
    mockStreamState = {
      messages: [],
      streamingText: '',
      status: 'idle',
    };

    render(
      <MemoryRouter
        initialEntries={[{
          pathname: '/adr/adr-1',
          state: { kickoffPrompt: 'Should we use Service Bus or Event Hub?' },
        }]}
      >
        <AdrChatView />
      </MemoryRouter>,
    );

    expect(screen.getByText('Should we use Service Bus or Event Hub?')).toBeInTheDocument();
    expect(screen.getByTestId('adr-preparation-state')).toHaveTextContent(
      'Architect is preparing a response',
    );
  });

  it('renders queued status text while the ADR run waits for a worker', () => {
    mockStreamState = {
      messages: [],
      streamingText: '',
      status: 'running',
      progressPhase: 'queued',
      progressLabel: 'Queued — waiting for available worker',
    };

    renderAdrView();

    expect(screen.getByTestId('agent-run-status-queued')).toHaveTextContent(
      'Waiting…',
    );
  });
});
