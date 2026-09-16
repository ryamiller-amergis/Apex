import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { AgentHome } from '../AgentHome';

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

const mockSkillConfig = jest.fn(() => ({ data: null }));
jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: () => mockSkillConfig(),
}));

jest.mock('../../hooks/useFoundationSkillUpdateStatus', () => ({
  useLatestFoundationSkillRelease: () => ({
    data: {
      id: 'rel-1',
      version: '2.1.0',
      artifactVersion: '2.1.0',
      artifactFeed: null,
      selectedSkills: ['adr-interview'],
      targetProjects: ['MaxView'],
      skillTargets: {},
      projectNotes: {},
      releaseNotes: null,
      breakingChanges: null,
    },
  }),
  useFoundationSkillRepoStatus: () => ({
    data: { installedVersion: null, availableVersion: '2.1.0', updateAvailable: true },
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

describe('AgentHome tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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

  it('shows the foundation skills banner to an admin once the project has a skill repo', () => {
    mockSkillConfig.mockReturnValue({
      data: { skillRepo: 'MaxView', skillBranch: 'development', skillProvider: 'ado' },
    } as never);

    const { rerender } = render(
      <AgentHome selectedProject="MaxView" isAdmin />,
      { wrapper },
    );
    expect(screen.getByTestId('agent-home-foundation-skill-banner')).toBeInTheDocument();

    rerender(<AgentHome selectedProject="MaxView" />);
    expect(screen.queryByTestId('agent-home-foundation-skill-banner')).not.toBeInTheDocument();

    mockSkillConfig.mockReturnValue({ data: null });
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
