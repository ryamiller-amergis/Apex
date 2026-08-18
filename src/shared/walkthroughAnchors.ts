/**
 * Walkthrough DOM markers + pure anchor shape validation (FEAT-002 / Phase 6).
 * Server-safe: no React, DOM, or router imports.
 *
 * Runtime / authoring allow-list is the approved+active DB catalog
 * (`walkthroughAnchorCatalogResolution` + `/walkthroughs/anchors`).
 * This module retains compile-time DOM opt-in markers and shared validation
 * helpers that accept an injected catalog snapshot.
 */

import type { WalkthroughAnchor, WalkthroughAnchorPlacement } from './types/walkthrough';
import { isWalkthroughRoute } from './walkthroughRoutes';

/** Cardinal placements supported by the curated registry (FEAT-002). */
export type WalkthroughRegistryPlacement = 'top' | 'right' | 'bottom' | 'left';

export const WALKTHROUGH_REGISTRY_PLACEMENTS: readonly WalkthroughRegistryPlacement[] = [
  'top',
  'right',
  'bottom',
  'left',
] as const;

export const DEFAULT_WALKTHROUGH_PLACEMENT: WalkthroughRegistryPlacement = 'bottom';

export const ANCHOR_WAIT_MS = 2500;

/** Explicit DOM attribute emitted by `anchorTestIdProps` for future scanners. */
export const WALKTHROUGH_ANCHOR_MARKER_ATTR = 'data-walkthrough-anchor' as const;

export interface WalkthroughAnchorRegistryEntry {
  /** Stable allow-list key selected by authoring / AI (not a CSS selector). */
  key: string;
  /** Value written to `data-testid` on the opted-in element. */
  testId: string;
  /** Human-readable label for Platform Admin authoring. */
  label: string;
  /** Relative in-app route required for anchored Steps using this key. */
  targetRoute: string;
  /** Allowed Floating UI placement preferences for this target. */
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  /**
   * Approved smart tags for this anchor (route/tag filtering in authoring UIs).
   * Optional: compile-time DOM markers do not carry tags.
   */
  smartTags?: readonly string[];
  /**
   * Repository locations where the target data-testid was discovered.
   * Generation uses this evidence to inspect conditional/modal rendering.
   */
  sourceLocations?: readonly {
    filePath: string;
    line?: number | null;
  }[];
  /**
   * Ordered catalog keys that must be clicked to reveal this target.
   * Optional on compile-time DOM markers; catalog rows carry the full list.
   */
  openerAnchorKeys?: readonly string[];
}

export type WalkthroughAnchorValidationField =
  | 'anchor.key'
  | 'anchor.targetRoute'
  | 'anchor.placement'
  | 'anchor';

export interface WalkthroughAnchorValidationError {
  field: WalkthroughAnchorValidationField;
  message: string;
  code:
    | 'UNREGISTERED_KEY'
    | 'ROUTE_REQUIRED'
    | 'ROUTE_MISMATCH'
    | 'INVALID_ROUTE'
    | 'UNSUPPORTED_PLACEMENT'
    | 'REJECTED_SELECTOR'
    | 'INCOMPLETE_ANCHOR';
}

export type WalkthroughAnchorValidationResult =
  | { ok: true; anchor: null }
  | { ok: true; anchor: NonNullable<WalkthroughAnchor>; entry: WalkthroughAnchorRegistryEntry }
  | { ok: false; errors: WalkthroughAnchorValidationError[] };

/**
 * Compile-time DOM opt-in markers (key → data-testid).
 * Not the authoring / playback allow-list — that lives in the DB catalog.
 */
