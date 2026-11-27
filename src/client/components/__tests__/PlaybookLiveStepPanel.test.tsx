import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybookLiveStepPanel } from '../PlaybookLiveStepPanel';
import type { PlaybookStepChatMessage, PlaybookStepRun } from '../../../shared/types/playbook';

const idle = { mutate: jest.fn(), isPending: false, isError: false, error: null };
const mockTurn = { mutate: jest.fn(), isPending: false, isError: false, error: null };
let mockConversation: PlaybookStepChatMessage[] = [];

jest.mock('../../hooks/usePlaybookRuns', () => ({
  useInteractiveAgentDecision: () => idle,
  useInteractiveAgentTurn: () => mockTurn,
  usePlaybookGateDecision: () => idle,
  usePlaybookStepActivity: () => ({
    data: { entries: [], agentRun: null, conversation: mockConversation },
    isError: false,
  }),
  usePlaybookStepOutput: () => ({ data: null, isPending: false, isError: false }),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useCloudAgentActivityStream: () => ({ events: [], error: null }),
}));

jest.mock('../MarkdownWithMermaid', () => ({
  MarkdownWithMermaid: ({ content }: { content: string }) => <div>{content}</div>,
}));

function agentStep(overrides: Partial<PlaybookStepRun> = {}): PlaybookStepRun {
  return {
    id: 'row-1',
    runId: 'run-1',
    stepId: 'cursor-agent-1',
    stepType: 'cursor-agent',
    title: 'Create Support Release notes',
    status: 'suspended',
    agentRunId: null,
    resumeToken: 'thread-1',
    outputInline: { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 0 },
    outputBlobRef: null,
    expiresAt: null,
    startedAt: '2026-11-24T19:20:00.000Z',
    completedAt: null,
    createdAt: '2026-11-24T19:20:00.000Z',
    updatedAt: '2026-11-24T19:20:00.000Z',
    ...overrides,
  } as PlaybookStepRun;
}

function openLog() {
  fireEvent.click(screen.getByTestId('playbook-live-step-panel-tab-log'));
}

function renderPanel(step: PlaybookStepRun, expanded = true) {
  const onExpandedChange = jest.fn();
  render(
    <PlaybookLiveStepPanel
      project="Apex"
      runId="run-1"
      step={step}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      onClose={jest.fn()}
    />,
  );
  return { onExpandedChange };
}

