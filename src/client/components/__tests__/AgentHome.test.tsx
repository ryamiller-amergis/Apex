import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { AgentHome } from '../AgentHome';
import { useProductSetup } from '../../hooks/useProductSetup';

const mockDashboardData = {
  incompletePipeline: {
    status: 'empty' as const,
    data: { updatedAt: '2026-09-15T12:00:00Z', groups: [] },
  },
  artifactCycleTime: {
    status: 'empty' as const,
    data: {},
  },
  myWork: null,
  openBugsOnPbis: null,
  bugToPbiRatio: null,
  devToProduction: null,
};

jest.mock('../../hooks/useHomeDashboard', () => ({
  useHomeDashboard: () => ({
    data: mockDashboardData,
    isLoading: false,
    refetch: jest.fn(),
  }),
}));

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThread: jest.fn(() => ({ data: undefined })),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: jest.fn(() => ({
    visibleMessages: [],
    streamingText: '',
    progressLabel: null,
    isRunning: false,
    isSending: false,
    isInteractionBusy: false,
    isAwaitingAgentResponse: false,
    sendError: null,
    hasConnectionError: false,
    send: jest.fn(),
    cancel: jest.fn(),
    retryLast: jest.fn(),
    showTypingIndicator: false,
  })),
}));

jest.mock('../../hooks/useProductSetup', () => {
  const actual = jest.requireActual('../../hooks/useProductSetup');
  return {
    ...actual,
    useProductSetup: jest.fn(() => ({
      data: {
        active: false,
        skillPath: '',
        model: 'auto-smart',
        candidates: [],
        foundationAnswers: [],
      },
      isLoading: false,
      isPending: false,
      isFetched: true,
      refetch: jest.fn(),
    })),
  };
});

const inactiveSetup = {
  data: {
    active: false,
    skillPath: '',
    model: 'auto-smart',
    candidates: [] as [],
    foundationAnswers: [] as string[],
  },
  isLoading: false,
  isPending: false,
  isFetched: true,
  refetch: jest.fn(),
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

describe('AgentHome tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    (useProductSetup as jest.Mock).mockReturnValue(inactiveSetup);
  });

  it('defaults to Chat without creating a second composer', () => {
    const onHomeViewChange = jest.fn();
    render(<AgentHome selectedProject="Apex" onHomeViewChange={onHomeViewChange} />, { wrapper });
    expect(screen.getByTestId('home-view-chat')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('home-dashboard-root')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-composer')).not.toBeInTheDocument();
    expect(onHomeViewChange).toHaveBeenCalledWith('chat');
  });

  it('shows only the two-tile dashboard from Project status', () => {
    const onHomeViewChange = jest.fn();
    render(
      <AgentHome
        selectedProject="Apex"
        onHomeViewChange={onHomeViewChange}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId('home-view-status'));
    expect(screen.getByTestId('home-dashboard-root')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-pipeline-card')).toBeInTheDocument();
    expect(screen.getByTestId('home-dashboard-cycle-time-card')).toBeInTheDocument();
    expect(screen.queryByTestId('home-dashboard-my-work-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-dashboard-bugs-card')).not.toBeInTheDocument();
    expect(onHomeViewChange).toHaveBeenLastCalledWith('status');
    expect(localStorage.getItem('apex-home-view:Apex')).toBe('status');
  });

  it('leaves the foundation skills banner to the page shell, clear of the chat overlay', () => {
    render(<AgentHome selectedProject="MaxView" />, { wrapper });
    expect(screen.queryByTestId('agent-home-foundation-skill-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-view-chat')).toBeInTheDocument();
  });

  it('does not render the removed edge Chat toggle', () => {
    render(<AgentHome selectedProject="Apex" />, { wrapper });
    expect(screen.queryByTestId('home-chat-toggle-btn')).not.toBeInTheDocument();
  });

  it('restores a saved Home thread while keeping the remembered tab', () => {
    sessionStorage.setItem('agentHomeThreadId:Apex', 'thread-saved');
    localStorage.setItem('apex-home-view:Apex', 'status');
    const onRestoreThread = jest.fn();
    render(
      <AgentHome
        selectedProject="Apex"
        onRestoreThread={onRestoreThread}
      />,
      { wrapper },
    );
    expect(onRestoreThread).toHaveBeenCalledWith('thread-saved');
    expect(screen.getByTestId('home-view-status')).toHaveAttribute('aria-selected', 'true');
  });

  it('selects Chat for an explicit Home thread deep link', () => {
    localStorage.setItem('apex-home-view:Apex', 'status');
    const onRestoreThread = jest.fn();
    const onHomeViewChange = jest.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/home?thread=thread-linked']}>
          <AgentHome
            selectedProject="Apex"
            onRestoreThread={onRestoreThread}
            onHomeViewChange={onHomeViewChange}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(onRestoreThread).toHaveBeenCalledWith('thread-linked');
    expect(screen.getByTestId('home-view-chat')).toHaveAttribute('aria-selected', 'true');
    expect(onHomeViewChange).toHaveBeenLastCalledWith('chat');
    expect(localStorage.getItem('apex-home-view:Apex')).toBe('status');
  });

  it('restores a later thread deep link after Home has already mounted', () => {
    const onRestoreThread = jest.fn();
    const OpenThreadLink = () => {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate('/home?thread=thread-later')}>
          Open thread
        </button>
      );
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/home']}>
          <OpenThreadLink />
          <AgentHome selectedProject="Apex" onRestoreThread={onRestoreThread} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(onRestoreThread).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(onRestoreThread).toHaveBeenCalledWith('thread-later');
  });

  it('restores the same thread deep link after the query param leaves the URL', () => {
    const onRestoreThread = jest.fn();
    const ToggleThreadLink = () => {
      const navigate = useNavigate();
      const [searchParams] = useSearchParams();
      const hasThread = searchParams.get('thread');
      return (
        <button
          type="button"
          onClick={() => navigate(hasThread ? '/home' : '/home?thread=thread-repeat')}
        >
          Toggle thread
        </button>
      );
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/home?thread=thread-repeat']}>
          <ToggleThreadLink />
          <AgentHome selectedProject="Apex" onRestoreThread={onRestoreThread} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(onRestoreThread).toHaveBeenCalledTimes(1);
    expect(onRestoreThread).toHaveBeenCalledWith('thread-repeat');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle thread' }));
    expect(onRestoreThread).toHaveBeenCalledTimes(2);
    expect(onRestoreThread).toHaveBeenLastCalledWith('thread-repeat');
  });
});

