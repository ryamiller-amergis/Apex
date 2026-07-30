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
import * as coachmarkLayout from '../../utils/walkthroughCoachmarkLayout';

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

  it('contains portal overflow so opening a walkthrough cannot shift header chrome', () => {
    const { unmount } = renderRenderer(centeredDef);
    const root = screen.getByTestId('walkthrough-renderer');
    // CSS modules are stubbed in Jest; assert the containment class is applied.
    // WalkthroughRenderer.module.css sets position:fixed; overflow:hidden; contain:layout paint.
    expect(root.className).toMatch(/renderer/);
    unmount();
  });

  it('does not re-fire onStepChange when callback identity changes', () => {
    const onStepChange = jest.fn();
    const { rerender, unmount } = renderRenderer(centeredDef, { onStepChange });

    expect(onStepChange).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter initialEntries={['/home']}>
        <WalkthroughRenderer
          definition={centeredDef}
          open
          onStepChange={() => onStepChange()}
        />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter initialEntries={['/home']}>
        <WalkthroughRenderer
          definition={centeredDef}
          open
          onStepChange={() => onStepChange()}
        />
      </MemoryRouter>,
    );

    expect(onStepChange).toHaveBeenCalledTimes(1);
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
            testId: 'user-menu-trigger',
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
            testId: 'user-menu-trigger',
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
    expect(onAnchorMiss.mock.calls[0][0].occurrenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    unmount();
  });

  it('PBI-011 AC-1 — centered fallback remains when onAnchorMiss throws', async () => {
    const onAnchorMiss = jest.fn(() => {
      throw new Error('ingest failed');
    });
    const def: WalkthroughRendererDefinition = {
      id: 'wt-fail',
      revision: 1,
      title: 'Fail ingest',
      steps: [
        {
          id: 'm0',
          position: 0,
          heading: 'Still usable',
          bodyMarkdown: 'Fallback content',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
          },
        },
      ],
    };

    const { unmount } = renderRenderer(def, { onAnchorMiss, playbackSessionId: 'play-fail' });
    act(() => {
      jest.advanceTimersByTime(ANCHOR_WAIT_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-anchor-fallback')).toBeInTheDocument();
      expect(screen.getByText('Still usable')).toBeInTheDocument();
    });
    expect(onAnchorMiss).toHaveBeenCalled();
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

  it('PBI-011 AC-2 — successful anchor resolve does not emit miss', async () => {
    const onAnchorMiss = jest.fn();
    const target = document.createElement('button');
    target.setAttribute('data-testid', 'user-menu-trigger');
    document.body.appendChild(target);

    const def: WalkthroughRendererDefinition = {
      id: 'wt-hit',
      revision: 1,
      title: 'Hit',
      steps: [
        {
          id: 'h0',
          position: 0,
          heading: 'Found',
          bodyMarkdown: 'Anchored',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
          },
        },
      ],
    };

    const { unmount } = renderRenderer(def, { onAnchorMiss, playbackSessionId: 'play-hit' });
    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-coachmark-step')).toBeInTheDocument();
    });
    act(() => {
      jest.advanceTimersByTime(ANCHOR_WAIT_MS);
    });
    expect(onAnchorMiss).not.toHaveBeenCalled();
    unmount();
    target.remove();
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

  it('renders imageAlt from step definition', () => {
    const def: WalkthroughRendererDefinition = {
      id: 'wt-alt',
      revision: 1,
      title: 'Alt test',
      steps: [
        {
          id: 's0',
          position: 0,
          heading: 'Logo step',
          bodyMarkdown: 'Shows logo',
          imageUrl: '/brand-lockup.svg',
          imageAlt: 'Apex logo',
          anchor: null,
        },
      ],
    };
    const { unmount } = renderRenderer(def);
    const img = screen.getByAltText('Apex logo');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/brand-lockup.svg');
    unmount();
  });

  it('falls back to empty alt when imageAlt is absent', () => {
    const def: WalkthroughRendererDefinition = {
      id: 'wt-noalt',
      revision: 1,
      title: 'No alt test',
      steps: [
        {
          id: 's0',
          position: 0,
          heading: 'Image step',
          bodyMarkdown: 'Shows img',
          imageUrl: '/some-image.png',
          anchor: null,
        },
      ],
    };
    const { unmount } = renderRenderer(def);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('alt', '');
    unmount();
  });

  it('resolves theme-aware logo URL for dark theme', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const def: WalkthroughRendererDefinition = {
      id: 'wt-theme',
      revision: 1,
      title: 'Theme test',
      steps: [
        {
          id: 's0',
          position: 0,
          heading: 'Dark logo',
          bodyMarkdown: 'Should use inverse',
          imageUrl: '/brand-lockup.svg',
          imageAlt: 'Apex logo',
          anchor: null,
        },
      ],
    };
    const { unmount } = renderRenderer(def);
    const img = screen.getByAltText('Apex logo');
    expect(img).toHaveAttribute('src', '/brand-lockup-inverse.svg');
    document.documentElement.setAttribute('data-theme', 'light');
    unmount();
  });

  it('keeps non-registry image URL unchanged regardless of theme', () => {
    document.documentElement.setAttribute('data-theme', 'midnight');
    const def: WalkthroughRendererDefinition = {
      id: 'wt-custom',
      revision: 1,
      title: 'Custom image',
      steps: [
        {
          id: 's0',
          position: 0,
          heading: 'Custom',
          bodyMarkdown: 'Custom img',
          imageUrl: '/custom/banner.png',
          imageAlt: 'A banner',
          anchor: null,
        },
      ],
    };
    const { unmount } = renderRenderer(def);
    const img = screen.getByAltText('A banner');
    expect(img).toHaveAttribute('src', '/custom/banner.png');
    document.documentElement.setAttribute('data-theme', 'light');
    unmount();
  });

  it('scrolls the next anchored target into view when advancing steps', async () => {
    const scrollSpy = jest.spyOn(coachmarkLayout, 'scrollWalkthroughAnchorIntoView');

    const first = document.createElement('button');
    first.setAttribute('data-testid', 'user-menu-trigger');
    first.textContent = 'Menu';
    const second = document.createElement('section');
    second.setAttribute('data-testid', 'profile-bio-section');
    second.textContent = 'Bio section';
    document.body.append(first, second);

    const def: WalkthroughRendererDefinition = {
      id: 'wt-scroll',
      revision: 1,
      title: 'Scroll tour',
      steps: [
        {
          id: 's0',
          position: 0,
          heading: 'Open menu',
          bodyMarkdown: 'Start here',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
          },
        },
        {
          id: 's1',
          position: 1,
          heading: 'Edit bio',
          bodyMarkdown: 'Further down',
          route: '/profile',
          anchor: {
            key: 'profile-bio',
            targetRoute: '/profile',
            placement: 'bottom',
            testId: 'profile-bio-section',
          },
        },
      ],
    };

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { unmount } = renderRenderer(def);

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-coachmark-step')).toBeInTheDocument();
    });
    expect(scrollSpy).toHaveBeenCalledWith(
      first,
      expect.objectContaining({ preferred: 'bottom' }),
    );
    scrollSpy.mockClear();

    await user.click(screen.getByTestId('walkthrough-next'));

    await waitFor(() => {
      expect(screen.getByText('Edit bio')).toBeInTheDocument();
      expect(scrollSpy).toHaveBeenCalledWith(
        second,
        expect.objectContaining({ preferred: 'bottom' }),
      );
    });

    scrollSpy.mockRestore();
    unmount();
    first.remove();
    second.remove();
  });
});
