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
    thinkingText: '',
    ...overrides,
  } as ReturnType<typeof useChatStream>);
}

const milestoneState = (key: string) =>
  screen.getByTestId(`qa-lab-milestone-${key}`).getAttribute('data-state');

describe('QaLabGenerationStatus', () => {
  it('shows the loader, pending milestones, and a starting label before the agent reports progress', () => {
    mockStream({});
    render(<QaLabGenerationStatus threadId={null} />);

    expect(screen.getByTestId('apex-loader')).toBeTruthy();
    expect(screen.getByText('Generating your test cases…')).toBeTruthy();
    expect(screen.getByTestId('qa-lab-generating-step').textContent).toBe('Starting the agent…');
    expect(['work-items', 'skill', 'write'].map(milestoneState)).toEqual(['active', 'pending', 'pending']);
    expect(screen.queryByTestId('qa-lab-generating-steps')).toBeNull();
    expect(useChatStream).toHaveBeenCalledWith(null);
  });

  it('marks milestones from the files the agent touches and logs each step with its target', () => {
    mockStream({
      progressPhase: 'implementation',
      thinkingText: 'Mapping acceptance criteria to scenarios',
      toolProgress: [
        { callId: 'a', toolName: 'read_file', status: 'completed', ts: 1, args: { path: '/w/.cursor/skills/create-test-case/SKILL.md' } },
        { callId: 'b', toolName: 'edit_file', status: 'running', ts: 2, args: { path: 'C:\\w\\.ai-pilot\\output\\checkout.test-cases.json' } },
      ],
    });
    render(<QaLabGenerationStatus threadId="thread-1" />);

    expect(useChatStream).toHaveBeenCalledWith('thread-1');
    expect(['work-items', 'skill', 'write'].map(milestoneState)).toEqual(['done', 'done', 'active']);
    const log = screen.getByTestId('qa-lab-generating-steps');
    expect(log.textContent).toContain('Mapping acceptance criteria to scenarios');
    expect(log.textContent).toContain('Finished: ');
    expect(log.textContent).toContain('Working: ');
    expect(log.textContent).toContain('.ai-pilot/output/checkout.test-cases.json');
    expect(screen.getByTestId('qa-lab-generating-step').textContent).toContain('2 steps');
  });
});
