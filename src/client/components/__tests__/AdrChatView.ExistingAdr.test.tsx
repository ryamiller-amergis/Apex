import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdrChatView } from '../AdrChatView';
import type { Adr } from '../../../shared/types/adr';

const mockRetryFailedRun = jest.fn().mockResolvedValue(undefined);
const mockSend = jest.fn().mockResolvedValue(undefined);

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
  useParams: () => ({ id: 'adr-1' }),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: (key: string) => key === 'adr:edit' || key === 'adr:review',
    userId: 'owner-1',
    isSuperAdmin: false,
    permissionsLoaded: true,
  }),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    messages: [
      {
        id: 'u1',
        role: 'user',
        text: 'Original ADR answer',
        ts: '2026-09-23T12:00:00.000Z',
      },
      {
        id: 'e1',
        role: 'system',
        text: 'Error: worker failed',
        ts: '2026-09-23T12:00:01.000Z',
      },
    ],
    visibleMessages: [
      {
        id: 'u1',
        role: 'user',
        text: 'Original ADR answer',
        ts: '2026-09-23T12:00:00.000Z',
      },
      {
        id: 'e1',
        role: 'system',
        text: 'Error: worker failed',
        ts: '2026-09-23T12:00:01.000Z',
      },
    ],
    streamingText: '',
    progressLabel: null,
    progressPhase: null,
    isPreparing: false,
    hasPreparationError: false,
    showTypingIndicator: false,
    isRunning: false,
    isSending: false,
    isCancelling: false,
    isAwaitingAgentResponse: false,
    isInteractionBusy: false,
    status: 'error',
    sendError: null,
    send: mockSend,
    cancel: jest.fn(),
    retryLast: jest.fn(),
    retryFailedRun: mockRetryFailedRun,
    retryableRunId: '50000000-0000-4000-8000-000000000001',
    clearSendError: jest.fn(),
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: () => ({
    data: {
      id: 'thread-1',
      status: 'error',
      messages: [],
      kickoff: { project: 'Apex', repo: 'Apex' },
    },
    isLoading: false,
    isError: false,
  }),
  useSkillRepos: () => ({ data: [] }),
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

jest.mock('../../hooks/useAdrs', () => ({
  useAdr: () => ({ data: sampleAdr, isLoading: false, isError: false }),
  useAdrAssignments: () => ({ data: [], isLoading: false, isError: false }),
  useAdrComments: () => ({ data: [] }),
  useAdrOwnerApproval: () => ({ data: null }),
  useAssignAdrReviewers: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateAdr: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreateAdrComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteAdr: () => ({ mutate: jest.fn(), isPending: false }),
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
  MarkdownWithMermaid: ({ content }: { content: string }) => <div>{content}</div>,
}));
jest.mock('../AnnotationLayer', () => ({
  AnnotationLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('../ReviewCommentSidebar', () => ({ ReviewCommentSidebar: () => null }));
jest.mock('../InterviewChatView', () => ({
  InterviewAgentMessage: () => null,
}));

describe('AdrChatView existing ADR durable retry', () => {
  it('retries a failed durable run by identity without resending text', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/adr/adr-1']}>
          <AdrChatView />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId('adr-retry-message'));
    expect(mockRetryFailedRun).toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