const DOM_MARKER_ENTRIES: readonly WalkthroughAnchorRegistryEntry[] = Object.freeze([
  Object.freeze({
    key: 'user-menu-trigger',
    testId: 'user-menu-trigger',
    label: 'User menu',
    targetRoute: '/home',
    allowedPlacements: Object.freeze(['bottom', 'left', 'right', 'top'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'whats-new-modal',
    testId: 'whats-new-modal',
    label: "What's New modal",
    targetRoute: '/home',
    allowedPlacements: Object.freeze(['bottom', 'top', 'left', 'right'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'user-menu-profile',
    testId: 'user-menu-profile',
    label: 'Profile menu item',
    targetRoute: '/home',
    allowedPlacements: Object.freeze(['left', 'right', 'bottom', 'top'] as WalkthroughRegistryPlacement[]),
  }),
  // Profile section cards sit in a multi-column layout — only allow top/bottom so
  // coachmarks stay attached to the section instead of flipping over a sibling column.
  Object.freeze({
    key: 'profile-identity',
    testId: 'profile-identity-section',
    label: 'Profile — Identity',
    targetRoute: '/profile',
    allowedPlacements: Object.freeze(['bottom', 'top'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'profile-bio',
    testId: 'profile-bio-section',
    label: 'Profile — Bio',
    targetRoute: '/profile',
    allowedPlacements: Object.freeze(['bottom', 'top'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'profile-theme',
    testId: 'profile-theme-section',
    label: 'Profile — Theme',
    targetRoute: '/profile',
    allowedPlacements: Object.freeze(['bottom', 'top'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'profile-notifications',
    testId: 'profile-notification-section',
    label: 'Profile — Notifications',
    targetRoute: '/profile',
    allowedPlacements: Object.freeze(['top', 'bottom'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'work-board-view',
    testId: 'work-board-view',
    label: 'Work Board — root view',
    targetRoute: '/work-board',
    allowedPlacements: Object.freeze(['bottom', 'top', 'left', 'right'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'work-board-lens-toggle',
    testId: 'work-board-lens-toggle',
    label: 'Work Board — status / release lens',
    targetRoute: '/work-board',
    allowedPlacements: Object.freeze(['bottom', 'top', 'left', 'right'] as WalkthroughRegistryPlacement[]),
  }),
  Object.freeze({
    key: 'work-board-backlog-toggle',
    testId: 'work-board-backlog-toggle',
    label: 'Work Board — board / backlog toggle',
    targetRoute: '/work-board',
    allowedPlacements: Object.freeze(['bottom', 'top', 'left', 'right'] as WalkthroughRegistryPlacement[]),
  }),
]);

const DOM_BY_KEY = new Map(DOM_MARKER_ENTRIES.map((e) => [e.key, e]));
const DOM_BY_TEST_ID = new Map(DOM_MARKER_ENTRIES.map((e) => [e.testId, e]));

function assertDomMarkerIntegrity(entries: readonly WalkthroughAnchorRegistryEntry[]): void {
  const keys = new Set<string>();
  const testIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.key.trim()) {
      throw new Error('Walkthrough DOM marker entry missing key');
    }
    if (!entry.testId.trim()) {
      throw new Error(`Walkthrough DOM marker entry "${entry.key}" missing testId`);
    }
    if (!isWalkthroughRoute(entry.targetRoute)) {
      throw new Error(
        `Walkthrough DOM marker entry "${entry.key}" has invalid targetRoute: ${entry.targetRoute}`,
      );
    }
    if (!entry.allowedPlacements.length) {
      throw new Error(`Walkthrough DOM marker entry "${entry.key}" has no placements`);
    }
    for (const p of entry.allowedPlacements) {
      if (!(WALKTHROUGH_REGISTRY_PLACEMENTS as readonly string[]).includes(p)) {
        throw new Error(
          `Walkthrough DOM marker entry "${entry.key}" has unsupported placement: ${p}`,
        );
      }
    }
    if (keys.has(entry.key)) {
      throw new Error(`Duplicate walkthrough DOM marker key: ${entry.key}`);
    }
    if (testIds.has(entry.testId)) {
      throw new Error(`Duplicate walkthrough DOM marker testId: ${entry.testId}`);
    }
    keys.add(entry.key);
    testIds.add(entry.testId);
  }
}

assertDomMarkerIntegrity(DOM_MARKER_ENTRIES);

/**
 * Compile-time DOM markers (not the runtime allow-list).
 * Prefer catalog snapshots from `/api/platform-admin/walkthroughs/anchors` for authoring.
 * Kept for scanner key→testId resolution and baseline seed integrity checks.
 */
export function listWalkthroughAnchors(): readonly WalkthroughAnchorRegistryEntry[] {
  return DOM_MARKER_ENTRIES;
}

/** @deprecated Prefer catalog snapshots; retained for DOM marker / scanner lookups. */
export function getWalkthroughAnchor(key: string): WalkthroughAnchorRegistryEntry | undefined {
  return DOM_BY_KEY.get(key);
}

/** @deprecated Prefer catalog snapshots; retained for DOM marker / scanner lookups. */
export function getWalkthroughAnchorByTestId(
  testId: string,
): WalkthroughAnchorRegistryEntry | undefined {
  return DOM_BY_TEST_ID.get(testId);
}

/**
 * Map a catalog runtime row into the authoring entry shape used by editors / AI.
 * Empty `targetRoute` means the catalog leaves route unconstrained.
 */
export function toAuthoringAnchorEntry(input: {
  anchorKey: string;
  testId: string;
  label: string;
  targetRoute: string | null;
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  smartTags?: readonly string[];
  openerAnchorKeys?: readonly string[];
  sourceLocations?: readonly {
    filePath: string;
    line?: number | null;
  }[];
}): WalkthroughAnchorRegistryEntry {
  return {
    key: input.anchorKey,
    testId: input.testId,
    label: input.label,
    targetRoute: input.targetRoute ?? '',
    allowedPlacements: input.allowedPlacements,
    smartTags: input.smartTags ?? [],
    openerAnchorKeys: input.openerAnchorKeys ?? [],
    sourceLocations: input.sourceLocations ?? [],
  };
}

/**
 * Props to spread onto an opted-in element so the renderer / scanners can find it.
 * Emits `data-testid` plus an explicit `data-walkthrough-anchor` marker.
 */
export function anchorTestIdProps(key: string): {
  'data-testid': string;
  'data-walkthrough-anchor': string;
} {
  const entry = DOM_BY_KEY.get(key);
  if (!entry) {
    throw new Error(`Unknown walkthrough DOM marker key: ${key}`);
  }
  return {
    'data-testid': entry.testId,
    [WALKTHROUGH_ANCHOR_MARKER_ATTR]: entry.key,
  };
}

/** Exported constants for component opt-in without magic strings. */
export const WalkthroughAnchorKeys = {
  USER_MENU_TRIGGER: 'user-menu-trigger',
  WHATS_NEW_MODAL: 'whats-new-modal',
  USER_MENU_PROFILE: 'user-menu-profile',
  PROFILE_IDENTITY: 'profile-identity',
  PROFILE_BIO: 'profile-bio',
  PROFILE_THEME: 'profile-theme',
  PROFILE_NOTIFICATIONS: 'profile-notifications',
} as const;

export type WalkthroughAnchorKey =
  (typeof WalkthroughAnchorKeys)[keyof typeof WalkthroughAnchorKeys];

function looksLikeSelectorSyntax(value: string): boolean {
  return /[#.[\]>+~*=]|^\s*\/\//.test(value) || value.includes(' ');
}

export function isValidInAppWalkthroughRoute(route: string): boolean {
  return isWalkthroughRoute(route);
}

/**
 * Validate an anchored Step against an injected catalog snapshot (approved+active).
 * Rejects CSS/DOM/arbitrary selectors — only exact catalog keys are accepted.
 */
export function validateRegisteredAnchor(
  anchor: WalkthroughAnchor | undefined | null,
  catalog: readonly WalkthroughAnchorRegistryEntry[],
): WalkthroughAnchorValidationResult {
  if (anchor === undefined || anchor === null) {
    return { ok: true, anchor: null };
  }

  const byKey = new Map(catalog.map((e) => [e.key, e]));
  const errors: WalkthroughAnchorValidationError[] = [];
  const key = typeof anchor.key === 'string' ? anchor.key.trim() : '';
  const targetRoute = typeof anchor.targetRoute === 'string' ? anchor.targetRoute : '';
  const placement = anchor.placement;

  if (!key) {
    errors.push({
      field: 'anchor.key',
      code: 'UNREGISTERED_KEY',
      message: 'Anchor key is required for anchored Steps',
    });
  } else if (looksLikeSelectorSyntax(key)) {
    errors.push({
      field: 'anchor.key',
      code: 'REJECTED_SELECTOR',
      message: 'Anchor key must be an exact registry key, not a CSS selector or DOM path',
    });
  }

  if (!targetRoute) {
    errors.push({
      field: 'anchor.targetRoute',
      code: 'ROUTE_REQUIRED',
      message: 'Anchored Steps require a targetRoute',
    });
  } else if (!isValidInAppWalkthroughRoute(targetRoute)) {
    errors.push({
      field: 'anchor.targetRoute',
      code: 'INVALID_ROUTE',
      message: 'targetRoute must be a relative allow-listed in-app route',
    });
  }

  const entry = key ? byKey.get(key) : undefined;
  if (key && !looksLikeSelectorSyntax(key) && !entry) {
    errors.push({
      field: 'anchor.key',
      code: 'UNREGISTERED_KEY',
      message: `Unregistered anchor key: ${key}`,
    });
  }

  // Empty catalog targetRoute means unconstrained at catalog level.
  if (entry && entry.targetRoute && targetRoute && targetRoute !== entry.targetRoute) {
    errors.push({
      field: 'anchor.targetRoute',
      code: 'ROUTE_MISMATCH',
      message: `targetRoute must match registry entry "${entry.key}" (${entry.targetRoute})`,
    });
  }

  const placementStr = typeof placement === 'string' ? placement : '';
  if (!placementStr) {
    errors.push({
      field: 'anchor.placement',
      code: 'UNSUPPORTED_PLACEMENT',
      message: 'Anchor placement is required',
    });
  } else if (
    entry &&
    !(entry.allowedPlacements as readonly string[]).includes(placementStr)
  ) {
    errors.push({
      field: 'anchor.placement',
      code: 'UNSUPPORTED_PLACEMENT',
      message: `Placement "${placementStr}" is not allowed for anchor "${entry.key}"`,
    });
  } else if (
    !entry &&
    !(WALKTHROUGH_REGISTRY_PLACEMENTS as readonly string[]).includes(placementStr)
  ) {
    errors.push({
      field: 'anchor.placement',
      code: 'UNSUPPORTED_PLACEMENT',
      message: `Unsupported anchor placement: ${placementStr}`,
    });
  }

  if (errors.length > 0 || !entry) {
    return { ok: false, errors: errors.length ? errors : [{
      field: 'anchor.key',
      code: 'UNREGISTERED_KEY',
      message: 'Unregistered anchor key',
    }] };
  }

  return {
    ok: true,
    anchor: {
      key: entry.key,
      targetRoute: targetRoute || entry.targetRoute,
      placement: placementStr as WalkthroughAnchorPlacement,
    },
    entry,
  };
}

/**
 * Integrity helper for registry unit tests / startup checks.
 * Returns field errors for a candidate entry shape (does not mutate registry).
 */
export function validateRegistryEntryCandidate(
  candidate: Partial<WalkthroughAnchorRegistryEntry>,
): WalkthroughAnchorValidationError[] {
  const errors: WalkthroughAnchorValidationError[] = [];
  if (!candidate.key?.trim()) {
    errors.push({
      field: 'anchor.key',
      code: 'UNREGISTERED_KEY',
      message: 'Registry entry key is required',
    });
  }
  if (!candidate.targetRoute) {
    errors.push({
      field: 'anchor.targetRoute',
      code: 'ROUTE_REQUIRED',
      message: 'Registry entry targetRoute is required',
    });
  } else if (!isValidInAppWalkthroughRoute(candidate.targetRoute)) {
    errors.push({
      field: 'anchor.targetRoute',
      code: 'INVALID_ROUTE',
      message: 'Registry entry targetRoute must be a relative in-app route',
    });
  }
  if (!candidate.allowedPlacements?.length) {
    errors.push({
      field: 'anchor.placement',
      code: 'UNSUPPORTED_PLACEMENT',
      message: 'Registry entry must declare allowed placements',
    });
  } else {
    for (const p of candidate.allowedPlacements) {
      if (!(WALKTHROUGH_REGISTRY_PLACEMENTS as readonly string[]).includes(p)) {
        errors.push({
          field: 'anchor.placement',
          code: 'UNSUPPORTED_PLACEMENT',
          message: `Unsupported placement: ${p}`,
        });
      }
    }
  }
  return errors;
}

