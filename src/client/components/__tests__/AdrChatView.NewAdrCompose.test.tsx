import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AdrChatView } from '../AdrChatView';
import { useProjectRepositoryReadiness } from '../../hooks/useProjectRepositoryReadiness';

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
  useNavigate: () => jest.fn(),
}));

const startChat = jest.fn();
const createAdr = jest.fn();
const clearAttachments = jest.fn();
const retryAvailability = jest.fn();
const mockUseReviewerAvailability = jest.fn();
const mockUseProjectRepositoryReadiness = useProjectRepositoryReadiness as jest.MockedFunction<
  typeof useProjectRepositoryReadiness
>;

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    selectedProject: 'Apex',
    selectedSkillSettingsId: null,
    authenticatedUser: { name: 'ADR Owner' },
    permissionsLoaded: true,
    can: () => true,
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: () => ({ data: [{ name: 'Apex', defaultBranch: 'main' }] }),
  useStartChat: () => ({ mutateAsync: startChat, isPending: false }),
  useChatThread: () => ({ data: null }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: () => ({ data: null }),
  useGlobalDefaultModel: () => ({ data: { value: 'composer-2' } }),
  useAvailableModels: () => ({ data: [{ id: 'composer-2', displayName: 'Composer 2' }] }),
}));

jest.mock('../../hooks/useAdrs', () => ({
  useCreateAdr: () => ({ mutateAsync: createAdr, isPending: false }),
}));

jest.mock('../../hooks/useReviewerAvailability', () => ({
  useReviewerAvailability: (...args: unknown[]) => mockUseReviewerAvailability(...args),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [{
      id: 'attachment-1',
      name: 'constraints.txt',
      size: 12,
      type: 'text/plain',
      content: 'must remain backward compatible',
    }],
    attachmentError: null,
    addFiles: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments,
  }),
  formatAttachmentSize: () => '12B',
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: () => ({
    isListening: false,
    isSpeechSupported: true,
    speechError: null,
    toggle: jest.fn(),
    stop: jest.fn(),
  }),
}));

jest.mock('../../hooks/useProjectRepositoryReadiness', () => ({
  useProjectRepositoryReadiness: jest.fn(() => ({
    isReady: true,
    message: null,
    readiness: null,
    isLoading: false,
    isFetching: false,
    flagEnabled: true,
  })),
  PROJECT_REPOSITORY_NOT_READY_MESSAGE:
    'A project administrator must clone this repository before repository-dependent AI work can run.',
}));

jest.mock('../AdrReviewerModal', () => ({
  AdrReviewerModal: ({ onConfirm }: { onConfirm: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onConfirm(['reviewer-1'])}>Confirm reviewers</button>
  ),
}));

jest.mock('../MarkdownWithMermaid', () => ({
  MarkdownWithMermaid: ({ content }: { content: string }) => (
    <div data-testid="adr-markdown-with-mermaid" data-content={content}>{content}</div>
  ),
}));

describe('NewAdrCompose', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    startChat.mockResolvedValue({ threadId: 'thread-1' });
    createAdr.mockResolvedValue({ adrId: 'adr-1', threadId: 'thread-1' });
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
    mockUseReviewerAvailability.mockReturnValue({
      data: {
        modules: [{ documentType: 'adr', available: true, candidateCount: 1 }],
      },
      isLoading: false,
      isError: false,
      refetch: retryAvailability,
    });
    mockUseProjectRepositoryReadiness.mockReturnValue({
      isReady: true,
      message: null,
      readiness: null,
      isLoading: false,
      isFetching: false,
      flagEnabled: true,
    });
  });

  it('PBI-005 AC-0 opens required reviewer selection and sends reviewers plus attachments', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/adr/new']}>
          <AdrChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Choose event transport' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what is being built/i), {
      target: { value: 'Compare queue and event-stream options.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start ADR' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm reviewers' }));

    await waitFor(() => expect(createAdr).toHaveBeenCalledWith(expect.objectContaining({
      reviewerIds: ['reviewer-1'],
      title: 'Choose event transport',
    })));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/chat/threads/thread-1/messages',
      expect.objectContaining({
        body: expect.stringContaining('"constraints.txt"'),
      }),
    );
    expect(clearAttachments).toHaveBeenCalled();
    expect(mockUseReviewerAvailability).toHaveBeenCalledWith('Apex', 'adr');
  });

  it('PBI-005 AC-1 preserves the draft and offers retry when availability fails', () => {
    mockUseReviewerAvailability.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: retryAvailability,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/adr/new']}><AdrChatView /></MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Keep this title' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what is being built/i), {
      target: { value: 'Keep this decision context.' },
    });

    expect(screen.getByTestId('adr-reviewer-availability-error')).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByTestId('adr-reviewer-availability-retry'));
    expect(retryAvailability).toHaveBeenCalled();
    expect(screen.getByDisplayValue('Keep this title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Keep this decision context.')).toBeInTheDocument();
    expect(createAdr).not.toHaveBeenCalled();
  });

  it('PBI-005 AC-2 creates an owner-only ADR without opening the picker', async () => {
    mockUseReviewerAvailability.mockReturnValue({
      data: {
        modules: [{ documentType: 'adr', available: false, candidateCount: 0 }],
      },
      isLoading: false,
      isError: false,
      refetch: retryAvailability,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/adr/new']}><AdrChatView /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Owner-only ADR' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what is being built/i), {
      target: { value: 'No configured reviewers.' },
    });
    fireEvent.click(screen.getByTestId('create-adr-no-reviewers'));

    await waitFor(() => expect(createAdr).toHaveBeenCalledWith(expect.objectContaining({
      reviewerIds: [],
      title: 'Owner-only ADR',
    })));
    expect(screen.queryByRole('button', { name: 'Confirm reviewers' })).not.toBeInTheDocument();
  });

  it('PBI-005 loading does not create or classify reviewer availability', () => {
    mockUseReviewerAvailability.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: retryAvailability,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/adr/new']}><AdrChatView /></MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Loading ADR' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what is being built/i), {
      target: { value: 'Wait for availability.' },
    });

    expect(screen.getByRole('button', { name: 'Start ADR' })).toBeDisabled();
    expect(createAdr).not.toHaveBeenCalled();
  });

  it('disables start and shows an error when the project repository is not cloned', () => {
    mockUseProjectRepositoryReadiness.mockReturnValue({
      isReady: false,
      message:
        'A project administrator must clone this repository before repository-dependent AI work can run.',
      readiness: null,
      isLoading: false,
      isFetching: false,
      flagEnabled: true,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/adr/new']}>
          <AdrChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Choose event transport' } });
    fireEvent.change(screen.getByPlaceholderText(/describe what is being built/i), {
      target: { value: 'Compare queue and event-stream options.' },
    });

    expect(screen.getByRole('button', { name: 'Start ADR' })).toBeDisabled();
    expect(screen.getByTestId('adr-compose-repo-not-ready')).toHaveTextContent(
      /project administrator must clone/i,
    );
    expect(createAdr).not.toHaveBeenCalled();
  });
});
