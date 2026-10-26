import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../App';
import { useAppShell } from '../hooks/useAppShell';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';
import { useChatThread, useSkillRepos, useStartChat } from '../hooks/useChatThreads';
import { useFeatureFlags } from '../hooks/useFeatureFlags';

jest.mock('../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../hooks/useProjectMenuConfig', () => ({
  useProjectMenuConfig: jest.fn(),
}));

jest.mock('../hooks/useChatThreads', () => ({
  useChatThread: jest.fn(),
  useSkillRepos: jest.fn(),
  useStartChat: jest.fn(),
}));

jest.mock('../hooks/useFeatureFlags', () => ({
  useFeatureFlags: jest.fn(),
  useFeatureFlag: jest.fn().mockReturnValue(false),
}));

jest.mock('../components/BetaAnnouncementModal', () => ({
  BetaAnnouncementModal: () => null,
}));

jest.mock('../components/GuidedWalkthroughHost', () => ({
  GuidedWalkthroughHost: () => null,
}));

jest.mock('../hooks/useProjectRepoConfigs', () => ({
  useProjectRepoConfigs: jest.fn().mockReturnValue({ data: [], isLoading: false, isFetched: true, isError: false }),
}));

jest.mock('../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn().mockReturnValue({ data: null }),
}));

jest.mock('../hooks/useUiLab', () => ({
  useUiLabSharedDesigns: jest.fn().mockReturnValue({ data: [], isLoading: false }),
}));

jest.mock('../hooks/useDocumentDeepLinkProject', () => ({
  useDocumentDeepLinkProject: () => ({
    link: null,
    project: undefined,
    pending: false,
    failed: false,
  }),
}));

jest.mock('../hooks/useProjects', () => ({
  useProjects: jest.fn().mockReturnValue({
    data: [{ id: '1', name: 'MaxView', description: '' }],
    isLoading: false,
  }),
}));

jest.mock('../components/AppHeader', () => ({
  AppHeader: (props: {
    onNavigateHome?: () => void;
    onNavigatePlaybooks?: () => void;
    onNavigateMcpServers?: () => void;
  }) => (
    <div data-testid="app-header">
      <button type="button" onClick={props.onNavigateHome}>Open Home</button>
      <button type="button" onClick={props.onNavigatePlaybooks}>Open Playbooks</button>
      <button type="button" onClick={props.onNavigateMcpServers}>Open MCP Servers</button>
    </div>
  ),
}));

jest.mock('../components/McpServersView', () => ({
  McpServersView: (props: {
    onStartChat?: (connection: { id: string; name: string }) => void;
    startChatError?: string | null;
  }) => (
    <div data-testid="mcp-servers-view">
      <button
        type="button"
        onClick={() => props.onStartChat?.({ id: 'conn-1', name: 'Docs' })}
      >
        Chat with MCP
      </button>
      {props.startChatError && (
        <p data-testid="mcp-servers-chat-error">{props.startChatError}</p>
      )}
    </div>
  ),
}));

jest.mock('../components/AgentHome', () => ({
  AgentHome: (props: {
    isActive?: boolean;
    onHomeViewChange?: (view: 'chat' | 'status') => void;
    onRestoreThread?: (id: string) => void;
  }) => {
    mockAgentHomeProps = props;
    const React = jest.requireActual<typeof import('react')>('react');
    const { isActive, onHomeViewChange } = props;
    React.useEffect(() => {
      if (isActive) onHomeViewChange?.('chat');
    }, [isActive, onHomeViewChange]);
    return (
      <div data-testid="agent-home">
        Agent Home Content
        <button type="button" onClick={() => props.onHomeViewChange?.('chat')}>Chat tab</button>
        <button type="button" onClick={() => props.onHomeViewChange?.('status')}>Status tab</button>
      </div>
    );
  },
}));

jest.mock('../components/ChatAgentPanel', () => ({
  ChatAgentPanel: (props: {
    thread?: { id: string; kickoff: { project: string } } | null;
    activeThreadId?: string | null;
    isOpen?: boolean;
    newChatError?: string;
    onNewChat?: (options?: { initialMessage?: string }) => Promise<void>;
    onSelectThread?: (id: string) => void;
  }) => {
    mockChatPanelProps = props;
    return props.isOpen ? (
      <div data-testid="chat-agent-panel-open">
        Chat open
        <button type="button" onClick={() => { void props.onNewChat?.(); }}>Panel new</button>
        <button
          type="button"
          onClick={() => { void props.onNewChat?.({ initialMessage: 'hello' }); }}
        >
          Start message
        </button>
        <button type="button" onClick={() => props.onSelectThread?.('history-thread')}>
          Select history
        </button>
      </div>
    ) : null;
  },
}));

