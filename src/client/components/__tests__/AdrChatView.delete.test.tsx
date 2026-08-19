import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdrChatView } from '../AdrChatView';
import type { Adr } from '../../../shared/types/adr';

const mockNavigate = jest.fn();
const deleteMutate = jest.fn();
const mockCan = jest.fn((key: string) => key === 'adr:delete' || key === 'adr:edit' || key === 'adr:review');
let mockUserId = 'owner-1';
let mockStreamState: {
  messages: Array<{ id: string; role: 'agent' | 'user'; text: string }>;
  streamingText: string;
  status: 'idle' | 'running' | 'error';
  progressLabel?: string | null;
  progressPhase?: string | null;
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
  useProjectSkillConfig: () => ({ data: null }),
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
  useAdrAssignments: () => ({ data: [] }),
  useAdrComments: () => ({ data: [] }),
  useAdrOwnerApproval: () => ({ data: null }),
  useAssignAdrReviewers: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateAdr: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreateAdrComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
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
  AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
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
