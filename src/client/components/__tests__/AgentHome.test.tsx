import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentHome } from '../AgentHome';

jest.mock('../../hooks/useHomeDashboard', () => ({
  useHomeDashboard: () => ({
    data: {
      incompletePipeline: null,
      artifactCycleTime: null,
      myWork: null,
      openBugsOnPbis: null,
      devToProduction: null,
    },
    isLoading: false,
    refetch: jest.fn(),
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

describe('AgentHome dashboard and chat toggle', () => {
  beforeEach(() => sessionStorage.clear());

  it('TBI-006 DoD-0 renders the dashboard instead of inline chat', () => {
    render(<AgentHome selectedProject="Apex" />, { wrapper });
    expect(screen.getByTestId('home-dashboard-root')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-home-composer')).not.toBeInTheDocument();
  });

  it('PBI-006 AC-0 opens chat from the right edge', () => {
    const onOpenChatPanel = jest.fn();
    render(
      <AgentHome
        selectedProject="Apex"
        canOpenChat
        onOpenChatPanel={onOpenChatPanel}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId('home-chat-toggle-btn'));
    expect(onOpenChatPanel).toHaveBeenCalledTimes(1);
  });

  it('PBI-006 AC-3 hides the toggle without chat access', () => {
    render(<AgentHome selectedProject="Apex" canOpenChat={false} onOpenChatPanel={jest.fn()} />, { wrapper });
    expect(screen.queryByTestId('home-chat-toggle-btn')).not.toBeInTheDocument();
  });

  it('BR-015 absorbs a saved Home thread into App-level identity on first load', () => {
    sessionStorage.setItem('agentHomeThreadId:Apex', 'thread-saved');
    const onRestoreThread = jest.fn();
    const onOpenChatPanel = jest.fn();
    render(
      <AgentHome
        selectedProject="Apex"
        canOpenChat
        onRestoreThread={onRestoreThread}
        onOpenChatPanel={onOpenChatPanel}
      />,
      { wrapper },
    );
    expect(onRestoreThread).toHaveBeenCalledWith('thread-saved');
    expect(onOpenChatPanel).toHaveBeenCalledTimes(1);
  });
});
