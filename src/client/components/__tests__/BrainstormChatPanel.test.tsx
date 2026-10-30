import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrainstormChatPanel, retryableBrainstormMessage } from '../BrainstormChatPanel';
import { useBrainstormChat } from '../../hooks/useBrainstormChat';
import { useBrainstormMessages } from '../../hooks/useBrainstormSessions';
import type { BrainstormMessageDto, BrainstormSessionDetail } from '../../../shared/types/brainstorm';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../hooks/useBrainstormChat', () => ({ useBrainstormChat: jest.fn() }));
jest.mock('../../hooks/useBrainstormSessions', () => ({ useBrainstormMessages: jest.fn() }));
jest.mock('../../hooks/useBrainstormSources', () => ({
  useBrainstormSources: () => ({ data: [] }),
  useBrainstormCitations: () => ({ data: [] }),
}));
const switchTypeMutateAsync = jest.fn().mockResolvedValue({ kind: 'set' });
jest.mock('../../hooks/useBrainstormArtifact', () => ({
  useBrainstormArtifact: () => ({
    data: { id: null, sessionId: 's-1', type: null, markdown: '', version: 0, updatedAt: null, lastOrigin: null, lastChangeFailure: null },
  }),
  useSwitchArtifactType: () => ({
    mutateAsync: (...args: unknown[]) => switchTypeMutateAsync(...args),
    isPending: false,
  }),
}));
jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({
    data: [
      { id: 'm', displayName: 'Model M' },
      { id: 'gemini-4-argon-medium', displayName: 'Gemini 4 Argon Medium' },
    ],
    isLoading: false,
  }),
}));

const chatHook = useBrainstormChat as jest.Mock;
const messagesHook = useBrainstormMessages as jest.Mock;

const session: BrainstormSessionDetail = {
  id: 's-1',
  title: null,
  creatorId: 'creator',
  creatorName: 'Ada',
  state: 'active',
  model: 'm',
  artifactType: null,
  lastActivityAt: '2026-10-29T10:00:00.000Z',
  createdAt: '2026-10-29T10:00:00.000Z',
  canMutate: true,
  threadId: 't-1',
  version: 1,
  failureReason: null,
};

