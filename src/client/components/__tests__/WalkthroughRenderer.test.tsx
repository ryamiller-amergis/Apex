/**
 * TBI-004 — WalkthroughRenderer
 * DoD-0–DoD-3 + VT-05, VT-07, VT-08, VT-10, VT-11
 */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ANCHOR_WAIT_MS } from '../../../shared/walkthroughAnchors';
import type { WalkthroughRendererDefinition } from '../../../shared/types/walkthrough';
import { WalkthroughRenderer } from '../WalkthroughRenderer';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => () => {});

function renderRenderer(
  definition: WalkthroughRendererDefinition,
  props: Partial<React.ComponentProps<typeof WalkthroughRenderer>> = {},
) {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <WalkthroughRenderer definition={definition} {...props} />
    </MemoryRouter>,
  );
}

const centeredDef: WalkthroughRendererDefinition = {
  id: 'wt-1',
  revision: 1,
  title: 'Feature intro',
  steps: [
    {
      id: 's0',
      position: 0,
      heading: 'Welcome',
      bodyMarkdown: 'Centered explanation',
      anchor: null,
    },
    {
      id: 's1',
      position: 1,
      heading: 'Next topic',
      bodyMarkdown: 'Still centered',
      anchor: null,
    },
  ],
};

describe('WalkthroughRenderer (TBI-004)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('DoD-0 / VT-05: unanchored Steps render as centered modal content in order', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const onStepChange = jest.fn();
    const { unmount } = renderRenderer(centeredDef, { onStepChange });

    expect(screen.getByTestId('walkthrough-renderer')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-modal-step')).toBeInTheDocument();
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-step-position')).toHaveTextContent('Step 1 of 2');

    await user.click(screen.getByTestId('walkthrough-next'));
    expect(screen.getByText('Next topic')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-step-position')).toHaveTextContent('Step 2 of 2');
    expect(onStepChange).toHaveBeenCalled();
    unmount();
  });

  it('DoD-1 / VT-05: anchored Steps attach as coachmark when target is mounted', async () => {
    const target = document.createElement('button');
    target.setAttribute('data-testid', 'user-menu-trigger');
    target.textContent = 'User menu';
    document.body.appendChild(target);

    const def: WalkthroughRendererDefinition = {
      id: 'wt-2',
      revision: 1,
      title: 'Anchored',
      steps: [
        {
          id: 'a0',
          position: 0,
          heading: 'Open the menu',
          bodyMarkdown: 'Click the avatar menu',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
          },
        },
      ],
    };

    const { unmount } = renderRenderer(def);

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-coachmark-step')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('walkthrough-modal-step')).toBeNull();
    expect(screen.getByText('Open the menu')).toBeInTheDocument();
    unmount();
    target.remove();
  });

  it('DoD-2 / VT-07: missing target falls back centered and emits one miss', async () => {
    const onAnchorMiss = jest.fn();
    const def: WalkthroughRendererDefinition = {
      id: 'wt-3',
      revision: 2,
      title: 'Miss',
      steps: [
        {
          id: 'm0',
          position: 0,
          heading: 'Missing target',
          bodyMarkdown: 'Same content preserved',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
          },
        },
      ],
    };

    const { unmount } = renderRenderer(def, { onAnchorMiss, playbackSessionId: 'play-1' });

    expect(screen.getByTestId('walkthrough-loading')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(ANCHOR_WAIT_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-anchor-fallback')).toBeInTheDocument();
      expect(screen.getByText('Missing target')).toBeInTheDocument();
      expect(screen.getByText('Same content preserved')).toBeInTheDocument();
    });

    expect(onAnchorMiss).toHaveBeenCalledTimes(1);
    expect(onAnchorMiss.mock.calls[0][0]).toMatchObject({
      walkthroughId: 'wt-3',
      revision: 2,
      stepId: 'm0',
      anchorKey: 'user-menu-trigger',
      targetRoute: '/home',
      reason: 'timeout',
    });
    expect(onAnchorMiss.mock.calls[0][0].clientTimestamp).toBeTruthy();
    unmount();
  });

  it('VT-08: ~20 Steps stay in range at first/last boundaries', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const steps = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      position: i,
      heading: `Heading ${i}`,
      bodyMarkdown: `Body ${i}`,
      anchor: null as null,
    }));
    const { unmount } = renderRenderer({
      id: 'wt-20',
      revision: 1,
      title: 'Long',
      steps,
    });

    expect(screen.getByTestId('walkthrough-previous')).toBeDisabled();
    await user.click(screen.getByTestId('walkthrough-next'));
    expect(screen.getByText('Heading 1')).toBeInTheDocument();

    for (let i = 1; i < 19; i += 1) {
      await user.click(screen.getByTestId('walkthrough-next'));
    }
    expect(screen.getByText('Heading 19')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-complete')).toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-next')).toBeNull();
    unmount();
  });

  it('VT-10: unregistered anchor renders centered defensively without coachmark', async () => {
    const onAnchorMiss = jest.fn();
    const { unmount } = renderRenderer(
      {
        id: 'wt-bad',
        revision: 1,
        title: 'Bad',
        steps: [
          {
            id: 'b0',
            position: 0,
            heading: 'Unsafe',
            bodyMarkdown: 'Still shown',
            anchor: {
              key: '#not-registered',
              targetRoute: '/home',
              placement: 'bottom',
            },
          },
        ],
      },
      { onAnchorMiss },
    );

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-modal-step')).toBeInTheDocument();
      expect(screen.queryByTestId('walkthrough-coachmark-step')).toBeNull();
      expect(onAnchorMiss).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unregistered' }),
      );
    });
    unmount();
  });

  it('FEAT-005 PBI-006 AC-3: external CTA route is not rendered as navigation', async () => {
    const { unmount } = renderRenderer({
      id: 'wt-ext',
      revision: 1,
      title: 'External',
      steps: [
        {
          id: 'e0',
          position: 0,
          heading: 'Stay put',
          bodyMarkdown: 'No external CTA',
          ctaLabel: 'Leave Apex',
          ctaRoute: 'https://evil.example',
          anchor: null,
        },
      ],
    });

    expect(screen.getByTestId('walkthrough-modal-step')).toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-cta')).toBeNull();
    unmount();
  });

  it('VT-11: centered dialog exposes accessible name and Escape dismisses', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const onDismiss = jest.fn();
    const { unmount } = renderRenderer(centeredDef, { onDismiss });

    const dialog = screen.getByRole('dialog', { name: 'Welcome' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByTestId('walkthrough-next')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalled();
    unmount();
  });

  it('DoD-3: does not introduce a tour-engine API — controlled props only', () => {
    expect(typeof WalkthroughRenderer).toBe('function');
    const { unmount } = renderRenderer(centeredDef, { open: false });
    expect(screen.queryByTestId('walkthrough-renderer')).toBeNull();
    unmount();
  });

  it('callback failure preserves visible content', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { unmount } = renderRenderer(centeredDef, {
      onStepChange: () => {
        throw new Error('boom');
      },
      onComplete: () => {
        throw new Error('boom');
      },
    });

    await user.click(screen.getByTestId('walkthrough-next'));
    expect(screen.getByText('Next topic')).toBeInTheDocument();
    unmount();
  });
});
