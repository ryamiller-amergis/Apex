/**
 * Curated Walkthrough anchor registry (FEAT-002 / TBI-003).
 * Server-safe: no React, DOM, or router imports.
 *
 * Opted-in targets expose `data-testid={entry.testId}` (via `anchorTestIdProps`)
 * so the hybrid renderer can locate them without raw CSS selectors.
 */

import type { WalkthroughAnchor, WalkthroughAnchorPlacement } from './types/walkthrough';

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

const IN_APP_ROUTE_RE = /^\/[A-Za-z0-9/_-]*$/;

/**
 * Curated production targets. Keys and testIds are unique.
 * Components that opt in MUST set data-testid from these entries.
 */
const REGISTRY_ENTRIES: readonly WalkthroughAnchorRegistryEntry[] = Object.freeze([
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
]);

const BY_KEY = new Map(REGISTRY_ENTRIES.map((e) => [e.key, e]));
const BY_TEST_ID = new Map(REGISTRY_ENTRIES.map((e) => [e.testId, e]));

function assertRegistryIntegrity(entries: readonly WalkthroughAnchorRegistryEntry[]): void {
  const keys = new Set<string>();
  const testIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.key.trim()) {
      throw new Error('Walkthrough anchor registry entry missing key');
    }
    if (!entry.testId.trim()) {
      throw new Error(`Walkthrough anchor registry entry "${entry.key}" missing testId`);
    }
    if (!IN_APP_ROUTE_RE.test(entry.targetRoute)) {
      throw new Error(
        `Walkthrough anchor registry entry "${entry.key}" has invalid targetRoute: ${entry.targetRoute}`,
      );
    }
    if (!entry.allowedPlacements.length) {
      throw new Error(`Walkthrough anchor registry entry "${entry.key}" has no placements`);
    }
    for (const p of entry.allowedPlacements) {
      if (!(WALKTHROUGH_REGISTRY_PLACEMENTS as readonly string[]).includes(p)) {
        throw new Error(
          `Walkthrough anchor registry entry "${entry.key}" has unsupported placement: ${p}`,
        );
      }
    }
    if (keys.has(entry.key)) {
      throw new Error(`Duplicate walkthrough anchor key: ${entry.key}`);
    }
    if (testIds.has(entry.testId)) {
      throw new Error(`Duplicate walkthrough anchor testId: ${entry.testId}`);
    }
    keys.add(entry.key);
    testIds.add(entry.testId);
  }
}

assertRegistryIntegrity(REGISTRY_ENTRIES);

/** Immutable list of curated anchors for authoring / AI selection. */
export function listWalkthroughAnchors(): readonly WalkthroughAnchorRegistryEntry[] {
  return REGISTRY_ENTRIES;
}

export function getWalkthroughAnchor(key: string): WalkthroughAnchorRegistryEntry | undefined {
  return BY_KEY.get(key);
}

export function getWalkthroughAnchorByTestId(
  testId: string,
): WalkthroughAnchorRegistryEntry | undefined {
  return BY_TEST_ID.get(testId);
}

/**
 * Props to spread onto an opted-in element so the renderer can find it.
 * Prefer this over duplicating string literals.
 */
export function anchorTestIdProps(key: string): { 'data-testid': string } {
  const entry = BY_KEY.get(key);
  if (!entry) {
    throw new Error(`Unknown walkthrough anchor key: ${key}`);
  }
  return { 'data-testid': entry.testId };
}

/** Exported constants for component opt-in without magic strings. */
export const WalkthroughAnchorKeys = {
  USER_MENU_TRIGGER: 'user-menu-trigger',
  WHATS_NEW_MODAL: 'whats-new-modal',
} as const;

export type WalkthroughAnchorKey =
  (typeof WalkthroughAnchorKeys)[keyof typeof WalkthroughAnchorKeys];

function looksLikeSelectorSyntax(value: string): boolean {
  return /[#.[\]>+~*=]|^\s*\/\//.test(value) || value.includes(' ');
}

export function isValidInAppWalkthroughRoute(route: string): boolean {
  if (!route || typeof route !== 'string') return false;
  if (/^(https?:)?\/\//i.test(route)) return false;
  if (route.startsWith('?') || route.startsWith('#')) return false;
  return IN_APP_ROUTE_RE.test(route);
}

/**
 * Validate an anchored Step against the curated registry.
 * Rejects CSS/DOM/arbitrary test IDs — only exact registry keys are accepted.
 */
export function validateRegisteredAnchor(
  anchor: WalkthroughAnchor | undefined | null,
): WalkthroughAnchorValidationResult {
  if (anchor === undefined || anchor === null) {
    return { ok: true, anchor: null };
  }

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

  const entry = key ? BY_KEY.get(key) : undefined;
  if (key && !looksLikeSelectorSyntax(key) && !entry) {
    errors.push({
      field: 'anchor.key',
      code: 'UNREGISTERED_KEY',
      message: `Unregistered anchor key: ${key}`,
    });
  }

  if (entry && targetRoute && targetRoute !== entry.targetRoute) {
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
      targetRoute: entry.targetRoute,
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
