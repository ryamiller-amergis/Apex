import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybookLiveStepPanel } from '../PlaybookLiveStepPanel';
import type { PlaybookStepRun } from '../../../shared/types/playbook';

const idle = { mutate: jest.fn(), isPending: false, isError: false, error: null };

jest.mock('../../hooks/usePlaybookRuns', () => ({
  useInteractiveAgentDecision: () => idle,
  useInteractiveAgentTurn: () => idle,
  usePlaybookGateDecision: () => idle,
  usePlaybookStepActivity: () => ({ data: { entries: [], agentRun: null }, isError: false }),
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
  it('says it is waiting for a message instead of showing a queued agent', () => {
    renderPanel(agentStep());
    expect(screen.getByTestId('playbook-step-awaiting-message')).toHaveTextContent('Waiting for your message');
    expect(screen.queryByLabelText('Progress')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for the first output…')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Still running')).not.toBeInTheDocument();
  });

  it('says the turn finished once the agent has replied', () => {
    renderPanel(agentStep({
      outputInline: { threadId: 'thread-1', assigneeUserId: 'user-1', turnCount: 1 },
    }));
    expect(screen.getByTestId('playbook-step-awaiting-message')).toHaveTextContent('finished its turn');
  });

  it('shows the progress tracker while a turn is running', () => {
    renderPanel(agentStep({ agentRunId: 'agent-run-1' }));
    expect(screen.queryByTestId('playbook-step-awaiting-message')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Progress')).toBeInTheDocument();
  });

  it('opens an interactive chat filling the page, side by side with the log', () => {
    renderPanel(agentStep());
    const panel = screen.getByTestId('playbook-live-step-panel');
    expect(panel.className).toContain('panelMaximized');
    expect(screen.getByTestId('playbook-live-step-panel-maximize')).toHaveAttribute('aria-pressed', 'true');
    const chat = screen.getByTestId('playbook-interactive-chat');
    expect(chat.closest('[data-split="true"]')).not.toBeNull();
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