describe('product setup', () => {
  const setupSkillPath = '.cursor/skills/product-foundation/SKILL.md';
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    (useProductSetup as jest.Mock).mockReturnValue({
      data: {
        active: true,
        skillPath: setupSkillPath,
        model: 'auto-smart',
        candidates: [],
        foundationAnswers: [],
      },
      isLoading: false,
      isPending: false,
      isFetched: true,
      refetch: jest.fn(),
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ markdown: '# Product' }),
    }) as jest.Mock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('keeps setup on the form and does not reopen an old chat', async () => {
    sessionStorage.setItem('agentHomeThreadId:To Do App', 'setup-thread');
    const onRestoreThread = jest.fn();

    render(
      <AgentHome selectedProject="To Do App" onRestoreThread={onRestoreThread} />,
      { wrapper },
    );

    expect(await screen.findByTestId('product-setup')).toBeInTheDocument();
    expect(screen.getByTestId('product-setup-people-form')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-setup-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-composer-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-compose-history-toggle')).not.toBeInTheDocument();
    expect(onRestoreThread).not.toHaveBeenCalled();
  });

  it('hides history in compose mode while setup is active', () => {
    render(<AgentHome selectedProject="To Do App" />, { wrapper });
    expect(screen.getByTestId('product-setup')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-compose-history-toggle')).not.toBeInTheDocument();
  });

  it('asks Bedrock for one draft after the four-part review', async () => {
    render(<AgentHome selectedProject="To Do App" />, { wrapper });

    fireEvent.click(screen.getByTestId('product-setup-step-2'));
    for (let index = 0; index < 4; index += 1) {
      fireEvent.change(screen.getByTestId('product-setup-foundation-answer'), {
        target: { value: `Guided answer ${index + 1}` },
      });
      fireEvent.click(screen.getByTestId('product-setup-foundation-next'));
    }

    await waitFor(() => {
      const draftCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
        String(call[0]).includes('/api/product-builds/foundation/draft'),
      );
      expect(draftCall).toBeDefined();
      const body = JSON.parse(draftCall![1].body);
      expect(body.project).toBe('To Do App');
      expect(body.answers).toEqual([
        'Guided answer 1',
        'Guided answer 2',
        'Guided answer 3',
        'Guided answer 4',
      ]);
    });
    expect((global.fetch as jest.Mock).mock.calls.some((call) => String(call[0]).includes('/messages'))).toBe(false);
  });

  it('keeps the foundation guide while PRODUCT.md is still open', () => {
    (useProductSetup as jest.Mock).mockReturnValue({
      data: {
        active: true,
        phase: 'foundation',
        skillPath: setupSkillPath,
        model: 'auto-smart',
        candidates: [],
        canInviteTeammates: true,
        foundationAnswers: [],
        build: null,
        chatThreadId: null,
        thread: null,
        design: null,
      },
      isLoading: false,
      isPending: false,
      isFetched: true,
      refetch: jest.fn(),
    });

    render(<AgentHome selectedProject="To Do App" />, { wrapper });

    expect(screen.getByTestId('product-setup')).toBeInTheDocument();
    expect(screen.queryByTestId('product-build-setup')).not.toBeInTheDocument();
  });

  it('switches to the build panel once PRODUCT.md exists and keeps a finished pull request there', () => {
    (useProductSetup as jest.Mock).mockReturnValue({
      data: {
        active: true,
        phase: 'build',
        skillPath: '.agents/skills/product-discovery/SKILL.md',
        model: 'gemini-3.8-flash',
        candidates: [],
        foundationAnswers: [],
        project: 'To Do App',
        build: {
          id: 'build-1',
          kind: 'initial',
          status: 'pr-open',
          project: 'To Do App',
          rfpRequestId: 'rfp-1',
          chatThreadId: 'thread-1',
          uiLabDesignId: 'design-1',
          prototypeVersion: 1,
          devSessionId: null,
          agentRunId: 'run-9',
          brief: {
            version: 1,
            kind: 'initial',
            product: {
              name: 'To Do App',
              audience: 'Employees',
              problem: 'Tasks are scattered.',
              scopeSummary: 'Tasks and reminders.',
              successCriteria: ['A person can see today\'s tasks.'],
            },
            initialBuild: {
              summary: 'See today\'s tasks.',
              coreWorkflow: 'Open the list.',
              personas: [{ name: 'Employee', goal: 'See today.' }],
              screens: [{ name: 'Today', purpose: 'List tasks.' }],
              data: [{ name: 'Task', fields: ['title'] }],
              integrations: [],
              auth: 'Company sign-in.',
              visualDirection: 'Calm.',
              nonFunctionalRequirements: ['The list loads with the page.'],
              acceptanceCriteria: [{ id: 'AC-1', statement: 'Today\'s tasks are visible.' }],
              outOfScope: ['Reminders'],
              deferred: ['Sharing'],
            },
            stack: {
              client: 'React + TypeScript + Vite',
              server: 'Express',
              database: 'PostgreSQL',
              overrideReason: null,
            },
            deployment: {
              localSetup: 'npm run dev',
              migrations: 'node-pg-migrate',
              ci: 'unit tests',
              hosting: 'Document the deploy path.',
            },
            singlePr: { fitsSinglePr: true, rationale: 'One screen fits one pull request.' },
            confirmedBy: 'Ada',
            confirmedAt: '2026-10-05T17:00:00.000Z',
          },
          requesterId: 'user-1',
          reviewerId: 'reviewer-1',
          adoWorkItemId: 4521,
          prUrl: 'https://dev.azure.com/org/project/_git/todo/pullrequest/9',
          errorMessage: null,
          approvedAt: '2026-10-05T17:00:00.000Z',
          prOpenedAt: '2026-10-05T18:00:00.000Z',
          mergedAt: null,
          createdAt: '2026-10-05T16:00:00.000Z',
          updatedAt: '2026-10-05T18:00:00.000Z',
        },
        chatThreadId: 'thread-1',
        thread: null,
        design: null,
        history: [],
      },
      isLoading: false,
      isPending: false,
      isFetched: true,
      refetch: jest.fn(),
    });

    render(<AgentHome selectedProject="To Do App" />, { wrapper });

    expect(screen.getByTestId('product-build-setup')).toBeInTheDocument();
    expect(screen.queryByTestId('product-setup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('product-home')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-view-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-view-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-dashboard-root')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ready for review' })).toBeInTheDocument();
  });

  it('shows the app home after the latest build is live and does not open chat for other teams', () => {
    (useProductSetup as jest.Mock).mockReturnValue({
      data: {
        active: true,
        phase: 'build',
        skillPath: '.agents/skills/product-discovery/SKILL.md',
        model: 'gemini-3.8-flash',
        candidates: [],
        foundationAnswers: [],
        project: 'To Do App',
        build: {
          id: 'build-1',
          kind: 'initial',
          status: 'merged',
          project: 'To Do App',
          rfpRequestId: 'rfp-1',
          chatThreadId: 'thread-1',
          uiLabDesignId: 'design-1',
          prototypeVersion: 1,
          devSessionId: null,
          agentRunId: null,
          brief: null,
          requesterId: 'user-1',
          reviewerId: null,
          adoWorkItemId: null,
          prUrl: null,
          errorMessage: null,
          approvedAt: '2026-10-05T17:00:00.000Z',
          prOpenedAt: '2026-10-05T18:00:00.000Z',
          mergedAt: '2026-10-05T19:00:00.000Z',
          createdAt: '2026-10-05T16:00:00.000Z',
          updatedAt: '2026-10-05T19:00:00.000Z',
        },
        chatThreadId: 'thread-1',
        thread: null,
        design: {
          id: 'design-1',
          status: 'ready',
          html: '<html><body><h1>To Do</h1></body></html>',
        },
        history: [],
      },
      isLoading: false,
      isPending: false,
      isFetched: true,
      refetch: jest.fn(),
    });

    render(<AgentHome selectedProject="To Do App" />, { wrapper });

    expect(screen.getByTestId('product-home')).toBeInTheDocument();
    expect(screen.getByTestId('product-home-prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('product-build-setup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('home-view-chat')).not.toBeInTheDocument();
    expect(screen.getByTitle('Your app')).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('keeps the chat tab for projects that are not new products', () => {
    (useProductSetup as jest.Mock).mockReturnValue(inactiveSetup);
    render(<AgentHome selectedProject="MaxView" />, { wrapper });
    expect(screen.getByTestId('home-view-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('product-home')).not.toBeInTheDocument();
    expect(screen.queryByTestId('product-build-setup')).not.toBeInTheDocument();
  });
});
