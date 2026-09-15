import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
  });
});
