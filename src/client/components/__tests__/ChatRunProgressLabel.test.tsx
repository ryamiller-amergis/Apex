import { act, render, screen } from '@testing-library/react';
import { ChatRunProgressLabel } from '../ChatRunProgressLabel';
import type { ToolProgress } from '../../hooks/useChatStream';

const tool = (overrides: Partial<ToolProgress>): ToolProgress => ({
  callId: 'call-1',
  toolName: 'grep',
  status: 'running',
  ts: Date.now(),
  ...overrides,
});

describe('ChatRunProgressLabel', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps the single-word status while queued', () => {
    render(
      <ChatRunProgressLabel
        fallbackLabel="Queued"
        progressPhase="queued"
        toolProgress={[tool({})]}
      />,
    );
    act(() => jest.advanceTimersByTime(10_000));

    expect(screen.getByText('Queued')).toBeTruthy();
  });

  it('names the running tool and counts steps', () => {
    render(
      <ChatRunProgressLabel
        fallbackLabel="Thinking…"
        progressPhase="implementation"
        toolProgress={[
          tool({ callId: 'a', toolName: 'glob', status: 'completed' }),
          tool({ callId: 'b', toolName: 'grep', status: 'running' }),
        ]}
      />,
    );

    expect(screen.getByText('Searching the codebase · 2 steps')).toBeTruthy();
  });

  it('names a finished connected tool instead of the raw tool id', () => {
    render(
      <ChatRunProgressLabel
        fallbackLabel="mcp:list_applications completed"
        progressPhase="implementation"
        toolProgress={[tool({ toolName: 'mcp:list_applications', status: 'completed' })]}
      />,
    );

    expect(screen.getByText('Listing applications · 1 step')).toBeTruthy();
  });

  it('returns to Thinking when all tools have completed and analysis resumes', () => {
    render(
      <ChatRunProgressLabel
        fallbackLabel="Analysis completed"
        progressPhase="analysis"
        toolProgress={[tool({ toolName: 'mcp:listAllApplications', status: 'completed' })]}
      />,
    );

    expect(screen.getByText('Thinking… · 1 step')).toBeTruthy();
  });

  it('adds elapsed seconds after the first few seconds', () => {
    render(
      <ChatRunProgressLabel fallbackLabel="Thinking…" progressPhase="analysis" toolProgress={[]} />,
    );
    expect(screen.getByText('Thinking…')).toBeTruthy();

    act(() => jest.advanceTimersByTime(4_000));

    expect(screen.getByText('Thinking… · 4s')).toBeTruthy();
  });

  it('starts counting when the run leaves the queue', () => {
    const { rerender } = render(
      <ChatRunProgressLabel fallbackLabel="Queued" progressPhase="queued" toolProgress={[]} />,
    );
    act(() => jest.advanceTimersByTime(30_000));

    rerender(
      <ChatRunProgressLabel fallbackLabel="Thinking…" progressPhase="analysis" toolProgress={[]} />,
    );
    expect(screen.getByText('Thinking…')).toBeTruthy();

    act(() => jest.advanceTimersByTime(4_000));
    expect(screen.getByText('Thinking… · 4s')).toBeTruthy();
  });
});