describe('PlaybookLiveStepPanel', () => {
  beforeEach(() => {
    mockConversation = [];
    mockTurn.mutate.mockReset();
  });

  it('shows the chat as messages from each side', () => {
    mockConversation = [
      { id: 'u1', role: 'user', text: 'Draft the notes for 1.12.', at: '2026-11-24T19:21:00.000Z' },
      { id: 'a1', role: 'agent', text: 'Here is the draft.', at: '2026-11-24T19:22:00.000Z' },
    ];
    renderPanel(agentStep({ outputInline: { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 1 } }));
    const thread = screen.getByTestId('playbook-interactive-conversation');
    const items = thread.querySelectorAll('li[data-role]');
    expect(Array.from(items).map((item) => item.getAttribute('data-role'))).toEqual(['user', 'agent']);
    expect(thread).toHaveTextContent('Draft the notes for 1.12.');
    expect(thread).toHaveTextContent('Here is the draft.');
  });

  it('shows an empty chat, then a working reply while a turn runs', () => {
    const { unmount } = render(
      <PlaybookLiveStepPanel project="Apex" runId="run-1" step={agentStep()} expanded
        onExpandedChange={jest.fn()} onClose={jest.fn()} />,
    );
    expect(screen.getByTestId('playbook-interactive-conversation')).toHaveTextContent('No messages yet');
    unmount();

    mockConversation = [{ id: 'u1', role: 'user', text: 'Go', at: '2026-11-24T19:21:00.000Z' }];
    renderPanel(agentStep({ agentRunId: 'agent-run-1' }));
    expect(screen.getByLabelText('The agent is working')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-interactive-send')).toBeDisabled();
  });

  it('sends with Ctrl+Enter', () => {
    renderPanel(agentStep());
    const box = screen.getByTestId('playbook-interactive-message');
    fireEvent.change(box, { target: { value: 'Draft the notes.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(mockTurn.mutate).toHaveBeenCalledWith('Draft the notes.', expect.anything());
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(mockTurn.mutate).toHaveBeenCalledTimes(1);
  });

  it('says the agent is starting instead of showing a queued agent', () => {
    renderPanel(agentStep());
    openLog();
    expect(screen.getByTestId('playbook-step-awaiting-message')).toHaveTextContent('Starting the agent');
    expect(screen.queryByLabelText('Progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for the first output…')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Still running')).not.toBeInTheDocument();
  });

  it('asks for a message when the agent could not start from the step prompt', () => {
    renderPanel(agentStep({
      outputInline: {
        threadId: 'thread-1',
        assigneeUserId: 'user-1',
        turnCount: 0,
        lastTurnError: 'The agent could not start from the step\'s prompt: Admission is full.',
      },
    }));
    openLog();
    expect(screen.getByTestId('playbook-step-awaiting-message')).toHaveTextContent('did not start');
    expect(screen.getByRole('alert')).toHaveTextContent('Admission is full');
  });

  it('says the turn finished once the agent has replied', () => {
    renderPanel(agentStep({
      outputInline: { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 1 },
    }));
    openLog();
    expect(screen.getByTestId('playbook-step-awaiting-message')).toHaveTextContent('finished its turn');
  });

  it('shows the progress tracker while a turn is running', () => {
    renderPanel(agentStep({ agentRunId: 'agent-run-1' }));
    openLog();
    expect(screen.queryByTestId('playbook-step-awaiting-message')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Progress')).toBeInTheDocument();
  });

  it('opens an interactive chat filling the page, with the log and input and output closed', () => {
    renderPanel(agentStep());
    const panel = screen.getByTestId('playbook-live-step-panel');
    expect(panel.className).toContain('panelMaximized');
    expect(screen.getByTestId('playbook-live-step-panel-maximize')).toHaveAttribute('aria-pressed', 'true');
    const chat = screen.getByTestId('playbook-interactive-chat');
    expect(chat.closest('[data-split="true"]')).not.toBeNull();
    expect(chat.closest('[data-detail]')).toBeNull();
    expect(screen.queryByTestId('playbook-step-awaiting-message')).not.toBeInTheDocument();
    expect(screen.getByTestId('playbook-live-step-panel-tab-log')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('playbook-live-step-panel-tab-details')).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the log beside the chat and closes it with the same toggle', () => {
    renderPanel(agentStep());
    const log = screen.getByTestId('playbook-live-step-panel-tab-log');
    const details = screen.getByTestId('playbook-live-step-panel-tab-details');

    fireEvent.click(log);
    expect(log).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('playbook-step-awaiting-message')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-interactive-chat').closest('[data-detail="true"]')).not.toBeNull();

    fireEvent.click(details);
    expect(log).toHaveAttribute('aria-pressed', 'false');
    expect(details).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('playbook-step-awaiting-message')).not.toBeInTheDocument();

    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('playbook-interactive-chat').closest('[data-detail]')).toBeNull();
  });

  it('shows a proposal problem only for a proposal an agent wrote', () => {
    const { unmount } = render(
      <PlaybookLiveStepPanel project="Apex" runId="run-1" expanded onExpandedChange={jest.fn()} onClose={jest.fn()}
        step={agentStep({
          outputInline: { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 0, proposalReason: 'The proposal is empty.' },
        })} />,
    );
    expect(screen.queryByText('The proposal is empty.')).not.toBeInTheDocument();
    unmount();

    renderPanel(agentStep({
      outputInline: {
        threadId: 'thread-1',
        assigneeUserId: 'user-1',
        turnCount: 1,
        proposalText: 'Ship it.',
        proposalOk: false,
        proposalReason: 'The outcome must be one of: approved, rework.',
      },
    }));
    expect(screen.getByText('The outcome must be one of: approved, rework.')).toBeInTheDocument();
  });

  it('says the agent is asking when a turn ended without a proposal, and keeps Approve off', () => {
    renderPanel(agentStep({
      outputInline: {
        threadId: 'thread-1',
        assigneeUserId: 'user-1',
        turnCount: 1,
        proposalText: null,
        proposalOk: false,
      },
    }));
    expect(screen.getByTestId('playbook-interactive-asking')).toHaveTextContent('Agent is asking');
    expect(screen.queryByText('Proposal to approve')).not.toBeInTheDocument();
    expect(screen.getByTestId('playbook-interactive-approve')).toBeDisabled();
    expect(screen.getByTestId('playbook-interactive-reject')).toBeDisabled();
    expect(screen.getByTestId('playbook-interactive-message')).toBeInTheDocument();
  });

  it('shows a proposal to approve, not the asking note, once the agent marks a result ready', () => {
    renderPanel(agentStep({
      outputInline: {
        threadId: 'thread-1',
        assigneeUserId: 'user-1',
        turnCount: 2,
        proposalText: 'The final notes.',
        proposalOk: true,
      },
    }));
    expect(screen.queryByTestId('playbook-interactive-asking')).not.toBeInTheDocument();
    expect(screen.getByText('Proposal to approve')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-interactive-approve')).toBeEnabled();
  });

  it('does not say the agent is asking before its first turn, or while it works', () => {
    const { unmount } = render(
      <PlaybookLiveStepPanel project="Apex" runId="run-1" expanded onExpandedChange={jest.fn()} onClose={jest.fn()}
        step={agentStep()} />,
    );
    expect(screen.queryByTestId('playbook-interactive-asking')).not.toBeInTheDocument();
    unmount();
    renderPanel(agentStep({
      agentRunId: 'agent-run-1',
      outputInline: { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 1 },
    }));
    expect(screen.queryByTestId('playbook-interactive-asking')).not.toBeInTheDocument();
  });

  it('goes full size when a running step turns into a chat', () => {
    const running = agentStep({ status: 'running', outputInline: null });
    const props = {
      project: 'Apex',
      runId: 'run-1',
      expanded: true,
      onExpandedChange: jest.fn(),
      onClose: jest.fn(),
    };
    const { rerender } = render(<PlaybookLiveStepPanel {...props} step={running} />);
    expect(screen.getByTestId('playbook-live-step-panel').className).not.toContain('panelMaximized');

    rerender(<PlaybookLiveStepPanel {...props} step={agentStep()} />);
    expect(screen.getByTestId('playbook-live-step-panel').className).toContain('panelMaximized');
  });

  it('shrinks with the toggle or Escape, then collapses on a second Escape', () => {
    const { onExpandedChange } = renderPanel(agentStep());
    const toggle = screen.getByTestId('playbook-live-step-panel-maximize');
    fireEvent.click(toggle);
    expect(screen.getByTestId('playbook-live-step-panel').className).not.toContain('panelMaximized');
    fireEvent.click(toggle);
    expect(screen.getByTestId('playbook-live-step-panel').className).toContain('panelMaximized');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('playbook-live-step-panel').className).not.toContain('panelMaximized');
    expect(onExpandedChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('opens a non-chat step at the normal size, and the toggle expands it straight to full size', () => {
    const { onExpandedChange } = renderPanel(
      agentStep({ status: 'running', outputInline: null, agentRunId: 'agent-run-1' }),
      false,
    );
    expect(screen.getByTestId('playbook-live-step-panel').className).not.toContain('panelMaximized');
    fireEvent.click(screen.getByTestId('playbook-live-step-panel-maximize'));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });
});
