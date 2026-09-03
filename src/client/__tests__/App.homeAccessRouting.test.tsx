import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

jest.mock('../components/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header" />,
}));

jest.mock('../components/AgentHome', () => ({
  AgentHome: (props: { canOpenChat?: boolean; onOpenChatPanel?: () => void }) => {
    mockAgentHomeProps = props;
    return (
      <div data-testid="agent-home">
        Agent Home Content
        <button type="button" onClick={props.onOpenChatPanel}>Toggle chat</button>
      </div>
    );
  },
}));

jest.mock('../components/ChatAgentPanel', () => ({
  ChatAgentPanel: (props: { isOpen?: boolean; onNewChat?: () => Promise<void> }) => {
    mockChatPanelProps = props;
    return props.isOpen ? (
      <div data-testid="chat-agent-panel-open">
        Chat open
        <button type="button" onClick={() => { void props.onNewChat?.(); }}>Panel new</button>
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
  canOpenChat?: boolean;
  onOpenChatPanel?: () => void;
} = {};
let mockChatPanelProps: {
  isOpen?: boolean;
  onNewChat?: () => Promise<void>;
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

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
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

  it('PBI-006 AC-0 opens the shared chat panel from the Home toggle', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      can: (key: string) => ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    renderApp('/home');

    expect(await screen.findByTestId('agent-home')).toBeInTheDocument();
    expect(mockAgentHomeProps.canOpenChat).toBe(true);
    expect(mockChatPanelProps.isOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle chat' }));
    expect(await screen.findByTestId('chat-agent-panel-open')).toBeInTheDocument();
  });

  it('resets to the empty composer without creating or auto-starting a thread', async () => {
    (useAppShell as jest.Mock).mockReturnValue(makeAppShell({
      can: (key: string) => ['home:view', 'chat:view', 'chat:create'].includes(key),
    }));
    renderApp('/home');

    fireEvent.click(await screen.findByRole('button', { name: 'Toggle chat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Panel new' }));

    expect(mockStartChatMutateAsync).not.toHaveBeenCalled();
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
