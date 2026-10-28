import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InterviewChatView } from '../InterviewChatView';
import { BuildIntakeChatRoute } from '../BuildIntakeChatRoute';
import type { Interview } from '../../../shared/types/interview';
import { BUILD_INTAKE_OPTION_KEY } from '../../../shared/types/buildPreflight';
import { BUILD_INTAKE_PAUSED_MESSAGE } from '../../../shared/types/buildAccess';
import { BUILD_FROM_PROMPT_FLAG } from '../../../shared/types/featureFlags';

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(() => ({
    selectedProject: 'MaxView',
    can: jest.fn(() => true),
    userId: 'user-1',
    isAdmin: false,
    isInAnyGroup: jest.fn(() => true),
  })),
}));

jest.mock('../../hooks/useRbac', () => ({
  useMyPermissions: jest.fn(() => ({
    projectRoles: [],
    roles: [],
    permissions: [],
    isAdmin: false,
    can: () => false,
  })),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: jest.fn(() => ({ data: [] })),
  useSkillList: jest.fn(() => ({ data: [] })),
  useStartChat: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useChatThread: jest.fn(() => ({ data: null })),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn(() => ({ data: null })),
  useGlobalDefaultModel: jest.fn(() => ({ data: { key: 'defaultModel', value: 'composer-2' } })),
  useAvailableModels: jest.fn(() => ({ data: [], isLoading: false })),
}));

jest.mock('../../hooks/useProjectRepositoryReadiness', () => ({
  useProjectRepositoryReadiness: jest.fn(() => ({
    isReady: true,
    message: null,
    readiness: null,
    isLoading: false,
    isFetching: false,
    flagEnabled: false,
  })),
  PROJECT_REPOSITORY_NOT_READY_MESSAGE: 'not ready',
}));

jest.mock('../../hooks/useInterviews', () => ({
  useCreateInterview: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useInterview: jest.fn(),
  useInterviewBrief: jest.fn(() => ({ data: null, isLoading: false })),
  useDraftInterviewBrief: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, error: null })),
  useSaveInterviewBrief: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, error: null })),
  useApproveInterviewBrief: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, error: null })),
  useUpdateInterviewStatus: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useUpdateInterviewPhaseAssignments: jest.fn(() => ({ mutate: jest.fn(), isPending: false, error: null })),
  useActiveUsers: jest.fn(() => ({ data: [], isLoading: false })),
  useUpdateInterviewTitle: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useCreatePrd: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useDeleteInterview: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

