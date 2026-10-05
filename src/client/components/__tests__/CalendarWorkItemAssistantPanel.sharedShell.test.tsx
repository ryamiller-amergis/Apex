import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CalendarWorkItemAssistantPanel } from '../CalendarWorkItemAssistantPanel';

jest.mock('../../hooks/useCalendarWorkItemAssistant', () => ({
  useWorkItemHierarchy: () => ({ data: { nodes: [] }, isLoading: false, error: null }),
  useCreateSession: () => ({ mutateAsync: jest.fn(), isPending: false, error: null }),
  useSessionWithProposal: () => ({ data: null }),
  useCalendarAssistantChat: () => ({
    status: 'idle',
    messages: [],
    streamingText: '',
    toolProgress: [],
    sendMessage: jest.fn(),
    cancelRun: jest.fn(),
  }),
  useScopeSelection: () => ({
    selected: new Set([101]),
    selectedArray: [101],
    toggle: jest.fn(),
    selectAll: jest.fn(),
    clearAll: jest.fn(),
    isAtLimit: false,
  }),
}));

jest.mock('../agentChat', () => {
  const actual = jest.requireActual('../agentChat');
  return {
    ...actual,
    AgentComposer: () => <div>Calendar composer</div>,
  };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('CalendarWorkItemAssistantPanel shared shell', () => {
  it('TBI-007 DoD-0 uses the fixed shared frame and preserves scope actions', () => {
    render(
      <CalendarWorkItemAssistantPanel
        anchorWorkItemId={101}
        anchorTitle="Feature"
        project="Apex"
        areaPath="Apex"
        open
        onClose={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByTestId('agent-slideout-shell')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-assistant-panel')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-assistant-start-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-assistant-minimize-btn')).not.toBeInTheDocument();
  });

  it('PBI-007 AC-3 contains no Home skill, MCP, or recent-thread content', () => {
    render(
      <CalendarWorkItemAssistantPanel
        anchorWorkItemId={101}
        anchorTitle="Feature"
        project="Apex"
        areaPath="Apex"
        open
        onClose={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.queryByLabelText('Home chat shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Recent Threads')).not.toBeInTheDocument();
  });
});
