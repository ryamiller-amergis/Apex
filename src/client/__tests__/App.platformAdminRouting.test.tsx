import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { useAppShell } from '../hooks/useAppShell';
import { useProjectMenuConfig } from '../hooks/useProjectMenuConfig';
import { useChatThread, useSkillRepos, useStartChat } from '../hooks/useChatThreads';

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

jest.mock('../hooks/useProjectRepoConfigs', () => ({
  useProjectRepoConfigs: jest.fn().mockReturnValue({ data: [], isLoading: false, isSuccess: true }),
}));

jest.mock('../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn().mockReturnValue({ data: null }),
}));

jest.mock('../components/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header" />,
}));

jest.mock('../components/AgentHome', () => ({
  AgentHome: () => <div>Agent Home Content</div>,
}));

jest.mock('../components/ChatAgentPanel', () => ({
  ChatAgentPanel: () => null,
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

function setupAppShell() {
  (useAppShell as jest.Mock).mockReturnValue({
    isAuthenticated: true,
    authenticatedUser: { name: 'Super Admin', email: 'admin@example.com' },
    can: (key: string) => key === 'admin:roles',
    isSuperAdmin: true,
    permissionsLoaded: true,
    workItems: [],
    error: null,
    isLoading: false,
    isSaving: false,
    selectedItem: null,
    setSelectedItem: jest.fn(),
    theme: 'light',
    setThemeMode: jest.fn(),
    showChangelog: false,
    setShowChangelog: jest.fn(),
    hasUnreadChangelog: false,
    showChangelogOnLogin: false,
    handleMarkChangelogAsRead: jest.fn(),
    handleToggleShowChangelogOnLogin: jest.fn(),
    handleLogout: jest.fn(),
    selectedProject: 'MaxView',
    selectedAreaPath: 'MaxView',
    availableProjects: ['MaxView'],
    changeProject: jest.fn(),
    changeAreaPath: jest.fn(),
    scheduledItems: [],
    unscheduledItems: [],
    pendingDueDateChange: null,
    handleDueDateChange: jest.fn(),
    handleConfirmDueDateChange: jest.fn(),
    handleCancelDueDateChange: jest.fn(),
    handleFieldUpdate: jest.fn(),
  });
  (useProjectMenuConfig as jest.Mock).mockReturnValue({
    enabledViews: ['calendar', 'planning', 'cloudcost', 'backlog'],
    isLoading: false,
  });
  (useChatThread as jest.Mock).mockReturnValue({ data: null });
  (useSkillRepos as jest.Mock).mockReturnValue({ data: [], isLoading: false });
  (useStartChat as jest.Mock).mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App platform admin routing changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupAppShell();
  });

  it('does not show the old Menu Visibility tab in in-project admin', async () => {
    renderApp('/admin/roles');

    expect(await screen.findByText('Roles Admin Content')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /menu visibility/i })).not.toBeInTheDocument();
  });

  it('does not render AdminMenuSettings from /admin/menu-settings', async () => {
    renderApp('/admin/menu-settings');

    expect(await screen.findByText('Roles Admin Content')).toBeInTheDocument();
    expect(screen.queryByText('Menu Visibility Admin Content')).not.toBeInTheDocument();
  });
});