const mockUseAgentChatSession = jest.fn();
jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: (...args: unknown[]) => mockUseAgentChatSession(...args),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: jest.fn(() => ({
    attachments: [],
    attachmentError: null,
    addFiles: jest.fn(),
    addTextAttachments: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  })),
  formatAttachmentSize: jest.fn((s: number) => `${s}B`),
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: jest.fn(() => ({
    isListening: false,
    isSpeechSupported: true,
    speechError: null,
    toggle: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('../../hooks/useSpeechOutput', () => ({
  useSpeechOutput: jest.fn(() => ({
    speak: jest.fn(),
    stop: jest.fn(),
    isSpeaking: false,
    isSpeechOutputSupported: true,
  })),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: jest.fn(),
}));

jest.mock('../../hooks/useBuilds', () => ({
  useBuildIntake: jest.fn(),
}));

function mockIdleMutation(): { mutate: jest.Mock; mutateAsync: jest.Mock; reset: jest.Mock; isPending: boolean; error: Error | null } {
  return { mutate: jest.fn(), mutateAsync: jest.fn(), reset: jest.fn(), isPending: false, error: null };
}
const mockUseDraftBuildBrief = jest.fn(mockIdleMutation);
jest.mock('../../hooks/useBuildBrief', () => ({
  useBuildBriefRecord: jest.fn(() => ({ data: null, isLoading: false })),
  useBuildBriefAnalysis: jest.fn(() => ({
    data: { kind: 'missing', draftFailed: false },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  })),
  useSaveBuildBrief: jest.fn(mockIdleMutation),
  useDraftBuildBrief: () => mockUseDraftBuildBrief(),
  useApproveBuildBrief: jest.fn(mockIdleMutation),
}));

jest.mock('../LinkedContextPicker', () => ({ LinkedContextPicker: () => null }));
jest.mock('../RunGroundingStatus', () => ({ RunGroundingStatus: () => null }));
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

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));

import { useInterview } from '../../hooks/useInterviews';
import { useFeatureFlags } from '../../hooks/useFeatureFlags';
import { useBuildIntake } from '../../hooks/useBuilds';

function makeIntakeInterview(overrides: Partial<Interview> = {}): Interview {
  return {
    id: 'iv-1',
    chatThreadId: 'thread-iv-1',
    authorId: 'user-1',
    title: 'Build intake',
    project: 'MaxView',
    repo: 'MaxView',
    status: 'in_progress',
    prdCount: 0,
    prds: [],
    playbookRunId: 'run-1',
    playbookProfileKey: BUILD_INTAKE_OPTION_KEY,
    prdOwnerName: 'Pat Owner',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const idleStream = {
  messages: [],
  visibleMessages: [],
  streamingText: '',
  thinkingText: '',
  toolProgress: [],
  phaseEvents: [],
  runHealth: null,
  progressLabel: null,
  progressPhase: null,
  prdReady: false,
  backlogReady: false,
  isRetrying: false,
  retryReason: null,
  isConnected: true,
  lastProgressAt: null,
  status: 'idle' as const,
  isRunning: false,
  isSending: false,
  isAwaitingAgentResponse: false,
  isPreparing: false,
  hasPreparationError: false,
  isInteractionBusy: false,
  send: jest.fn().mockResolvedValue(undefined),
  retryLast: jest.fn(),
  retryFailedRun: jest.fn().mockResolvedValue(undefined),
  retryableRunId: null as string | null,
  cancel: jest.fn().mockResolvedValue(undefined),
  sendError: null,
  clearSendError: jest.fn(),
};

const confirmMessage = {
  id: 'agent-1',
  role: 'agent' as const,
  text: [
    'You want a status page for the payments service.',
    '[[build-intake:confirm]]',
    'Is this what you want to build?',
    'a. Yes, build it',
    'b. Change something',
  ].join('\n'),
  ts: '2026-01-01T00:00:00Z',
};

const warningMessage = {
  id: 'agent-2',
  role: 'agent' as const,
  text: [
    'Sensitive data warning',
    'Your last message looks like it holds an access token. Remove it before you approve.',
    '[[build-intake:warning:access_token]]',
    '[[build-intake:question]]',
    'Which page should the link go on?',
  ].join('\n'),
  ts: '2026-01-01T00:00:01Z',
};

function setFlag(enabled: boolean) {
  (useFeatureFlags as jest.Mock).mockReturnValue({
    flags: { [BUILD_FROM_PROMPT_FLAG]: enabled },
    isLoading: false,
  });
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/backlog/interview/iv-1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = jest.fn();
  setFlag(true);
  (useInterview as jest.Mock).mockReturnValue({
    data: makeIntakeInterview(),
    isLoading: false,
    isError: false,
  });
  mockUseAgentChatSession.mockReturnValue({
    ...idleStream,
    messages: [confirmMessage, warningMessage],
    visibleMessages: [confirmMessage, warningMessage],
  });
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
  })) as unknown as jest.Mock;
});

describe('FEAT-005 VT-19 build-intake chat variant', () => {
  it('hides markers, shows the warning callout, and removes interview-only controls', () => {
    render(wrap(<InterviewChatView />));

    expect(document.body.textContent).not.toContain('[[build-intake');
    const warning = screen.getByTestId('build-intake-warning');
    expect(warning).toHaveTextContent('Sensitive data warning');
    expect(warning).toHaveTextContent('access token');
    expect(screen.getAllByText('Sensitive data warning')).toHaveLength(1);

    for (const testId of [
      'interview-attach',
      'interview-microphone',
      'interview-file-input',
      'interview-linked-context-trigger',
      'interview-owner-chips',
      'generate-prd-btn',
      'complete-interview-btn',
      'archive-interview-btn',
    ]) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
  });

  it('keeps the interview controls on a normal interview', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeIntakeInterview({ playbookRunId: null, playbookProfileKey: null }),
      isLoading: false,
      isError: false,
    });
    render(wrap(<InterviewChatView />));

    expect(screen.getByTestId('interview-attach')).toBeInTheDocument();
    expect(screen.getByTestId('interview-linked-context-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('interview-owner-chips')).toBeInTheDocument();
  });
});

