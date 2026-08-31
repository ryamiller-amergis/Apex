import { fireEvent, render, screen } from '@testing-library/react';
import { AgentPanelShell } from '../agentChat/AgentPanelShell';

describe('AgentPanelShell', () => {
  it('TBI-007 DoD-0 renders the shared header, slots, transcript, and composer', () => {
    render(
      <AgentPanelShell
        title="Agent Chat"
        ariaLabel="Agent chat panel"
        onClose={jest.fn()}
        closeTestId="consumer-close"
        actions={<button type="button">Extra action</button>}
        before={<div>Before transcript</div>}
        composer={<div>Composer</div>}
      >
        <div>Transcript</div>
      </AgentPanelShell>,
    );

    expect(screen.getByRole('complementary', { name: 'Agent chat panel' })).toBeInTheDocument();
    expect(screen.getByText('Extra action')).toBeInTheDocument();
    expect(screen.getByText('Before transcript')).toBeInTheDocument();
    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByText('Composer')).toBeInTheDocument();
  });

  it('TBI-007 DoD-2 exposes the shared overlay-mode marker and closes from the consumer id', () => {
    const onClose = jest.fn();
    render(
      <AgentPanelShell title="Assistant" ariaLabel="Assistant panel" onClose={onClose} closeTestId="assistant-close">
        Body
      </AgentPanelShell>,
    );
    expect(screen.getByTestId('agent-slideout-overlay-mode')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('assistant-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
