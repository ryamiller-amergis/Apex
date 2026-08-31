import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatThread } from '../../../shared/types/chat';
import { ChatAgentPanel } from '../ChatAgentPanel';

const mockRetryLast = jest.fn();

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    messages: [],
    streamingText: '',
    isConnected: true,
    prdReady: false,
    isRunning: false,
    status: 'idle',
    progressLabel: null,
    showTypingIndicator: false,
    send: jest.fn(),
    cancel: jest.fn(),
    retryLast: mockRetryLast,
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useChatThreadList: () => ({
    data: [
      { id: 'one', title: 'First', lastActivityAt: '2026-08-31T10:00:00Z' },
      { id: 'two', title: 'Second', lastActivityAt: '2026-08-31T09:00:00Z' },
      { id: 'three', title: 'Third', lastActivityAt: '2026-08-31T08:00:00Z' },
      { id: 'four', title: 'Fourth', lastActivityAt: '2026-08-31T07:00:00Z' },
    ],
  }),
  useSkillList: () => ({ data: [] }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({ data: [], isLoading: false }),
  useGlobalDefaultModel: () => ({ data: { value: 'auto' } }),
  useProjectSkillConfig: () => ({
    data: {
      quickSkillPills: [{ label: 'Write PRD', skillPath: '/to-prd', model: 'auto' }],
      quickMcpPills: [{ label: 'ADO', mcpServerName: 'ado', model: 'auto' }],
    },
  }),
}));

jest.mock('../../hooks/useChatAttachments', () => ({
  useChatAttachments: () => ({
    attachments: [],
    attachmentError: null,
    addFiles: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
  }),
}));

jest.mock('../../hooks/useFocusChatMessage', () => ({
  useFocusChatMessage: () => undefined,
}));

jest.mock('../agentChat', () => {
  const actual = jest.requireActual('../agentChat');
  return {
    ...actual,
    AgentComposer: ({ testIdPrefix }: { testIdPrefix: string }) => (
      <div {...{ 'data-testid': `${testIdPrefix}-composer-mock` }}>Composer</div>
    ),
  };
});

const thread: ChatThread = {
  id: 'thread-1',
  title: 'Existing conversation',
  status: 'idle',
  messages: [{ id: 'message-1', role: 'agent', text: 'Saved transcript', ts: '2026-08-31T10:00:00Z' }],
  kickoff: { project: 'Apex', repo: 'Apex', branch: 'main', model: 'auto' },
  createdAt: '2026-08-31T10:00:00Z',
  updatedAt: '2026-08-31T10:00:00Z',
};

describe('ChatAgentPanel shared Home shell', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    (global as unknown as { fetch?: typeof fetch }).fetch = undefined;
  });

  it('TBI-006 DoD-1 shows Home-only pills and the top three recent threads', () => {
    render(
      <ChatAgentPanel
        thread={null}
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
        launchedFromHome
        selectedProject="Apex"
      />,
    );

    expect(screen.getByTestId('agent-slideout-shell')).toBeInTheDocument();
    expect(screen.getByText('Write PRD')).toBeInTheDocument();
    expect(screen.getByText('ADO')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
    expect(screen.queryByText('Fourth')).not.toBeInTheDocument();
  });

  it('PBI-007 AC-3 excludes Home-only content outside Home', () => {
    render(
      <ChatAgentPanel
        thread={null}
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
        launchedFromHome={false}
      />,
    );
    expect(screen.queryByLabelText('Home chat shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Recent Threads')).not.toBeInTheDocument();
  });

  it('PBI-006 AC-2 closes without deleting and preserves the transcript on reopen', () => {
    const onClose = jest.fn();
    const { rerender } = render(
      <ChatAgentPanel thread={thread} isOpen onClose={onClose} onNewChat={jest.fn()} />,
    );
    fireEvent.click(screen.getByTestId('chat-agent-close-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/chat/threads/thread-1'),
      expect.objectContaining({ method: 'DELETE' }),
    );

    rerender(<ChatAgentPanel thread={thread} isOpen={false} onClose={onClose} onNewChat={jest.fn()} />);
    rerender(<ChatAgentPanel thread={thread} isOpen onClose={onClose} onNewChat={jest.fn()} />);
    expect(screen.getByText('Saved transcript')).toBeInTheDocument();
  });
});
