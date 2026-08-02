/**
 * TBI-003 — Walkthrough DOM markers + catalog-injected validation
 * DoD-0 / DoD-1 / DoD-2 + VT-01–VT-04
 */
import {
  WalkthroughAnchorKeys,
  WALKTHROUGH_ANCHOR_MARKER_ATTR,
  anchorTestIdProps,
  getWalkthroughAnchor,
  listWalkthroughAnchors,
  validateRegisteredAnchor,
  validateRegistryEntryCandidate,
} from '../../shared/walkthroughAnchors';
import { validateAnchor } from '../../shared/types/walkthrough';

const CATALOG = listWalkthroughAnchors();

describe('WalkthroughAnchors DOM markers + catalog validation (TBI-003 / Phase 6)', () => {
  it('DoD-0 / VT-01: exposes DOM marker keys deterministically, uniquely, and immutably', () => {
    const listed = listWalkthroughAnchors();
    expect(listed.length).toBeGreaterThan(0);
    expect(Object.isFrozen(listed)).toBe(true);

    const keys = listed.map((e) => e.key);
    const testIds = listed.map((e) => e.testId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(testIds).size).toBe(testIds.length);

    for (const entry of listed) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(getWalkthroughAnchor(entry.key)).toEqual(entry);
      expect(entry.targetRoute.startsWith('/')).toBe(true);
      expect(entry.allowedPlacements.length).toBeGreaterThan(0);
    }
  });

  it('DoD-1: anchorTestIdProps returns data-testid + explicit walkthrough marker', () => {
    const props = anchorTestIdProps(WalkthroughAnchorKeys.USER_MENU_TRIGGER);
    expect(props).toEqual({
      'data-testid': 'user-menu-trigger',
      [WALKTHROUGH_ANCHOR_MARKER_ATTR]: 'user-menu-trigger',
    });
    expect(props['data-testid']).toBe(
      getWalkthroughAnchor(WalkthroughAnchorKeys.USER_MENU_TRIGGER)!.testId,
    );
  });

  it('DoD-2 / VT-02: validation rejects unregistered keys against injected catalog', () => {
    const result = validateRegisteredAnchor(
      {
        key: 'not-a-real-anchor',
        targetRoute: '/home',
        placement: 'bottom',
      },
      CATALOG,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.field === 'anchor.key' && e.code === 'UNREGISTERED_KEY')).toBe(
        true,
      );
    }
    // Shape validation accepts unknown keys; catalog membership is separate.
    expect(
      validateAnchor({
        key: 'not-a-real-anchor',
        targetRoute: '/home',
        placement: 'bottom',
      }),
    ).toEqual({
      key: 'not-a-real-anchor',
      targetRoute: '/home',
      placement: 'bottom',
    });
  });

  it('DoD-2: rejects anchored Steps without target routes', () => {
    const result = validateRegisteredAnchor(
      {
        key: WalkthroughAnchorKeys.USER_MENU_TRIGGER,
        targetRoute: '',
        placement: 'bottom',
      } as never,
      CATALOG,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errors.some((e) => e.code === 'ROUTE_REQUIRED')).toBe(true);
    }
  });

  it('VT-03: integrity check rejects external/missing route or bad placement on candidates', () => {
    expect(
      validateRegistryEntryCandidate({
        key: 'x',
        targetRoute: 'https://evil.example',
        allowedPlacements: ['bottom'],
      }).some((e) => e.code === 'INVALID_ROUTE'),
    ).toBe(true);

    expect(
      validateRegistryEntryCandidate({
        key: 'x',
        targetRoute: '/home',
        allowedPlacements: ['diagonal' as never],
      }).some((e) => e.code === 'UNSUPPORTED_PLACEMENT'),
    ).toBe(true);
  });

  it('VT-04 / BR-013: rejects CSS selectors, DOM paths, and arbitrary test IDs', () => {
    for (const key of ['.user-menu', '#header > button', '//div[@id="x"]', 'arbitrary-testid']) {
      const result = validateRegisteredAnchor(
        {
          key,
          targetRoute: '/home',
          placement: 'bottom',
        },
        CATALOG,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('happy path: registered key + matching route + allowed placement succeeds', () => {
    const entry = getWalkthroughAnchor(WalkthroughAnchorKeys.USER_MENU_TRIGGER)!;
    const result = validateRegisteredAnchor(
      {
        key: entry.key,
        targetRoute: entry.targetRoute,
        placement: 'bottom',
      },
      CATALOG,
    );
    expect(result.ok).toBe(true);
    if (result.ok === true && 'entry' in result) {
      expect(result.anchor.key).toBe(entry.key);
      expect(result.entry.testId).toBe(entry.testId);
    }
  });
});