describe('FEAT-006 VT-27 build brief panel in the chat view (PBI-011 b)', () => {
  afterEach(() => mockUseDraftBuildBrief.mockImplementation(mockIdleMutation));

  it('renders BuildBriefReview, shows a draft error with retry, and keeps the composer', () => {
    mockUseDraftBuildBrief.mockReturnValue({
      ...mockIdleMutation(),
      error: new Error('The brief could not be drafted. Try again, or keep chatting and draft it later.'),
    });
    render(wrap(<InterviewChatView />));

    expect(screen.getByTestId('build-brief-review')).toBeInTheDocument();
    expect(screen.queryByTestId('interview-brief-form')).not.toBeInTheDocument();
    expect(screen.getByTestId('build-brief-error')).toHaveTextContent('Try again');
    expect(screen.getByTestId('build-brief-draft')).toBeEnabled();
    expect(screen.getByTestId('interview-chat-composer')).toBeInTheDocument();
  });

  it('keeps InterviewBriefReview for a non-build playbook interview', () => {
    (useInterview as jest.Mock).mockReturnValue({
      data: makeIntakeInterview({ playbookProfileKey: null }),
      isLoading: false,
      isError: false,
    });
    render(wrap(<InterviewChatView />));

    expect(screen.queryByTestId('build-brief-review')).not.toBeInTheDocument();
  });
});

describe('FEAT-005 VT-20 build-intake accessibility', () => {
  it('lets the keyboard pick a confirm choice', async () => {
    const user = userEvent.setup();
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [confirmMessage],
      visibleMessages: [confirmMessage],
    });
    render(wrap(<InterviewChatView />));

    const choice = screen.getByTestId('interview-choice-a');
    choice.focus();
    expect(choice).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(choice).toHaveAttribute('aria-checked', 'true');
  });

  it('announces finished replies politely and hides the streaming draft', () => {
    mockUseAgentChatSession.mockReturnValue({
      ...idleStream,
      messages: [confirmMessage],
      visibleMessages: [confirmMessage],
      streamingText: 'Drafting the reply [[build-intake:quest',
      status: 'running',
      isRunning: true,
    });
    render(wrap(<InterviewChatView />));

    const draft = screen.getByText('Drafting the reply');
    const list = draft.closest('[aria-live]');
    expect(list).toHaveAttribute('aria-live', 'polite');
    expect(draft.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('FEAT-005 VT-21 BuildIntakeChatRoute', () => {
  it('shows the paused notice and keeps history when the flag is off', () => {
    setFlag(false);
    (useBuildIntake as jest.Mock).mockReturnValue({
      data: { interviewId: 'iv-1', threadId: 'thread-iv-1' },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
    render(wrap(<BuildIntakeChatRoute buildId="build-1" />));

    expect(screen.getByTestId('build-intake-chat')).toBeInTheDocument();
    expect(screen.getByTestId('build-intake-paused-notice')).toHaveTextContent(BUILD_INTAKE_PAUSED_MESSAGE);
    expect(screen.queryByTestId('interview-message-input')).not.toBeInTheDocument();
    expect(screen.getByText('You want a status page for the payments service.')).toBeInTheDocument();
    expect(screen.queryByTestId('interview-submit-answers')).not.toBeInTheDocument();
  });

  it('keeps the confirm submit control while the flag is on', () => {
    (useBuildIntake as jest.Mock).mockReturnValue({
      data: { interviewId: 'iv-1', threadId: 'thread-iv-1' },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
    render(wrap(<BuildIntakeChatRoute buildId="build-1" />));

    expect(screen.queryByTestId('build-intake-paused-notice')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('interview-submit-answers').length).toBeGreaterThan(0);
  });

  it('shows the not-started message before the interview exists', () => {
    (useBuildIntake as jest.Mock).mockReturnValue({
      data: { interviewId: null, threadId: null },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    });
    render(wrap(<BuildIntakeChatRoute buildId="build-1" />));

    expect(screen.getByTestId('build-intake-not-started')).toHaveTextContent(
      'Your build has not started its conversation yet.',
    );
  });

  it('offers a retry when the build cannot be read', async () => {
    const user = userEvent.setup();
    const refetch = jest.fn();
    (useBuildIntake as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(wrap(<BuildIntakeChatRoute buildId="build-1" />));

    expect(screen.getByTestId('build-intake-error')).toHaveTextContent('We could not open this conversation.');
    await user.click(screen.getByTestId('build-intake-retry'));
    expect(refetch).toHaveBeenCalled();
  });
});