jest.mock('../components/Changelog', () => ({
  Changelog: () => null,
}));

jest.mock('../components/AdminRoles', () => ({
  AdminRoles: () => <div>Roles Admin Content</div>,
}));

jest.mock('../components/AdminUsers', () => ({
  AdminUsers: () => <div>Users Admin Content</div>,
}));

jest.mock('../components/AdminGroups', () => ({
  AdminGroups: () => <div>Groups Admin Content</div>,
}));

jest.mock('../components/AdminProjectSettings', () => ({
  AdminProjectSettings: () => <div>Project Settings Admin Content</div>,
}));

jest.mock('../components/AdminMenuSettings', () => ({
  AdminMenuSettings: () => <div>Menu Visibility Admin Content</div>,
}));

jest.mock('react-dnd', () => ({
  DndProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('react-dnd-html5-backend', () => ({
  HTML5Backend: {},
}));

const mockedUseFeatureFlags = useFeatureFlags as jest.MockedFunction<typeof useFeatureFlags>;
let mockAgentHomeProps: {
  isActive?: boolean;
  onHomeViewChange?: (view: 'chat' | 'status') => void;
  onRestoreThread?: (id: string) => void;
} = {};
let mockChatPanelProps: {
  thread?: { id: string; kickoff: { project: string } } | null;
  activeThreadId?: string | null;
  isOpen?: boolean;
  newChatError?: string;
  onNewChat?: (options?: { initialMessage?: string }) => Promise<void>;
  onSelectThread?: (id: string) => void;
} = {};
const mockStartChatMutateAsync = jest.fn();

function makeAppShell(overrides: Record<string, unknown> = {}) {
  return {
    isAuthenticated: true,
    authenticatedUser: { name: 'Test User', email: 'test@example.com' },
    can: (key: string) => key === 'home:view',
    isInAnyGroup: () => false,
    userId: 'user-1',
    isSuperAdmin: false,
    isAdmin: false,
    groups: [],
    permissionsLoaded: true,
    workItems: [],
    error: null,
    isLoading: false,
    isSaving: false,
    selectedItem: null,
    setSelectedItem: jest.fn(),
    theme: 'light' as const,
    setThemeMode: jest.fn(),
    showChangelog: false,
    setShowChangelog: jest.fn(),
    hasUnreadChangelog: false,
    showChangelogOnLogin: false,
    handleMarkChangelogAsRead: jest.fn(),
    handleDismissWhatsNewBanner: jest.fn(),
    handleToggleShowChangelogOnLogin: jest.fn(),
    whatsNewLastSeenVersion: null,
    whatsNewManualUnavailable: false,
    whatsNewCurrentVersion: '1.0.0',
    whatsNewAutomaticOverlaySettled: true,
    whatsNewBlocksAutomaticWalkthrough: false,
    betaAnnouncementDismissed: false,
    handleDismissBetaAnnouncement: jest.fn(),
    handleLogout: jest.fn(),
    selectedProject: 'MaxView',
    selectedAreaPath: 'MaxView',
    availableProjects: ['MaxView'],
    changeProject: jest.fn(),
    changeAreaPath: jest.fn(),
    changeSkillSettings: jest.fn(),
    scheduledItems: [],
    unscheduledItems: [],
    pendingDueDateChange: null,
    handleDueDateChange: jest.fn(),
    handleConfirmDueDateChange: jest.fn(),
    handleCancelDueDateChange: jest.fn(),
    handleFieldUpdate: jest.fn(),
    selectedSkillSettingsId: null,
    ...overrides,
  };
}

function setupBase(flagsOverride: Record<string, boolean> = {}) {
  (useAppShell as jest.Mock).mockReturnValue(makeAppShell());
  (useProjectMenuConfig as jest.Mock).mockReturnValue({ enabledViews: [], isLoading: false });
  (useChatThread as jest.Mock).mockReturnValue({ data: null });
  (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useStartChat as jest.Mock).mockReturnValue({
    mutateAsync: mockStartChatMutateAsync,
    isPending: false,
    reset: jest.fn(),
  });
  mockedUseFeatureFlags.mockReturnValue({
    flags: { 'agent-home': true, ...flagsOverride },
    isLoading: false,
    data: { flags: { 'agent-home': true, ...flagsOverride } },
    isError: false,
    error: null,
    isPending: false,
    isSuccess: true,
    status: 'success',
    fetchStatus: 'idle',
    isFetching: false,
    isFetched: true,
    isRefetching: false,
    isStale: false,
    isPlaceholderData: false,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    refetch: jest.fn(),
    isLoadingError: false,
    isRefetchError: false,
  } as any);
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}{location.search}
    </output>
  );
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAgentHomeProps = {};
  mockChatPanelProps = {};
});

