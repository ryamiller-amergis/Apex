import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatThread } from '../../../shared/types/chat';
import { ChatAgentPanel } from '../ChatAgentPanel';

const mockRetryLast = jest.fn();
let mockSessionOverrides: Record<string, unknown> = {};

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: (_threadId: string | null, options?: { initialMessages?: ChatThread['messages'] }) => ({
    messages: options?.initialMessages ?? [],
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
    ...mockSessionOverrides,
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

jest.mock('../ThreadHistorySidebar', () => ({
  ThreadHistorySidebar: () => <div {...{ 'data-testid': 'thread-history-sidebar-mock' }}>Full history</div>,
}));

jest.mock('../agentChat', () => {
  const actual = jest.requireActual('../agentChat');
  return {
    ...actual,
    AgentComposer: ({
      testIdPrefix,
      model,
      onSend,
    }: {
      testIdPrefix: string;
      model?: string;
      onSend: () => void;
    }) => (
      <div {...{ 'data-testid': `${testIdPrefix}-composer-mock`, 'data-model': model }}>
        Composer
        <button type="button" onClick={onSend}>Send mock</button>
      </div>
    ),
  };
});

const thread: ChatThread = {
  id: 'thread-1',
  userId: 'user-1',
  status: 'idle',
  messages: [{ id: 'message-1', role: 'agent', text: 'Saved transcript', ts: '2026-08-31T10:00:00Z' }],
  kickoff: { project: 'Apex', repo: 'Apex', branch: 'main', model: 'auto' },
  workspaceDir: '/tmp/thread-1',
  flagged: false,
  createdAt: '2026-08-31T10:00:00Z',
  lastActivityAt: '2026-08-31T10:00:00Z',
};

describe('ChatAgentPanel shared Home shell', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    mockSessionOverrides = {};
    mockRetryLast.mockClear();
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
        onSelectThread={jest.fn()}
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

    fireEvent.click(screen.getByTestId('chat-agent-recent-see-all'));
    expect(screen.getByTestId('thread-history-sidebar-mock')).toBeInTheDocument();
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

  it('VT-06 starts a new thread independently of Close', () => {
    const onNewChat = jest.fn();
    render(<ChatAgentPanel thread={thread} isOpen onClose={jest.fn()} onNewChat={onNewChat} />);
    fireEvent.click(screen.getByTestId('chat-agent-new-chat-btn'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('TBI-006 DoD-1 applies a Home skill pill model and kickoff metadata', () => {
    const onNewChat = jest.fn();
    render(
      <ChatAgentPanel
        thread={null}
        isOpen
        onClose={jest.fn()}
        onNewChat={onNewChat}
        launchedFromHome
        selectedProject="Apex"
      />,
    );

    fireEvent.click(screen.getByTestId('chat-agent-skill-pill-to-prd'));
    expect(screen.getByTestId('chat-agent-composer-mock')).toHaveAttribute('data-model', 'auto');
    fireEvent.click(screen.getByRole('button', { name: 'Send mock' }));
    expect(onNewChat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'auto',
      quickSkill: expect.objectContaining({ label: 'Write PRD', skillPath: '/to-prd' }),
    }));
  });

  it('PBI-006 AC-1 renders a disconnected state and retries the connection', () => {
    mockSessionOverrides = { isConnected: false };
    render(<ChatAgentPanel thread={thread} isOpen onClose={jest.fn()} onNewChat={jest.fn()} />);

    expect(screen.getByText('○ Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Unable to connect')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-agent-retry-connection'));
    expect(mockRetryLast).toHaveBeenCalledTimes(1);
  });
});
