import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatAttachment, ChatThread } from '../../../shared/types/chat';
import { ChatAgentPanel } from '../ChatAgentPanel';

const mockSend = jest.fn();
const mockAddFiles = jest.fn();
const mockRemoveAttachment = jest.fn();
const mockClearAttachments = jest.fn();
const mockSpeechToggle = jest.fn();

let mockAttachments: ChatAttachment[] = [];
let mockSpeechState = {
  isListening: false,
  isSpeechSupported: true,
  speechError: null as string | null,
};

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: (_threadId: string | null, options?: { initialMessages?: ChatThread['messages'] }) => ({
    messages: options?.initialMessages ?? [],
    streamingText: '',
    isConnected: true,
    hasConnectionError: false,
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
    retryLast: jest.fn(),
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillList: () => ({ data: [] }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({ data: [], isLoading: false }),
  useGlobalDefaultModel: () => ({ data: { value: 'auto' } }),
  useProjectSkillConfig: () => ({ data: { quickSkillPills: [], quickMcpPills: [] } }),
}));

jest.mock('../../hooks/useChatAttachments', () => {
  const actual = jest.requireActual('../../hooks/useChatAttachments');
  return {
    ...actual,
    useChatAttachments: () => ({
      attachments: mockAttachments,
      attachmentError: null,
      addFiles: mockAddFiles,
      removeAttachment: mockRemoveAttachment,
      clearAttachments: mockClearAttachments,
    }),
  };
});

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: (onTranscript: (text: string) => void) => {
    mockSpeechToggle.mockImplementation(() => onTranscript('spoken text'));
    return {
      ...mockSpeechState,
      toggle: mockSpeechToggle,
      stop: jest.fn(),
    };
  },
}));

jest.mock('../../hooks/useFocusChatMessage', () => ({
  useFocusChatMessage: () => undefined,
}));

jest.mock('../ThreadHistorySidebar', () => ({
  ThreadHistorySidebar: () => <div>Full history</div>,
}));

const attachment: ChatAttachment = {
  id: 'attachment-1',
  name: 'requirements.md',
  type: 'text/markdown',
  size: 2048,
  content: '# Requirements',
};

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

function renderHomeCompose(onNewChat = jest.fn()) {
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
  return onNewChat;
}

describe('ChatAgentPanel composer tools', () => {
  beforeEach(() => {
    mockAttachments = [];
    mockSpeechState = { isListening: false, isSpeechSupported: true, speechError: null };
    mockSend.mockClear();
    mockAddFiles.mockClear();
    mockRemoveAttachment.mockClear();
    mockClearAttachments.mockClear();
    mockSpeechToggle.mockReset();
  });

  it('offers attach and voice controls on the Home compose composer', () => {
    renderHomeCompose();

    expect(screen.getByTestId('chat-agent-attach')).toBeEnabled();
    expect(screen.getByTestId('chat-agent-microphone')).toBeEnabled();
  });

  it('offers attach and voice controls inside an active conversation', () => {
    render(<ChatAgentPanel thread={thread} isOpen onClose={jest.fn()} onNewChat={jest.fn()} />);

    expect(screen.getByTestId('chat-agent-attach')).toBeEnabled();
    expect(screen.getByTestId('chat-agent-microphone')).toBeEnabled();
  });

  it('lists a pending attachment on the Home compose composer', () => {
    mockAttachments = [attachment];
    renderHomeCompose();

    expect(screen.getByText('requirements.md')).toBeInTheDocument();
  });

  it('sends Home attachments with the first message so the agent has them in context', () => {
    mockAttachments = [attachment];
    const onNewChat = renderHomeCompose();

    fireEvent.change(screen.getByTestId('chat-agent-message-input'), {
      target: { value: 'Review this' },
    });
    fireEvent.click(screen.getByTestId('chat-agent-send-btn'));

    expect(onNewChat).toHaveBeenCalledWith(expect.objectContaining({
      initialMessage: 'Review this',
      attachments: [attachment],
    }));
    expect(mockClearAttachments).toHaveBeenCalled();
  });

  it('starts a Home thread from attachments alone', () => {
    mockAttachments = [attachment];
    const onNewChat = renderHomeCompose();

    fireEvent.click(screen.getByTestId('chat-agent-send-btn'));

    expect(onNewChat).toHaveBeenCalledWith(expect.objectContaining({
      initialMessage: 'Please use the attached files as additional context.',
      attachments: [attachment],
    }));
  });

  it('transcribes speech into the composer input', () => {
    renderHomeCompose();

    fireEvent.click(screen.getByTestId('chat-agent-microphone'));

    expect(screen.getByTestId('chat-agent-message-input')).toHaveValue('spoken text');
  });

  it('disables the microphone when the browser cannot transcribe', () => {
    mockSpeechState = { isListening: false, isSpeechSupported: false, speechError: null };
    renderHomeCompose();

    expect(screen.getByTestId('chat-agent-microphone')).toBeDisabled();
  });
});
