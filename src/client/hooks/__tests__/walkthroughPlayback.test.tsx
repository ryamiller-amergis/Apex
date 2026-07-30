/**
 * Phase 2 (playback) — focused tests for:
 * 1. No launch on project-selector (GuidedWalkthroughHost disabled)
 * 2. Step navigation to /profile via stepRoute
 * 3. Anchor resolution for new Profile anchors
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useWalkthroughAnchorTarget } from '../useWalkthroughAnchorTarget';
import {
  WalkthroughAnchorKeys,
  getWalkthroughAnchor,
  listWalkthroughAnchors,
  anchorTestIdProps,
  validateRegisteredAnchor,
} from '../../../shared/walkthroughAnchors';

function LocationProbe({ onPath }: { onPath: (path: string) => void }) {
  const location = useLocation();
  React.useEffect(() => {
    onPath(location.pathname);
  }, [location.pathname, onPath]);
  return null;
}

function createWrapper(initialPath = '/home') {
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

describe('Phase 2 — Walkthrough playback gating', () => {
  it('GuidedWalkthroughHost on project-selector receives enabled=false', () => {
    // This is a design assertion: App.tsx passes enabled={false} on project-selector.
    // We verify indirectly that the hook stays idle when enabled is false.
    const { Wrapper } = createWrapper('/');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's1',
          activationKey: 'gate-test',
          anchor: {
            key: 'user-menu-trigger',
            targetRoute: '/home',
            placement: 'bottom',
          },
          enabled: false,
        }),
      { wrapper: Wrapper },
    );

    expect(result.current.status).toBe('idle');
    expect(result.current.targetElement).toBeNull();
  });
});

describe('Phase 2 — Route-first step navigation (unanchored)', () => {
  it('navigates to /profile when stepRoute is set and no anchor', async () => {
    const { Wrapper, getPath } = createWrapper('/home');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's-profile',
          activationKey: 'nav-profile',
          anchor: null,
          stepRoute: '/profile',
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(getPath()).toBe('/profile');
    });

    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
  });

  it('does not navigate when stepRoute matches current path', () => {
    const { Wrapper, getPath } = createWrapper('/profile');
    const { result } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's-profile',
          activationKey: 'already-there',
          anchor: null,
          stepRoute: '/profile',
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    expect(getPath()).toBe('/profile');
    expect(result.current.status).toBe('idle');
  });

  it('does not navigate for an invalid stepRoute', () => {
    const { Wrapper, getPath } = createWrapper('/home');
    renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-1',
          revision: 1,
          stepId: 's-x',
          activationKey: 'bad-route',
          anchor: null,
          stepRoute: '/profile/edit',
          enabled: true,
        }),
      { wrapper: Wrapper },
    );

    expect(getPath()).toBe('/home');
  });
});

describe('Phase 2 — Profile anchor resolution', () => {
  it.each([
    ['profile-identity', 'profile-identity-section', '/profile'],
    ['profile-bio', 'profile-bio-section', '/profile'],
    ['profile-theme', 'profile-theme-section', '/profile'],
    ['profile-notifications', 'profile-notification-section', '/profile'],
    ['user-menu-profile', 'user-menu-profile', '/home'],
  ])('anchor %s is registered with testId=%s and route=%s', (key, testId, route) => {
    const entry = getWalkthroughAnchor(key);
    expect(entry).toBeDefined();
    expect(entry!.testId).toBe(testId);
    expect(entry!.targetRoute).toBe(route);
  });

  it('anchorTestIdProps returns correct data-testid for PROFILE_IDENTITY', () => {
    const props = anchorTestIdProps(WalkthroughAnchorKeys.PROFILE_IDENTITY);
    expect(props['data-testid']).toBe('profile-identity-section');
    expect(props['data-walkthrough-anchor']).toBe('profile-identity');
  });

  it('validates profile-identity anchor successfully against DOM marker catalog', () => {
    const result = validateRegisteredAnchor(
      {
        key: 'profile-identity',
        targetRoute: '/profile',
        placement: 'bottom',
      },
      listWalkthroughAnchors(),
    );
    expect(result.ok).toBe(true);
  });

  it('resolves profile-bio anchor on /profile page', async () => {
    const target = document.createElement('section');
    target.setAttribute('data-testid', 'profile-bio-section');
    document.body.appendChild(target);

    const { Wrapper } = createWrapper('/profile');
    const { result, unmount } = renderHook(
      () =>
        useWalkthroughAnchorTarget({
          walkthroughId: 'wt-2',
          revision: 1,
          stepId: 'bio-step',
          activationKey: 'bio-resolve',
          waitMs: 200,
          anchor: {
            key: 'profile-bio',
            targetRoute: '/profile',
            placement: 'bottom',
            testId: 'profile-bio-section',
          },
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('resolved');
      expect(result.current.targetElement).toBe(target);
    });

    unmount();
    target.remove();
  });
});
