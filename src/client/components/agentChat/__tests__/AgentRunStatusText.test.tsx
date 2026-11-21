import { render, screen } from '@testing-library/react';
import { AgentRunStatusText } from '../AgentRunStatusText';

describe('AgentRunStatusText', () => {
  it('renders Starting… instead of raw Queued while preserving the queued testid', () => {
    render(
      <AgentRunStatusText
        progressPhase="queued"
        progressLabel="Queued — waiting for available worker"
      />,
    );

    const status = screen.getByTestId('agent-run-status-queued');
    expect(status).toHaveTextContent('Starting…');
    expect(status).not.toHaveTextContent(/queued/i);
  });

  it('preserves plain-English user-slot wait copy when waiting on another chat', () => {
    render(
      <AgentRunStatusText
        progressPhase="queued"
        progressLabel="Waiting for your other chat to finish"
      />,
    );

    expect(screen.getByTestId('agent-run-status-queued')).toHaveTextContent(
      'Waiting for your other chat to finish',
    );
  });

  it('renders Starting… instead of raw Dispatched while preserving the dispatched testid', () => {
    render(
      <AgentRunStatusText
        progressPhase="dispatched"
        progressLabel="Dispatched"
      />,
    );

    const status = screen.getByTestId('agent-run-status-dispatched');
    expect(status).toHaveTextContent('Starting…');
    expect(status).not.toHaveTextContent(/dispatched/i);
  });

  it('renders plain friendly progress text without timer when showElapsedAndSteps is false', () => {
    render(
      <AgentRunStatusText
        progressPhase="setup"
        progressLabel="Preparing project repository…"
        showElapsedAndSteps={false}
      />,
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
