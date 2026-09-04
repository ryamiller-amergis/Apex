import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatThread } from '../../../shared/types/chat';
import { ChatAgentPanel } from '../ChatAgentPanel';

const mockRetryLast = jest.fn();
const mockSend = jest.fn();
let mockSessionOverrides: Record<string, unknown> = {};

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: (_threadId: string | null, options?: { initialMessages?: ChatThread['messages'] }) => ({
    messages: options?.initialMessages ?? [],
    streamingText: '',
    isConnected: true,
    prdReady: false,
    isRunning: false,
    isSending: false,
    isCancelling: false,
    isAwaitingAgentResponse: false,
    isInteractionBusy: false,
    status: 'idle',
    progressLabel: null,
    showTypingIndicator: false,
    sendError: null,
    send: mockSend,
    cancel: jest.fn(),
    retryLast: mockRetryLast,
    ...mockSessionOverrides,
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillList: () => ({
    data: [{ id: '1', name: 'to-prd', description: 'Generate a PRD from interview notes', path: '/to-prd' }],
  }),
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
      value,
      onChange,
      onSend,
      onCancel,
      canSend,
      isRunning,
      isCancelling,
      after,
    }: {
      testIdPrefix: string;
      model?: string;
      value?: string;
      onChange?: (value: string) => void;
      onSend: () => void;
      onCancel?: () => void;
      canSend?: boolean;
      isRunning?: boolean;
      isCancelling?: boolean;
      after?: React.ReactNode;
    }) => (
      <div {...{ 'data-testid': `${testIdPrefix}-composer-mock`, 'data-model': model }}>
        Composer
        <textarea
          data-testid={`${testIdPrefix}-message-input`}
          value={value ?? ''}
          onChange={(event) => onChange?.(event.target.value)}
        />
        <button type="button" onClick={onSend} disabled={canSend === false}>Send mock</button>
        {isRunning && onCancel && (
          <button type="button" onClick={onCancel} disabled={isCancelling}>
            {isCancelling ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {after}
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
    mockSend.mockClear();
  });

  afterEach(() => {
    (global as unknown as { fetch?: typeof fetch }).fetch = undefined;
  });

  it('TBI-006 DoD-1 shows Home-only pills and opens full history from the header', () => {
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
    expect(screen.queryByLabelText('Recent Threads')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-agent-history-btn'));
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

  it('shows immediate stopping feedback after Stop is requested', () => {
    mockSessionOverrides = {
      isRunning: true,
      isCancelling: true,
      status: 'running',
    };
    render(
      <ChatAgentPanel
        thread={{ ...thread, status: 'running', activeRunId: 'run-1' }}
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('shows Stop while a sent turn is waiting for running status', () => {
    mockSessionOverrides = {
      isRunning: false,
      isAwaitingAgentResponse: true,
      isInteractionBusy: true,
      showTypingIndicator: true,
      status: 'idle',
    };
    render(
      <ChatAgentPanel
        thread={thread}
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByTestId('chat-run-spinner')).toBeInTheDocument();
  });

  it('labels history loading without showing agent thinking', () => {
    render(
      <ChatAgentPanel
        thread={null}
        activeThreadId="thread-history"
        isLoadingThread
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
      />,
    );

    expect(screen.getByTestId('chat-agent-history-loading')).toHaveTextContent(
      'Loading conversation…',
    );
    expect(screen.queryByTestId('chat-run-spinner')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent is thinking…')).not.toBeInTheDocument();
  });

  it('shows a saved agent response as ready even if raw status is still running', () => {
    mockSessionOverrides = {
      isRunning: false,
      isSending: false,
      isAwaitingAgentResponse: false,
      isInteractionBusy: false,
      showTypingIndicator: false,
      status: 'running',
    };
    render(
      <ChatAgentPanel
        thread={{ ...thread, status: 'running', activeRunId: 'run-finishing' }}
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
      />,
    );

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Agent is thinking…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
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
    expect(screen.getByTestId('chat-agent-pill-description')).toHaveTextContent(
      'Generate a PRD from interview notes',
    );
    expect(screen.getByTestId('chat-agent-compose-armed-hint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send mock' })).toBeDisabled();
    fireEvent.change(screen.getByTestId('chat-agent-message-input'), {
      target: { value: 'Turn my interview into a PRD' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send mock' }));
    expect(onNewChat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'auto',
      initialMessage: 'Turn my interview into a PRD',
      quickSkill: expect.objectContaining({ label: 'Write PRD', skillPath: '/to-prd' }),
    }));
  });

  it('keeps the Home skill context while a new thread is bootstrapping', () => {
    const bootstrappingThread: ChatThread = {
      ...thread,
      id: 'thread-bootstrapping',
      messages: [],
      kickoff: {
        ...thread.kickoff,
        skillPath: '/to-prd',
        pillLabel: 'Write PRD',
        pillDescription: 'Generate a PRD from interview notes',
      },
    };
    render(
      <ChatAgentPanel
        thread={bootstrappingThread}
        activeThreadId="thread-bootstrapping"
        isLoadingThread
        isStartingNewChat
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
        launchedFromHome
        selectedProject="Apex"
      />,
    );

    expect(screen.queryByText('No conversation yet')).not.toBeInTheDocument();
    expect(screen.getByText('Agent is thinking…')).toBeInTheDocument();
    expect(screen.getByTestId('chat-agent-skill-pill-to-prd')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('chat-agent-pill-description')).toHaveTextContent(
      'Generate a PRD from interview notes',
    );
    expect(screen.getByTestId('chat-run-spinner')).toBeInTheDocument();
  });

  it('lets an active Home conversation select a skill for its next message', () => {
    render(
      <ChatAgentPanel
        thread={thread}
        isOpen
        onClose={jest.fn()}
        onNewChat={jest.fn()}
        launchedFromHome
        selectedProject="Apex"
      />,
    );

    const skillPill = screen.getByTestId('chat-agent-skill-pill-to-prd');
    expect(skillPill).toBeEnabled();
    fireEvent.click(skillPill);
    expect(skillPill).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Write PRD selected for the next message/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('chat-agent-message-input'), {
      target: { value: 'Summarize the requirements' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send mock' }));

    expect(mockSend).toHaveBeenCalledWith('Summarize the requirements', {
      model: 'auto',
      attachments: [],
      skill: { name: 'Write PRD', path: '/to-prd' },
    });
  });

  it('explains an empty transcript instead of rendering a blank pane', () => {
    const emptyThread: ChatThread = {
      ...thread,
      messages: [{ id: 'kickoff', role: 'user', text: 'Begin.', ts: '2026-08-31T10:00:00Z' }],
    };
    render(<ChatAgentPanel thread={emptyThread} isOpen onClose={jest.fn()} onNewChat={jest.fn()} />);

    expect(screen.getByTestId('chat-agent-empty-transcript')).toBeInTheDocument();
    expect(screen.getByText('No messages in this conversation')).toBeInTheDocument();
    expect(screen.getByText('No messages')).toBeInTheDocument();
    expect(screen.queryByText('Starting skill…')).not.toBeInTheDocument();
  });

  it('surfaces the failed run behind an empty transcript', () => {
    const failedThread: ChatThread = {
      ...thread,
      messages: [],
      lastError: 'Worker lost (heartbeat expired)',
    };
    render(<ChatAgentPanel thread={failedThread} isOpen onClose={jest.fn()} onNewChat={jest.fn()} />);

    expect(
      screen.getByText(/The last agent run did not finish: Worker lost \(heartbeat expired\)/),
    ).toBeInTheDocument();
  });

  it('keeps the starting-skill status while a new thread is still working', () => {
    mockSessionOverrides = { showTypingIndicator: true };
    const startingThread: ChatThread = { ...thread, messages: [] };
    render(<ChatAgentPanel thread={startingThread} isOpen onClose={jest.fn()} onNewChat={jest.fn()} />);

    expect(screen.queryByTestId('chat-agent-empty-transcript')).not.toBeInTheDocument();
    expect(screen.getByText('Starting skill…')).toBeInTheDocument();
  });

  it('PBI-006 AC-1 keeps the transcript visible while disconnected', () => {
    mockSessionOverrides = { isConnected: false };
    render(<ChatAgentPanel thread={thread} isOpen onClose={jest.fn()} onNewChat={jest.fn()} />);

    expect(screen.getByText('○ Disconnected')).toBeInTheDocument();
    expect(screen.getByTestId('chat-agent-connection-banner')).toBeInTheDocument();
    expect(screen.getByText('Saved transcript')).toBeInTheDocument();
    expect(screen.getByTestId('chat-agent-composer-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-agent-retry-connection')).not.toBeInTheDocument();
    expect(mockRetryLast).not.toHaveBeenCalled();
  });
});
