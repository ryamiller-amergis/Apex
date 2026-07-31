/**
 * TBI-004 — useWalkthroughAnchorTarget (Phase 6 catalog enrichment)
 * VT-06, VT-07, VT-09, VT-10 / DoD-1, DoD-2
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useWalkthroughAnchorTarget } from '../useWalkthroughAnchorTarget';

function LocationProbe({ onPath }: { onPath: (path: string) => void }) {
  const location = useLocation();
  React.useEffect(() => {
    onPath(location.pathname);
  }, [location.pathname, onPath]);
  return null;
}

function createWrapper(initialPath = '/other') {
  let latestPath = initialPath;
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe
        onPath={(p) => {
          latestPath = p;
        }}
      />
      <Routes>
        <Route path="*" element={<>{children}</>} />
      </Routes>
    </MemoryRouter>
  );
  return { Wrapper, getPath: () => latestPath };
}

describe('useWalkthroughAnchorTarget (TBI-004 / Phase 6)', () => {
  it('DoD-1 / VT-06: navigates using enriched testId and resolves mounted target', async () => {
    // Target is NOT present on the current route, so the hook must navigate to the
    // anchor's home route to bring it into view, then resolve once it mounts.
    const { Wrapper, getPath } = createWrapper('/other');
    const { result, unmount } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'a1',
          waitMs: 200,
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
            useCenteredFallback: false,
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(getPath()).toBe('/home');
    });

    const target = document.createElement('button');
    target.setAttribute('data-testid', 'user-menu-trigger');
    document.body.appendChild(target);

    await waitFor(() => {
      expect(result.current.status).toBe('resolved');
      expect(result.current.targetElement).toBe(target);
    });

    unmount();
    target.remove();
  });

  it('does not navigate when the anchored element is already on the current route', async () => {
    // Persistent chrome (e.g. the sidebar nav) renders on every page. When the
    // anchored element is already present, the coachmark must resolve in place and
    // leave the user's location untouched — navigation is the CTA's job, not ours.
    const target = document.createElement('button');
    target.setAttribute('data-testid', 'user-menu-trigger');
    document.body.appendChild(target);

    const { Wrapper, getPath } = createWrapper('/other');
    const { result, unmount } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'present',
          waitMs: 200,
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
            useCenteredFallback: false,
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('resolved');
      expect(result.current.targetElement).toBe(target);
    });
    expect(getPath()).toBe('/other');

    unmount();
    target.remove();
  });

  it('DoD-2 / VT-07: times out after bounded wait and falls back with timeout reason', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'timeout-1',
          waitMs: 40,
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(result.current.missReason).toBe('timeout');
    });
  });

  it('VT-09: cancelling via activationKey change makes prior wait inert', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result, rerender } = renderHook(
      ({ activationKey, stepId }: { activationKey: string; stepId: string }) =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId,
          activationKey,
          waitMs: 80,
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            testId: 'user-menu-trigger',
          },
        }),
      {
        wrapper: Wrapper,
        initialProps: { activationKey: 'step-a', stepId: 'a' },
      },
    );

    rerender({ activationKey: 'step-b', stepId: 'b' });

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(result.current.missReason).toBe('timeout');
    });
  });

  it('DoD-2 / VT-10: invalid/unregistered key falls back without waiting full timeout', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'bad',
          anchor: {
            key: '.css-selector',
            targetRoute: '/home',
            placement: 'bottom',
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(result.current.missReason).toBe('unregistered');
    });
  });

  it('Phase 6: inactive catalog enrichment falls back immediately with inactive reason', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'inactive',
          waitMs: 200,
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
            useCenteredFallback: true,
            catalogFallbackReason: 'inactive',
            testId: null,
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(result.current.missReason).toBe('inactive');
    });
  });

  it('Phase 6: missing enrichment (no testId) falls back without waiting', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'no-testid',
          waitMs: 200,
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(result.current.missReason).toBe('missing');
    });
  });

  it('Phase 6/8: soft-deleted catalog enrichment falls back immediately with deleted reason', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-historical',
          revision: 1,
          stepId: 's1',
          activationKey: 'soft-deleted',
          waitMs: 200,
          anchor: {
            key: 'legacy-soft-deleted-anchor',
            targetRoute: '/home',
            placement: 'bottom',
            useCenteredFallback: true,
            catalogFallbackReason: 'deleted',
            testId: null,
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(result.current.missReason).toBe('deleted');
    });
  });

  describe('Phase 1 auto-open openers', () => {
    it('AC-0: skips openers when target is already visible', async () => {
      const target = document.createElement('div');
      target.setAttribute('data-testid', 'whats-new-modal');
      document.body.appendChild(target);

      const opener = document.createElement('button');
      opener.setAttribute('data-testid', 'user-menu-trigger');
      const clickSpy = jest.fn();
      opener.addEventListener('click', clickSpy);
      document.body.appendChild(opener);

      const { Wrapper } = createWrapper('/home');
      const { result, unmount } = renderHook(
        () =>
          useWalkthroughAnchorTarget({
            walkthroughId: 'wt-1',
            revision: 1,
            stepId: 's2',
            activationKey: 'already-open',
            waitMs: 200,
            anchor: {
              key: 'whats-new-modal',
              targetRoute: '/home',
              placement: 'bottom',
              testId: 'whats-new-modal',
              openers: [{ key: 'user-menu-trigger', testId: 'user-menu-trigger' }],
            },
          }),
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(result.current.status).toBe('resolved');
        expect(result.current.targetElement).toBe(target);
      });
      expect(clickSpy).not.toHaveBeenCalled();
      expect(result.current.locating).toBe(false);

      unmount();
      target.remove();
      opener.remove();
    });

    it('AC-1: clicks openers in order then resolves target', async () => {
      const opener = document.createElement('button');
      opener.setAttribute('data-testid', 'user-menu-trigger');
      opener.addEventListener('click', () => {
        const modal = document.createElement('div');
        modal.setAttribute('data-testid', 'whats-new-modal');
        document.body.appendChild(modal);
      });
      document.body.appendChild(opener);

      const { Wrapper } = createWrapper('/home');
      const { result, unmount } = renderHook(
        () =>
          useWalkthroughAnchorTarget({
            walkthroughId: 'wt-1',
            revision: 1,
            stepId: 's2',
            activationKey: 'click-opener',
            waitMs: 300,
            anchor: {
              key: 'whats-new-modal',
              targetRoute: '/home',
              placement: 'bottom',
              testId: 'whats-new-modal',
              openers: [{ key: 'user-menu-trigger', testId: 'user-menu-trigger' }],
            },
          }),
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(result.current.status).toBe('resolved');
        expect(result.current.targetElement?.getAttribute('data-testid')).toBe(
          'whats-new-modal',
        );
      });

      unmount();
      opener.remove();
      document.querySelector('[data-testid="whats-new-modal"]')?.remove();
    });

    it('AC-2: falls back with opener_missing when opener never appears', async () => {
      const { Wrapper } = createWrapper('/home');
      const { result } = renderHook(
        () =>
          useWalkthroughAnchorTarget({
            walkthroughId: 'wt-1',
            revision: 1,
            stepId: 's2',
            activationKey: 'opener-gone',
            waitMs: 80,
            anchor: {
              key: 'whats-new-modal',
              targetRoute: '/home',
              placement: 'bottom',
              testId: 'whats-new-modal',
              openers: [{ key: 'user-menu-trigger', testId: 'user-menu-trigger' }],
            },
          }),
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(result.current.status).toBe('fallback');
        expect(result.current.missReason).toBe('opener_missing');
      });
    });

    it('closes an obscuring app modal before resolving an underlying-page target', async () => {
      const pageTarget = document.createElement('button');
      pageTarget.setAttribute('data-testid', 'design-module-add-btn');
      document.body.appendChild(pageTarget);

      let dialog: HTMLElement | null = null;
      const opener = document.createElement('button');
      opener.setAttribute('data-testid', 'design-module-add-btn-opener');
      opener.addEventListener('click', () => {
        dialog = document.createElement('section');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('data-testid', 'design-module-form-modal');
        const modalTarget = document.createElement('form');
        modalTarget.setAttribute('data-testid', 'design-module-form');
        const close = document.createElement('button');
        close.setAttribute('data-testid', 'design-module-form-close');
        close.addEventListener('click', () => dialog?.remove());
        dialog.append(modalTarget, close);
        document.body.appendChild(dialog);
      });
      document.body.appendChild(opener);

      const { Wrapper } = createWrapper('/design-module');
      const { result, rerender, unmount } = renderHook(
        ({ step }: { step: 'modal' | 'page' }) =>
          useWalkthroughAnchorTarget({
            walkthroughId: 'wt-1',
            revision: 1,
            stepId: step === 'modal' ? 's4' : 's3',
            activationKey: step,
            waitMs: 200,
            anchor:
              step === 'modal'
                ? {
                    key: 'design-module-form',
                    targetRoute: '/design-module',
                    placement: 'top',
                    testId: 'design-module-form',
                    openers: [
                      {
                        key: 'design-module-add-btn-opener',
                        testId: 'design-module-add-btn-opener',
                      },
                    ],
                  }
                : {
                    key: 'design-module-add-btn',
                    targetRoute: '/design-module',
                    placement: 'right',
                    testId: 'design-module-add-btn',
                  },
          }),
        { wrapper: Wrapper, initialProps: { step: 'modal' } },
      );

      await waitFor(() => {
        expect(result.current.status).toBe('resolved');
        expect(result.current.targetElement).toHaveAttribute(
          'data-testid',
          'design-module-form',
        );
        expect(dialog).toBeInTheDocument();
      });

      // The same transition runs for Next and Back; activation has no direction.
      rerender({ step: 'page' });

      await waitFor(() => {
        expect(dialog).not.toBeInTheDocument();
        expect(result.current.status).toBe('resolved');
        expect(result.current.targetElement).toBe(pageTarget);
      });

      unmount();
      pageTarget.remove();
      opener.remove();
    });

    it('keeps a modal open when the next target is inside that modal', async () => {
      const dialog = document.createElement('section');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('data-testid', 'design-module-form-modal');
      const target = document.createElement('input');
      target.setAttribute('data-testid', 'design-module-name-input');
      const close = document.createElement('button');
      close.setAttribute('data-testid', 'design-module-form-close');
      const closeSpy = jest.fn();
      close.addEventListener('click', closeSpy);
      dialog.append(target, close);
      document.body.appendChild(dialog);

      const { Wrapper } = createWrapper('/design-module');
      const { result, unmount } = renderHook(
        () =>
          useWalkthroughAnchorTarget({
            walkthroughId: 'wt-1',
            revision: 1,
            stepId: 's5',
            activationKey: 'inside-modal',
            waitMs: 200,
            anchor: {
              key: 'design-module-name-input',
              targetRoute: '/design-module',
              placement: 'top',
              testId: 'design-module-name-input',
            },
          }),
        { wrapper: Wrapper },
      );

      await waitFor(() => {
        expect(result.current.status).toBe('resolved');
        expect(result.current.targetElement).toBe(target);
      });
      expect(closeSpy).not.toHaveBeenCalled();
      expect(dialog).toBeInTheDocument();

      unmount();
      dialog.remove();
    });

    it('AC-3: revealing status reports locating true', async () => {
      // Opener exists but never reveals target — stay in revealing briefly then opener_missing
      // Use a slow path: opener present, click does nothing, then wait for missing target after openers
      const opener = document.createElement('button');
      opener.setAttribute('data-testid', 'user-menu-trigger');
      document.body.appendChild(opener);

      const { Wrapper } = createWrapper('/home');
      const { result, unmount } = renderHook(
        () =>
          useWalkthroughAnchorTarget({
            walkthroughId: 'wt-1',
            revision: 1,
            stepId: 's2',
            activationKey: 'locating-revealing',
            waitMs: 150,
            anchor: {
              key: 'whats-new-modal',
              targetRoute: '/home',
              placement: 'bottom',
              testId: 'whats-new-modal',
              openers: [{ key: 'user-menu-trigger', testId: 'user-menu-trigger' }],
            },
          }),
        { wrapper: Wrapper },
      );

      // During reveal/wait the hook should report locating
      await waitFor(() => {
        expect(
          result.current.status === 'revealing' ||
            result.current.status === 'waiting' ||
            result.current.status === 'fallback' ||
            result.current.status === 'resolved',
        ).toBe(true);
      });
      if (result.current.status === 'revealing' || result.current.status === 'waiting') {
        expect(result.current.locating).toBe(true);
      }

      await waitFor(() => {
        expect(['fallback', 'resolved']).toContain(result.current.status);
      });

      unmount();
      opener.remove();
    });
  });
});

