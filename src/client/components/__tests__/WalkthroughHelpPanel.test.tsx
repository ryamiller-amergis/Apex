/**
 * FEAT-006 — WalkthroughHelpPanel (PBI-008)
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { WalkthroughHelpPanel } from '../WalkthroughHelpPanel';
import type { WalkthroughReplayEntry } from '../../../shared/types/walkthrough';

const baseWalkthrough = {
  id: 'wt-1',
  internalName: 'intro',
  userTitle: 'Intro Guide',
  whyItMatters: 'Why',
  lifecycle: 'published' as const,
  priority: 1,
  isRequired: false,
  revision: 1,
  publishedAt: '2026-07-01T00:00:00Z',
  archivedAt: null,
  createdBy: 'admin',
  createdAt: '2026-07-01T00:00:00Z',
  updatedBy: 'admin',
  updatedAt: '2026-07-01T00:00:00Z',
  steps: [],
  targeting: { projects: ['Apex'], groupId: null },
  targetingRules: [{ type: 'project' as const, value: 'Apex' }],
};

function entry(overrides: {
  state: 'new' | 'acknowledged';
  id?: string;
}): WalkthroughReplayEntry {
  const id = overrides.id ?? (overrides.state === 'new' ? 'wt-new' : 'wt-ack');
  return {
    walkthrough: {
      ...baseWalkthrough,
      id,
      userTitle: overrides.state === 'new' ? 'New One' : 'Ack One',
    },
    progress:
      overrides.state === 'acknowledged'
        ? {
            walkthroughId: id,
            userId: 'u1',
            revision: 1,
            status: 'completed',
            lastStepId: null,
            seenAt: '2026-07-01T00:00:00Z',
            acknowledgedAt: '2026-07-01T00:00:00Z',
            updatedAt: '2026-07-01T00:00:00Z',
            acknowledged: true,
          }
        : null,
    state: overrides.state,
  };
}

describe('WalkthroughHelpPanel (FEAT-006 PBI-008)', () => {
  it('AC-0 — shows New and Acknowledged sections and allows voluntary open', () => {
    const onSelect = jest.fn();
    render(
      <WalkthroughHelpPanel
        open
        loading={false}
        error={false}
        items={[entry({ state: 'new' }), entry({ state: 'acknowledged' })]}
        onClose={jest.fn()}
        onRetry={jest.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId('walkthrough-help-panel')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-list-new')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-list-acknowledged')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('walkthrough-replay-wt-new'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ state: 'new' }));
    fireEvent.click(screen.getByTestId('walkthrough-replay-wt-ack'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ state: 'acknowledged' }));
  });

  it('AC-1 — shows unavailable state and Retry when list fails', () => {
    const onRetry = jest.fn();
    render(
      <WalkthroughHelpPanel
        open
        loading={false}
        error
        items={[]}
        onClose={jest.fn()}
        onRetry={onRetry}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByTestId('walkthrough-help-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('walkthrough-help-retry'));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByTestId('walkthrough-replay-wt-new')).not.toBeInTheDocument();
  });

  it('shows empty state when no accessible published Walkthroughs', () => {
    render(
      <WalkthroughHelpPanel
        open
        loading={false}
        error={false}
        items={[]}
        onClose={jest.fn()}
        onRetry={jest.fn()}
        onSelect={jest.fn()}
      />,
    );
    expect(screen.getByTestId('walkthrough-help-empty')).toHaveTextContent(
      /No Walkthroughs are available/i,
    );
  });
});