describe('App — Home access with permission + flag both enabled (default)', () => {
  beforeEach(() => setupBase());

  it('renders AgentHome at /home when both controls are enabled', async () => {
    renderApp('/home');
    expect(await screen.findByTestId('agent-home')).toBeInTheDocument();
  });

  it('opens shared chat by default and closes it on Project status', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      can: (key: string) => ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    renderApp('/home');

    expect(await screen.findByTestId('agent-home')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-agent-panel-open')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Status tab' }));
    expect(screen.queryByTestId('chat-agent-panel-open')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chat tab' }));
    expect(await screen.findByTestId('chat-agent-panel-open')).toBeInTheDocument();
  });

  it('resets to the empty composer without creating or auto-starting a thread', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      can: (key: string) => ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    renderApp('/home');

    fireEvent.click(await screen.findByRole('button', { name: 'Panel new' }));

    expect(mockStartChatMutateAsync).not.toHaveBeenCalled();
  });

  it('keeps the active Home thread in the URL without adding history entries', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      can: (key: string) => ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    (useSkillRepos as jest.Mock).mockReturnValue({
      data: [{ name: 'MaxView', defaultBranch: 'main' }],
      isLoading: false,
    });
    mockStartChatMutateAsync.mockResolvedValue({ threadId: 'created-thread' });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    try {
      renderApp('/home?help=walkthroughs');
      fireEvent.click(await screen.findByRole('button', { name: 'Start message' }));

      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toBe(
          '/home?help=walkthroughs&thread=created-thread',
        );
      });

      fireEvent.click(screen.getByRole('button', { name: 'Select history' }));
      expect(screen.getByTestId('location').textContent).toBe(
        '/home?help=walkthroughs&thread=history-thread',
      );

      fireEvent.click(screen.getByRole('button', { name: 'Panel new' }));
      expect(screen.getByTestId('location').textContent).toBe(
        '/home?help=walkthroughs',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not return to Home when chat creation finishes after navigation', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      isSuperAdmin: true,
      can: (key: string) => [
        'home:view',
        'chat:view',
        'chat:create',
        'playbooks:view',
        'mcp-servers:view',
      ].includes(key),
    }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: ['playbooks', 'mcp-servers'],
      isLoading: false,
    });
    (useSkillRepos as jest.Mock).mockReturnValue({
      data: [{ name: 'MaxView', defaultBranch: 'main' }],
      isLoading: false,
    });
    mockedUseFeatureFlags.mockReturnValue({
      flags: {
        'agent-home': true,
        'playbooks-production-adapters': true,
        'mcp-servers': true,
      },
      isLoading: false,
    } as any);
    let finishCreating!: (value: { threadId: string }) => void;
    mockStartChatMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        finishCreating = resolve;
      }),
    );

    renderApp('/home');
    fireEvent.click(await screen.findByRole('button', { name: 'Start message' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Playbooks' }));
    expect(screen.getByTestId('location').textContent).toBe('/playbooks');

    await act(async () => {
      finishCreating({ threadId: 'late-thread' });
      await Promise.resolve();
    });

    expect(screen.getByTestId('location').textContent).toBe('/playbooks');
  });

  it('does not show a MaxView thread after switching to Apex', async () => {
    let selectedProject = 'MaxView';
    (useAppShell as jest.Mock).mockImplementation(() => makeAppShell({
      selectedProject,
      selectedAreaPath: selectedProject,
      availableProjects: ['MaxView', 'Apex'],
      can: (key: string) =>
        ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    (useChatThread as jest.Mock).mockImplementation((threadId: string | null) => ({
      data: threadId === 'max-thread'
        ? {
            id: 'max-thread',
            userId: 'user-1',
            kickoff: { project: 'MaxView', repo: 'MaxView', branch: 'main' },
            messages: [],
            status: 'idle',
            workspaceDir: '',
            flagged: false,
            createdAt: '2026-09-03T18:00:00.000Z',
            lastActivityAt: '2026-09-03T18:00:00.000Z',
          }
        : null,
      isFetching: false,
    }));
    const view = renderApp('/home?thread=max-thread');

    await screen.findByTestId('agent-home');
    act(() => mockAgentHomeProps.onRestoreThread?.('max-thread'));
    expect(mockChatPanelProps.thread?.kickoff.project).toBe('MaxView');

    selectedProject = 'Apex';
    view.rerender(
      <MemoryRouter initialEntries={['/home']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(mockChatPanelProps.thread).toBeNull();
    expect(mockChatPanelProps.activeThreadId).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/home');
    });
  });

  it("restores the destination project's last thread after switching projects", async () => {
    let selectedProject = 'MaxView';
    (useAppShell as jest.Mock).mockImplementation(() => makeAppShell({
      selectedProject,
      selectedAreaPath: selectedProject,
      availableProjects: ['MaxView', 'Apex'],
      can: (key: string) =>
        ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    const threadFor = (id: string, project: string) => ({
      id,
      userId: 'user-1',
      kickoff: { project, repo: project, branch: 'main' },
      messages: [],
      status: 'idle',
      workspaceDir: '',
      flagged: false,
      createdAt: '2026-09-03T18:00:00.000Z',
      lastActivityAt: '2026-09-03T18:00:00.000Z',
    });
    (useChatThread as jest.Mock).mockImplementation((threadId: string | null) => ({
      data: threadId === 'max-thread'
        ? threadFor('max-thread', 'MaxView')
        : threadId === 'apex-thread'
          ? threadFor('apex-thread', 'Apex')
          : null,
      isFetching: false,
    }));
    sessionStorage.setItem('agentHomeThreadId:Apex', 'apex-thread');
    try {
      const view = renderApp('/home?thread=max-thread');
      await screen.findByTestId('agent-home');
      act(() => mockAgentHomeProps.onRestoreThread?.('max-thread'));

      selectedProject = 'Apex';
      view.rerender(
        <MemoryRouter initialEntries={['/home']}>
          <App />
          <LocationProbe />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(mockChatPanelProps.activeThreadId).toBe('apex-thread');
      });
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toBe('/home?thread=apex-thread');
      });
    } finally {
      sessionStorage.removeItem('agentHomeThreadId:Apex');
    }
  });

  it('stays on /mcp-servers when AgentHome attempts a thread restore off-route and resets to the Home landing page when Home is clicked', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      isSuperAdmin: true,
      can: (key: string) => [
        'home:view',
        'chat:view',
        'chat:create',
        'mcp-servers:view',
      ].includes(key),
    }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: ['mcp-servers'],
      isLoading: false,
    });
    mockedUseFeatureFlags.mockReturnValue({
      flags: {
        'agent-home': true,
        'mcp-servers': true,
      },
      isLoading: false,
    } as any);
    (useChatThread as jest.Mock).mockImplementation((threadId: string | null) => ({
      data: threadId === 'active-mcp-thread'
        ? {
            id: 'active-mcp-thread',
            userId: 'user-1',
            kickoff: { project: 'MaxView', repo: 'MaxView', branch: 'main' },
            messages: [],
            status: 'idle',
            workspaceDir: '',
            flagged: false,
            createdAt: '2026-09-03T18:00:00.000Z',
            lastActivityAt: '2026-09-03T18:00:00.000Z',
          }
        : null,
      isFetching: false,
    }));

    sessionStorage.setItem('agentHomeThreadId:MaxView', 'active-mcp-thread');
    try {
      renderApp('/home?thread=active-mcp-thread');
      await screen.findByTestId('agent-home');
      act(() => mockAgentHomeProps.onRestoreThread?.('active-mcp-thread'));
      expect(mockChatPanelProps.activeThreadId).toBe('active-mcp-thread');

      // Clicking MCP Servers navigates to /mcp-servers and stays there even if restore fires
      fireEvent.click(screen.getByRole('button', { name: 'Open MCP Servers' }));
      expect(screen.getByTestId('location').textContent).toBe('/mcp-servers');
      act(() => mockAgentHomeProps.onRestoreThread?.('active-mcp-thread'));
      expect(screen.getByTestId('location').textContent).toBe('/mcp-servers');

      // Clicking Home clears the active thread and lands on /home instead of /home?thread=...
      fireEvent.click(screen.getByRole('button', { name: 'Open Home' }));
      expect(screen.getByTestId('location').textContent).toBe('/home');
      expect(mockChatPanelProps.activeThreadId).toBeNull();
      expect(sessionStorage.getItem('agentHomeThreadId:MaxView')).toBeNull();
    } finally {
      sessionStorage.removeItem('agentHomeThreadId:MaxView');
    }
  });

  it('stays on MCP Servers when starting a chat fails', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      isSuperAdmin: true,
      can: (key: string) => [
        'home:view',
        'chat:view',
        'chat:create',
        'mcp-servers:view',
      ].includes(key),
    }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: ['mcp-servers'],
      isLoading: false,
    });
    (useSkillRepos as jest.Mock).mockReturnValue({
      data: [{ name: 'MaxView', defaultBranch: 'main' }],
      isLoading: false,
    });
    mockedUseFeatureFlags.mockReturnValue({
      flags: {
        'agent-home': true,
        'mcp-servers': true,
      },
      isLoading: false,
    } as any);
    let startChatError: Error | null = null;
    const resetStartChat = jest.fn(() => { startChatError = null; });
    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: mockStartChatMutateAsync,
      isPending: false,
      get error() { return startChatError; },
      reset: resetStartChat,
    });
    mockStartChatMutateAsync.mockImplementation(async () => {
      startChatError = new Error('Connection refused');
      throw startChatError;
    });

    renderApp('/mcp-servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with MCP' }));
    await waitFor(() => {
      expect(mockStartChatMutateAsync).toHaveBeenCalled();
    });
    expect(screen.getByTestId('location').textContent).toBe('/mcp-servers');
    expect(await screen.findByTestId('mcp-servers-chat-error')).toHaveTextContent('Connection refused');
    expect(screen.queryByTestId('chat-agent-panel-open')).not.toBeInTheDocument();
    expect(resetStartChat).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open Home' }));
    expect(screen.getByTestId('location').textContent).toBe('/home');
    expect(screen.queryByTestId('mcp-servers-chat-error')).not.toBeInTheDocument();
    expect(mockChatPanelProps.newChatError).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Open MCP Servers' }));
    expect(screen.getByTestId('location').textContent).toBe('/mcp-servers');
    expect(screen.queryByTestId('mcp-servers-chat-error')).not.toBeInTheDocument();
  });

  it('does not leak an in-flight MCP chat failure onto Home', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      isSuperAdmin: true,
      can: (key: string) => [
        'home:view',
        'chat:view',
        'chat:create',
        'mcp-servers:view',
      ].includes(key),
    }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: ['mcp-servers'],
      isLoading: false,
    });
    (useSkillRepos as jest.Mock).mockReturnValue({
      data: [{ name: 'MaxView', defaultBranch: 'main' }],
      isLoading: false,
    });
    mockedUseFeatureFlags.mockReturnValue({
      flags: {
        'agent-home': true,
        'mcp-servers': true,
      },
      isLoading: false,
    } as any);
    let startChatError: Error | null = null;
    const resetStartChat = jest.fn(() => { startChatError = null; });
    let rejectStartChat = (_error: Error) => {};
    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: mockStartChatMutateAsync,
      isPending: false,
      get error() { return startChatError; },
      reset: resetStartChat,
    });
    mockStartChatMutateAsync.mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectStartChat = (error: Error) => {
          startChatError = error;
          reject(error);
        };
      }),
    );

    renderApp('/mcp-servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with MCP' }));
    await waitFor(() => {
      expect(mockStartChatMutateAsync).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Home' }));
    expect(screen.getByTestId('location').textContent).toBe('/home');

    await act(async () => {
      rejectStartChat(new Error('Connection refused'));
    });
    expect(resetStartChat).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open Home' }));
    expect(mockChatPanelProps.newChatError).toBeUndefined();
    expect(screen.queryByTestId('mcp-servers-chat-error')).not.toBeInTheDocument();
  });

  it('does not keep an MCP chat failure after switching projects', async () => {
    const React = jest.requireActual<typeof import('react')>('react');
    let selectedProject = 'MaxView';
    (useAppShell as jest.Mock).mockImplementation(() => makeAppShell({
      isSuperAdmin: true,
      selectedProject,
      selectedAreaPath: selectedProject,
      availableProjects: ['MaxView', 'Apex'],
      can: (key: string) => [
        'home:view',
        'chat:view',
        'chat:create',
        'mcp-servers:view',
      ].includes(key),
    }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: ['mcp-servers'],
      isLoading: false,
    });
    (useSkillRepos as jest.Mock).mockReturnValue({
      data: [{ name: 'MaxView', defaultBranch: 'main' }],
      isLoading: false,
    });
    mockedUseFeatureFlags.mockReturnValue({
      flags: {
        'agent-home': true,
        'mcp-servers': true,
      },
      isLoading: false,
    } as any);
    let startChatError: Error | null = null;
    (useStartChat as jest.Mock).mockReturnValue({
      mutateAsync: mockStartChatMutateAsync,
      isPending: false,
      get error() { return startChatError; },
      reset: jest.fn(() => { startChatError = null; }),
    });
    mockStartChatMutateAsync.mockImplementation(async () => {
      startChatError = new Error('Connection refused');
      throw startChatError;
    });

    function Harness() {
      const [, setTick] = React.useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>Refresh shell</button>
          <App />
          <LocationProbe />
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={['/mcp-servers']}>
        <Harness />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Chat with MCP' }));
    expect(await screen.findByTestId('mcp-servers-chat-error')).toHaveTextContent('Connection refused');

    selectedProject = 'Apex';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh shell' }));
    expect(screen.queryByTestId('mcp-servers-chat-error')).not.toBeInTheDocument();
  });
});