function msg(overrides: Partial<BrainstormMessageDto>): BrainstormMessageDto {
  return {
    id: 'm',
    role: 'assistant',
    content: '',
    status: 'completed',
    runId: null,
    turnId: 'turn-1',
    failureCode: null,
    failureSummary: null,
    retryOfMessageId: null,
    supersededByMessageId: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function chat(overrides: Record<string, unknown> = {}) {
  return {
    streamingText: '',
    status: 'idle',
    isInteractionBusy: false,
    isRunning: false,
    isCancelling: false,
    sendError: null,
    send: jest.fn().mockResolvedValue(true),
    retryFailedRun: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn(),
    ...overrides,
  };
}

function messages(data: BrainstormMessageDto[], refetch = jest.fn().mockResolvedValue(undefined)) {
  return { data, isLoading: false, isError: false, refetch };
}

const failed = msg({
  id: 'a-1',
  status: 'failed',
  runId: 'run-1',
  content: 'Partial',
  failureCode: 'model_error',
  failureSummary: 'The model returned an error before finishing.',
});

describe('BrainstormChatPanel (VT-29)', () => {
  it('shows the empty prompt and focuses the composer for the creator', () => {
    chatHook.mockReturnValue(chat());
    messagesHook.mockReturnValue(messages([]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getByTestId('brainstorm-chat-empty')).toHaveTextContent('Describe your idea to get started');
    expect(screen.getByTestId('brainstorm-composer-input')).toHaveFocus();
    expect(screen.getByTestId('brainstorm-composer-send')).toBeDisabled();
  });

  it('PBI-002 (a): streams the collaborator reply into a polite live region', () => {
    chatHook.mockReturnValue(chat({ streamingText: 'Here is a first idea', status: 'running' }));
    messagesHook.mockReturnValue(messages([
      msg({ id: 'u-1', role: 'user', content: 'An idea' }),
      msg({ id: 'a-1', status: 'streaming', runId: 'run-1' }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    const live = screen.getByTestId('brainstorm-streaming');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Here is a first idea');
  });

  it('shows the agent step and a busy marker while the reply is still empty', () => {
    chatHook.mockReturnValue(chat({
      status: 'running',
      isConnected: true,
      progressPhase: 'analysis',
      toolProgress: [{ callId: 'c-1', toolName: 'read', status: 'running', ts: 1 }],
    }));
    messagesHook.mockReturnValue(messages([
      msg({ id: 'u-1', role: 'user', content: 'hello' }),
      msg({ id: 'a-1', status: 'streaming', runId: 'run-1' }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getByTestId('brainstorm-agent-busy')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-agent-progress')).toHaveTextContent('Reading files');
    expect(screen.getByTestId('brainstorm-agent-progress')).toHaveTextContent('1 step');
  });

  it('shows what the agent is doing instead of a reconnecting message', () => {
    chatHook.mockReturnValue(chat({
      status: 'running',
      hasConnectionError: true,
      thinkingText: 'Looking through the repository layout',
      progressPhase: 'analysis',
      toolProgress: [
        {
          callId: 'c-1',
          toolName: 'grep',
          status: 'completed',
          ts: 1,
          args: { target: 'brainstorm session' },
        },
        {
          callId: 'c-2',
          toolName: 'mcp',
          status: 'completed',
          ts: 2,
          args: { toolName: 'search_repo_code', args: { target: 'Pendo' } },
        },
      ],
    }));
    messagesHook.mockReturnValue(messages([
      msg({ id: 'u-1', role: 'user', content: 'hello' }),
      msg({ id: 'a-1', status: 'streaming', runId: 'run-1' }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getByTestId('brainstorm-agent-thinking')).toHaveTextContent('Looking through the repository layout');
    expect(screen.getByTestId('brainstorm-agent-steps')).toHaveTextContent('Finished: Searching the codebase — brainstorm session');
    expect(screen.getByTestId('brainstorm-agent-steps')).toHaveTextContent('Finished: Searching the codebase — Pendo');
    expect(screen.getByTestId('brainstorm-agent-progress')).not.toHaveTextContent('Reconnecting');
  });

  it('shows the agent working while the next message is on its way', () => {
    chatHook.mockReturnValue(chat({ isSending: true, thinkingText: 'Analyzing' }));
    messagesHook.mockReturnValue(messages([
      msg({ id: 'a-1', role: 'assistant', status: 'completed', content: 'Hello, Ryan.' }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getByTestId('brainstorm-agent-thinking')).toHaveTextContent('Analyzing');
    expect(screen.getByTestId('brainstorm-composer-send')).toBeDisabled();
  });

  it('lets the creator send again after the reply is saved, even if the stream still looks busy', () => {
    chatHook.mockReturnValue(chat({ status: 'running', isInteractionBusy: true, isRunning: true }));
    messagesHook.mockReturnValue(messages([
      msg({ id: 'u-1', role: 'user', content: 'hello' }),
      msg({ id: 'a-1', role: 'assistant', status: 'completed', content: 'Hello, Ryan.' }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    fireEvent.change(screen.getByTestId('brainstorm-composer-input'), {
      target: { value: 'What repos can you see?' },
    });
    expect(screen.getByTestId('brainstorm-composer-send')).toBeEnabled();
  });

  it('collapses the thought process and steps on a completed reply so the user can expand and scroll', () => {
    chatHook.mockReturnValue(chat());
    messagesHook.mockReturnValue(messages([
      msg({ id: 'u-1', role: 'user', content: 'How does login work?' }),
      msg({
        id: 'a-1',
        role: 'assistant',
        status: 'completed',
        content: 'Here is how login works.',
        activity: [
          { id: 't-1', kind: 'thinking', text: 'Checking Clerk login flow in MaxView.' },
          { id: 'c-1', kind: 'tool', toolName: 'mcp:search_repo_code', status: 'completed', target: 'login' },
        ],
      }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getByTestId('brainstorm-thought-process-toggle')).toHaveTextContent('Thought process · 1 step');
    expect(screen.getByTestId('brainstorm-agent-thinking')).toHaveTextContent('Checking Clerk login flow in MaxView.');
    expect(screen.getByTestId('brainstorm-agent-steps')).toHaveTextContent('Finished: Searching the codebase — login');
  });

  it('PBI-002 (b), PBI-003 (a): marks a failure with role=alert and retries by run id', async () => {
    const retryFailedRun = jest.fn().mockResolvedValue(undefined);
    chatHook.mockReturnValue(chat({ retryFailedRun }));
    messagesHook.mockReturnValue(messages([msg({ id: 'u-1', role: 'user', content: 'An idea' }), failed]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getByRole('alert')).toHaveTextContent('The model returned an error before finishing.');
    expect(screen.getByTestId('brainstorm-message-failed')).toHaveTextContent('Failed');
    await act(async () => {
      fireEvent.click(screen.getByTestId('brainstorm-retry'));
    });
    expect(retryFailedRun).toHaveBeenCalledWith('run-1');
  });

  it('PBI-003 (b): a second failure shows the message again and Retry stays', () => {
    chatHook.mockReturnValue(chat());
    messagesHook.mockReturnValue(messages([
      msg({ id: 'u-1', role: 'user', content: 'An idea' }),
      { ...failed, supersededByMessageId: 'a-2' },
      msg({ ...failed, id: 'a-2', runId: 'run-2', retryOfMessageId: 'a-1' }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    expect(screen.getAllByTestId('brainstorm-message-failed')).toHaveLength(1);
    expect(screen.getByTestId('brainstorm-retry')).toBeEnabled();
  });

  it('renders the user prompt above the collaborator reply even when both share the same createdAt timestamp', () => {
    chatHook.mockReturnValue(chat());
    const sameTs = '2026-10-29T19:18:00.000Z';
    messagesHook.mockReturnValue(messages([
      msg({
        id: 'a-1',
        role: 'assistant',
        status: 'completed',
        turnId: 'turn-1',
        createdAt: sameTs,
        content: 'What happens before the UI (server)',
      }),
      msg({
        id: 'u-1',
        role: 'user',
        status: 'completed',
        turnId: 'turn-1',
        createdAt: sameTs,
        content: 'what is on the matterworx home page',
      }),
    ]));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    const userNode = screen.getByLabelText('Your message');
    const replyNode = screen.getByLabelText('Collaborator');
    expect(userNode).toHaveTextContent('what is on the matterworx home page');
    expect(replyNode).toHaveTextContent('What happens before the UI (server)');
    expect(userNode.compareDocumentPosition(replyNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sends trimmed text and rereads the ledger', async () => {
    const send = jest.fn().mockResolvedValue(true);
    const refetch = jest.fn().mockResolvedValue(undefined);
    chatHook.mockReturnValue(chat({ send }));
    messagesHook.mockReturnValue(messages([], refetch));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    fireEvent.change(screen.getByTestId('brainstorm-composer-input'), { target: { value: '  An idea  ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('brainstorm-composer-send'));
    });
    expect(send).toHaveBeenCalledWith('An idea', { model: 'm', mode: 'explore' });
    expect(refetch).toHaveBeenCalled();
  });

  it('renders the expandable mode picker with icons and subtitles and sets the mode for the next message without auto-triggering a turn', async () => {
    switchTypeMutateAsync.mockClear();
    const send = jest.fn().mockResolvedValue(true);
    const refetch = jest.fn().mockResolvedValue(undefined);
    chatHook.mockReturnValue(chat({ send }));
    messagesHook.mockReturnValue(messages([], refetch));
    render(<BrainstormChatPanel project="Apex" session={session} />);

    const trigger = screen.getByTestId('brainstorm-composer-mode-trigger');
    expect(trigger).toHaveTextContent('Explore');

    fireEvent.click(trigger);
    const menu = screen.getByTestId('brainstorm-composer-mode-menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-mode-option-explore')).toHaveTextContent(
      'Open Q&A and free-flow brainstorming without rewriting the artifact',
    );
    expect(screen.getByTestId('brainstorm-composer-mode-option-discovery_brief')).toHaveTextContent(
      'Frame the problem, goals, scope, and open questions',
    );
    expect(screen.getByTestId('brainstorm-composer-mode-option-technical_design')).toHaveTextContent(
      'System architecture, components, data flow, and trade-offs',
    );
    expect(screen.getByTestId('brainstorm-composer-mode-option-adr')).toHaveTextContent(
      'Record an architectural decision, options considered, and consequences',
    );
    expect(screen.getByTestId('brainstorm-composer-mode-option-implementation_plan')).toHaveTextContent(
      'Break the approach into ordered, actionable build steps',
    );

    fireEvent.click(screen.getByTestId('brainstorm-composer-mode-option-discovery_brief'));
    expect(screen.queryByTestId('brainstorm-composer-mode-menu')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('Discovery brief');
    // Selecting a mode does not auto-generate a turn before the user sends a message
    expect(switchTypeMutateAsync).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // Switch back to Explore via the menu
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('brainstorm-composer-mode-option-explore'));
    expect(trigger).toHaveTextContent('Explore');

    expect(screen.getByTestId('brainstorm-composer-microphone')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-composer-attach')).toBeInTheDocument();

    const modelSelect = screen.getByTestId('brainstorm-composer-model');
    expect(modelSelect).toHaveValue('m');
    fireEvent.change(modelSelect, { target: { value: 'gemini-4-argon-medium' } });
    expect(modelSelect).toHaveValue('gemini-4-argon-medium');

    const input = screen.getByTestId('brainstorm-composer-input');
    const pngFile = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.paste(input, {
        clipboardData: {
          items: [
            {
              kind: 'file',
              type: 'image/png',
              getAsFile: () => pngFile,
            },
          ],
          files: [pngFile],
        },
      });
    });

    expect(await screen.findByTestId('brainstorm-composer-attachments')).toHaveTextContent(/screenshot-\d+-1\.png/);

    await act(async () => {
      fireEvent.click(screen.getByTestId('brainstorm-composer-send'));
    });
    expect(send).toHaveBeenCalledWith(
      'Please use the attached files as additional context.',
      expect.objectContaining({
        model: 'gemini-4-argon-medium',
        mode: 'explore',
        attachments: [
          expect.objectContaining({
            type: 'image/png',
            encoding: 'base64',
          }),
        ],
      }),
    );
  });
});

describe('retryableBrainstormMessage', () => {
  it('returns only the latest unsuperseded failed collaborator row', () => {
    expect(retryableBrainstormMessage([failed])).toBe(failed);
    expect(retryableBrainstormMessage([failed, msg({ id: 'a-2', status: 'completed' })])).toBeNull();
    expect(retryableBrainstormMessage([{ ...failed, runId: null }])).toBeNull();
  });
});
