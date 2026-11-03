import { render, screen } from '@testing-library/react';
import { QaLabGenerationStatus } from '../QaLabGenerationStatus';
import { useChatStream } from '../../hooks/useChatStream';

jest.mock('../../hooks/useChatStream', () => ({
  useChatStream: jest.fn(),
}));

jest.mock('../ApexLoader', () => ({
  ApexLoader: () => <div data-testid="apex-loader" />,
}));

function mockStream(overrides: Partial<ReturnType<typeof useChatStream>>) {
  jest.mocked(useChatStream).mockReturnValue({
    progressLabel: null,
    progressPhase: null,
    toolProgress: [],
    ...overrides,
  } as ReturnType<typeof useChatStream>);
}

describe('QaLabGenerationStatus', () => {
  it('shows the loader and a starting label before the agent reports progress', () => {
    mockStream({});
    render(<QaLabGenerationStatus threadId={null} />);

    expect(screen.getByTestId('apex-loader')).toBeTruthy();
    expect(screen.getByText('Generating your test cases…')).toBeTruthy();
    expect(screen.getByTestId('qa-lab-generating-step').textContent).toBe('Starting the agent…');
    expect(screen.queryByTestId('qa-lab-generating-steps')).toBeNull();
    expect(useChatStream).toHaveBeenCalledWith(null);
  });

  it('follows the run thread and lists the latest steps newest first', () => {
    mockStream({
      progressPhase: 'implementation',
      toolProgress: [
        { callId: 'a', toolName: 'read_file', status: 'completed', ts: 1 },
        { callId: 'b', toolName: 'grep', status: 'running', ts: 2 },
      ],
    });
    render(<QaLabGenerationStatus threadId="thread-1" />);

    expect(useChatStream).toHaveBeenCalledWith('thread-1');
    const steps = screen.getByTestId('qa-lab-generating-steps').querySelectorAll('li');
    expect(steps).toHaveLength(2);
    expect(steps[0].textContent).toContain('…');
    expect(steps[1].textContent).toContain('✓');
    expect(screen.getByTestId('qa-lab-generating-step').textContent).toContain('2 steps');
  });
});