describe('App — Home access when flag is disabled', () => {
  beforeEach(() => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell());
    (useProjectMenuConfig as jest.Mock).mockReturnValue({ enabledViews: ['calendar'], isLoading: false });
    (useChatThread as jest.Mock).mockReturnValue({ data: null });
    (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useStartChat as jest.Mock).mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    mockedUseFeatureFlags.mockReturnValue({
      flags: { 'agent-home': false },
      isLoading: false,
      isError: false,
      error: null,
      data: { flags: { 'agent-home': false } },
      isPending: false,
      isSuccess: true,
      status: 'success',
      fetchStatus: 'idle',
      isFetching: false,
      isFetched: true,
      isRefetching: false,
      isStale: false,
      isPlaceholderData: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      failureCount: 0,
      failureReason: null,
      refetch: jest.fn(),
      isLoadingError: false,
      isRefetchError: false,
    } as any);
  });

  it('does not render AgentHome content when agent-home flag is off', async () => {
    renderApp('/home');
    // AgentHome should not appear; the guard will redirect away from /home
    // (we verify AgentHome is absent, not the redirect target since jsdom
    //  routing effects may not settle synchronously in all test setups)
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('agent-home')).not.toBeInTheDocument();
  });
});

describe('App — Home access when permission is missing', () => {
  beforeEach(() => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({ can: () => false }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({ enabledViews: ['calendar'], isLoading: false });
    (useChatThread as jest.Mock).mockReturnValue({ data: null });
    (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useStartChat as jest.Mock).mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    mockedUseFeatureFlags.mockReturnValue({
      flags: { 'agent-home': true },
      isLoading: false,
      isError: false,
      error: null,
      data: { flags: { 'agent-home': true } },
      isPending: false,
      isSuccess: true,
      status: 'success',
      fetchStatus: 'idle',
      isFetching: false,
      isFetched: true,
      isRefetching: false,
      isStale: false,
      isPlaceholderData: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      failureCount: 0,
      failureReason: null,
      refetch: jest.fn(),
      isLoadingError: false,
      isRefetchError: false,
    } as any);
  });

  it('does not render AgentHome when home:view permission is absent', async () => {
    renderApp('/home');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('agent-home')).not.toBeInTheDocument();
  });
});

describe('App — loading state does not expose Home content prematurely', () => {
  beforeEach(() => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({ permissionsLoaded: false }));
    (useProjectMenuConfig as jest.Mock).mockReturnValue({ enabledViews: [], isLoading: true });
    (useChatThread as jest.Mock).mockReturnValue({ data: null });
    (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
    (useStartChat as jest.Mock).mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
    mockedUseFeatureFlags.mockReturnValue({
      flags: {},
      isLoading: true,
      isError: false,
      error: null,
      data: undefined,
      isPending: true,
      isSuccess: false,
      status: 'pending',
      fetchStatus: 'fetching',
      isFetching: true,
      isFetched: false,
      isRefetching: false,
      isStale: false,
      isPlaceholderData: false,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      failureCount: 0,
      failureReason: null,
      refetch: jest.fn(),
      isLoadingError: false,
      isRefetchError: false,
    } as any);
  });

  it('withholds AgentHome while access controls are still loading', () => {
    renderApp('/home');
    expect(screen.queryByTestId('agent-home')).not.toBeInTheDocument();
  });
});
