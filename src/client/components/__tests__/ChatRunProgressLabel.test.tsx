import React from 'react';
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

  it('adds elapsed seconds after the first few seconds', () => {
    render(
      <ChatRunProgressLabel fallbackLabel="Thinking…" progressPhase="analysis" toolProgress={[]} />,
    );
    expect(screen.getByText('Thinking…')).toBeTruthy();

    act(() => jest.advanceTimersByTime(4_000));

    expect(screen.getByText('Thinking… · 4s')).toBeTruthy();
  });
});
