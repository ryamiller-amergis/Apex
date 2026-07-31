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
});

