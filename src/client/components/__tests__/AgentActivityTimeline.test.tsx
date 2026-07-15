import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage } from '../../../shared/types/chat';
import { AgentActivityTimeline } from '../AgentActivityTimeline';

function message(
  id: string,
  toolName: string,
  ts: string,
  text = `private raw thought ${id}`
): ChatMessage {
  return {
    id,
    role: 'tool',
    toolName,
    text,
    ts,
  };
}

describe('AgentActivityTimeline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-14T12:10:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('groups observed activity into complete, current, and pending semantic phases', () => {
    const messages: ChatMessage[] = [
      message('thinking-1', '_thinking', '2026-07-14T12:00:00Z'),
      message('edit-1', 'edit_file', '2026-07-14T12:02:00Z'),
      {
        ...message('test-1', 'run_terminal_cmd', '2026-07-14T12:05:00Z'),
        toolInput: { command: 'npm test' },
      },
    ];

    render(
      <AgentActivityTimeline
        messages={messages}
        toolProgress={[]}
        status="running"
        isConnected
        startedAt="2026-07-14T12:00:00Z"
        lastProgressAt={new Date('2026-07-14T12:09:50Z').getTime()}
      />
    );

    expect(
      screen.getByText('Planning and analysis').closest('[data-state]')
    ).toHaveAttribute('data-state', 'complete');
    expect(
      screen.getByText('Implementation').closest('[data-state]')
    ).toHaveAttribute('data-state', 'complete');
    expect(screen.getByText('Tests').closest('[data-state]')).toHaveAttribute(
      'data-state',
      'current'
    );
    expect(
      screen.getByText('Type-check').closest('[data-state]')
    ).toHaveAttribute('data-state', 'pending');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Elapsed 10m/)).toBeInTheDocument();
    expect(screen.getByText('Last progress 10s ago')).toBeInTheDocument();
  });

  it('shows a stale warning for a connected running session without meaningful progress', () => {
    render(
      <AgentActivityTimeline
        messages={[message('edit-1', 'edit_file', '2026-07-14T12:00:00Z')]}
        toolProgress={[]}
        status="running"
        isConnected
        startedAt="2026-07-14T12:00:00Z"
        lastProgressAt={new Date('2026-07-14T12:05:00Z').getTime()}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'No meaningful progress for 5m'
    );
  });

  it('uses server semantic phase state instead of tool-name inference', () => {
    render(
      <AgentActivityTimeline
        messages={[
          {
            ...message(
              'misleading-tool',
              'run_terminal_cmd',
              '2026-07-14T12:05:00Z'
            ),
            toolInput: { command: 'echo this is not a test' },
          },
        ]}
        toolProgress={[]}
        phaseEvents={[
          {
            id: 'phase-1',
            runId: 'run-1',
            phase: 'typecheck',
            status: 'running',
            detail: 'Checking client types',
            timestamp: Date.parse('2026-07-14T12:09:55.000Z'),
          },
        ]}
        status="running"
        isConnected
        startedAt="2026-07-14T12:00:00Z"
        lastProgressAt={Date.parse('2026-07-14T12:09:55.000Z')}
      />
    );

    expect(
      screen.getByText('Type-check').closest('[data-state]')
    ).toHaveAttribute('data-state', 'current');
    expect(screen.getByText('Checking client types')).toBeInTheDocument();
  });

  it('renders durable watchdog health without treating it as inferred phase progress', () => {
    render(
      <AgentActivityTimeline
        messages={[]}
        toolProgress={[]}
        phaseEvents={[]}
        runHealth={{
          health: 'long_running',
          detail:
            'Long-running agent run; recent progress is still being received',
          timestamp: Date.parse('2026-07-14T12:10:00.000Z'),
        }}
        status="running"
        isConnected
        startedAt="2026-07-14T11:30:00Z"
        lastProgressAt={Date.parse('2026-07-14T12:09:55.000Z')}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Long-running agent run'
    );
    expect(screen.getByText('Waiting for agent activity')).toBeInTheDocument();
  });

  it('keeps technical history collapsed by default and bounds expanded history', () => {
    const thinking: ChatMessage[] = Array.from({ length: 600 }, (_, index) =>
      message(
        `thinking-${index}`,
        '_thinking',
        new Date(Date.parse('2026-07-14T12:00:00Z') + index).toISOString(),
        `SECRET-THOUGHT-${index}`
      )
    );
    const tools: ChatMessage[] = Array.from({ length: 140 }, (_, index) =>
      message(
        `tool-${index}`,
        'read_file',
        new Date(Date.parse('2026-07-14T12:01:00Z') + index).toISOString(),
        `SECRET-RESULT-${index}`
      )
    );

    render(
      <AgentActivityTimeline
        messages={[...thinking, ...tools]}
        toolProgress={[]}
        status="idle"
        isConnected={false}
        startedAt="2026-07-14T12:00:00Z"
        lastProgressAt={null}
      />
    );

    expect(screen.queryByText(/SECRET-THOUGHT/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('technical-events')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Show 141 technical events/ })
    );

    const technicalEvents = screen.getByTestId('technical-events');
    expect(within(technicalEvents).getAllByRole('listitem')).toHaveLength(100);
    expect(
      within(technicalEvents).getByText('Showing latest 100 of 141 events')
    ).toBeInTheDocument();
    expect(
      within(technicalEvents).getByText('Analysis activity (600 fragments)')
    ).toBeInTheDocument();
    expect(screen.queryByText(/SECRET-THOUGHT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SECRET-RESULT/)).not.toBeInTheDocument();
  });
});
