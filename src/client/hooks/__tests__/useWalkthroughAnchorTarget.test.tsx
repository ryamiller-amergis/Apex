/**
 * TBI-004 — useWalkthroughAnchorTarget
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

describe('useWalkthroughAnchorTarget (TBI-004)', () => {
  it('DoD-1 / VT-06: navigates to registry route and resolves mounted target', async () => {
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
          activationKey: 'a1',
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
      expect(getPath()).toBe('/home');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('resolved');
      expect(result.current.targetElement).toBe(target);
    });

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
          },
        }),
      {
        wrapper: Wrapper,
        initialProps: { activationKey: 'step-a', stepId: 'a' },
      },
    );

    // Cancel step-a wait immediately by activating step-b.
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

  it('VT-10: mismatched route falls back defensively', async () => {
    const { Wrapper } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'mismatch',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/somewhere-else',
            placement: 'bottom',
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('fallback');
      expect(['route_mismatch', 'invalid_route']).toContain(result.current.missReason);
    });
  });
});
