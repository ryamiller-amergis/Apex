/**
 * Smart Anchor Management — Wave 2 Track D.
 * Pure catalog resolution for authoring/playback enrichment from injected
 * registry records (fixtures or catalog snapshots).
 *
 * Integration wave (Phase 6) wires these helpers into walkthroughAnchors
 * cutover, ManualWalkthroughEditor, and useWalkthroughAnchorTarget.
 */

import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';
import type { WalkthroughAnchorCatalogFallbackReason } from '../../shared/types/walkthrough';
import {
  isRuntimeEligibleAnchor,
  type WalkthroughAnchorRegistryRecord,
  type WalkthroughAnchorSourceKind,
} from '../../shared/types/walkthroughAnchorRegistry';

/** @deprecated Import from shared/types/walkthrough — re-exported for Track D callers. */
export type { WalkthroughAnchorCatalogFallbackReason };

/** Runtime metadata resolved from an approved+active catalog row. */
export interface ResolvedRuntimeCatalogAnchor {
  id: string;
  anchorKey: string;
  testId: string;
  label: string;
  /** Approved in-app route; null means route is unconstrained at catalog level. */
  targetRoute: string | null;
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  smartTags: readonly string[];
  openerAnchorKeys: readonly string[];
  sourceLocations: WalkthroughAnchorRegistryRecord['sourceLocations'];
  sourceKind: WalkthroughAnchorSourceKind;
  /** Surfaced for telemetry; does not block resolution by itself. */
  missingSince: string | null;
}

export type WalkthroughAnchorCatalogResolveResult =
  | {
      ok: true;
      useCenteredFallback: false;
      anchor: ResolvedRuntimeCatalogAnchor;
      record: WalkthroughAnchorRegistryRecord;
    }
  | {
      ok: false;
      useCenteredFallback: true;
      reason: WalkthroughAnchorCatalogFallbackReason;
      /** Present when the key matched a non-runtime row. */
      record: WalkthroughAnchorRegistryRecord | null;
    };

export interface RuntimeCatalogIndex {
  /** All injected records keyed by anchorKey (latest non-deleted preferred). */
  readonly byKey: ReadonlyMap<string, WalkthroughAnchorRegistryRecord>;
  /** Runtime-eligible rows only (approved + active + not deleted). */
  readonly runtimeByKey: ReadonlyMap<string, WalkthroughAnchorRegistryRecord>;
  readonly runtimeByTestId: ReadonlyMap<string, WalkthroughAnchorRegistryRecord>;
}

function toResolved(
  record: WalkthroughAnchorRegistryRecord,
): ResolvedRuntimeCatalogAnchor {
  return {
    id: record.id,
    anchorKey: record.anchorKey,
    testId: record.testId,
    label: record.label,
    targetRoute: record.approvedRoute,
    allowedPlacements: record.allowedPlacements,
    smartTags: record.smartTags,
    openerAnchorKeys: record.openerAnchorKeys ?? [],
    sourceLocations: record.sourceLocations,
    sourceKind: record.sourceKind,
    missingSince: record.missingSince,
  };
}

function classifyFallback(
  record: WalkthroughAnchorRegistryRecord,
): WalkthroughAnchorCatalogFallbackReason {
  if (record.deletedAt != null) return 'deleted';
  if (record.reviewStatus !== 'approved') return 'not_approved';
  if (!record.isActive) return 'inactive';
  // Defensive: treat any other ineligible shape as inactive.
  return 'inactive';
}

/**
 * Prefer a live (non-deleted) row when duplicates appear in fixtures;
 * otherwise keep the first match.
 */
function pickPreferredRecord(
  existing: WalkthroughAnchorRegistryRecord | undefined,
  candidate: WalkthroughAnchorRegistryRecord,
): WalkthroughAnchorRegistryRecord {
  if (!existing) return candidate;
  const existingDeleted = existing.deletedAt != null;
  const candidateDeleted = candidate.deletedAt != null;
  if (existingDeleted && !candidateDeleted) return candidate;
  if (!existingDeleted && candidateDeleted) return existing;
  // Prefer runtime-eligible when both are live.
  if (
    !isRuntimeEligibleAnchor(existing) &&
    isRuntimeEligibleAnchor(candidate)
  ) {
    return candidate;
  }
  return existing;
}

/** Build lookup indexes from an injected catalog snapshot / fixture set. */
export function buildRuntimeCatalogIndex(
  records: readonly WalkthroughAnchorRegistryRecord[],
): RuntimeCatalogIndex {
  const byKey = new Map<string, WalkthroughAnchorRegistryRecord>();
  const runtimeByKey = new Map<string, WalkthroughAnchorRegistryRecord>();
  const runtimeByTestId = new Map<string, WalkthroughAnchorRegistryRecord>();

  for (const record of records) {
    byKey.set(record.anchorKey, pickPreferredRecord(byKey.get(record.anchorKey), record));

    if (!isRuntimeEligibleAnchor(record)) continue;
    runtimeByKey.set(record.anchorKey, record);
    runtimeByTestId.set(record.testId, record);
  }

  return { byKey, runtimeByKey, runtimeByTestId };
}

/** List only approved+active (non-deleted) anchors for authoring / AI snapshots. */
export function listRuntimeCatalogAnchors(
  records: readonly WalkthroughAnchorRegistryRecord[],
): ResolvedRuntimeCatalogAnchor[] {
  const index = buildRuntimeCatalogIndex(records);
  return [...index.runtimeByKey.values()]
    .map(toResolved)
    .sort((a, b) => a.anchorKey.localeCompare(b.anchorKey));
}

/**
 * Resolve an authoring/playback anchor key against an injected catalog.
 * Only approved+active non-deleted rows resolve; all other outcomes signal
 * centered fallback for Phase 6 playback cutover.
 */
export function resolveRuntimeCatalogAnchor(
  records: readonly WalkthroughAnchorRegistryRecord[],
  anchorKey: string,
): WalkthroughAnchorCatalogResolveResult {
  const key = anchorKey.trim();
  if (!key) {
    return {
      ok: false,
      useCenteredFallback: true,
      reason: 'missing',
      record: null,
    };
  }

  const index = buildRuntimeCatalogIndex(records);
  const runtime = index.runtimeByKey.get(key);
  if (runtime) {
    return {
      ok: true,
      useCenteredFallback: false,
      anchor: toResolved(runtime),
      record: runtime,
    };
  }

  const found = index.byKey.get(key) ?? null;
  if (!found) {
    return {
      ok: false,
      useCenteredFallback: true,
      reason: 'missing',
      record: null,
    };
  }

  return {
    ok: false,
    useCenteredFallback: true,
    reason: classifyFallback(found),
    record: found,
  };
}

/**
 * Enrich a step anchor with the catalog testId for playback without a
 * separate client catalog round-trip (Phase 6 handoff helper).
 * Phase 1: also resolve ordered opener locators for auto-open.
 */
export function resolveOpenerLocators(
  records: readonly WalkthroughAnchorRegistryRecord[],
  openerAnchorKeys: readonly string[] | null | undefined,
): Array<{ key: string; testId: string }> {
  if (!openerAnchorKeys?.length) return [];
  const index = buildRuntimeCatalogIndex(records);
  const out: Array<{ key: string; testId: string }> = [];
  for (const raw of openerAnchorKeys) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) continue;
    const runtime = index.runtimeByKey.get(key);
    if (!runtime) continue; // DoD-1: skip unresolved — do not throw
    out.push({ key: runtime.anchorKey, testId: runtime.testId });
  }
  return out;
}

export function enrichStepAnchorFromCatalog(
  records: readonly WalkthroughAnchorRegistryRecord[],
  stepAnchor: {
    key: string;
    targetRoute: string;
    placement: string;
  } | null | undefined,
):
  | {
      status: 'resolved';
      useCenteredFallback: false;
      enriched: {
        key: string;
        targetRoute: string;
        placement: string;
        testId: string;
        label: string;
        allowedPlacements: readonly WalkthroughRegistryPlacement[];
        openers: Array<{ key: string; testId: string }>;
      };
    }
  | {
      status: 'centered_fallback';
      useCenteredFallback: true;
      reason: WalkthroughAnchorCatalogFallbackReason;
      key: string | null;
    } {
  if (!stepAnchor?.key) {
    return {
      status: 'centered_fallback',
      useCenteredFallback: true,
      reason: 'missing',
      key: null,
    };
  }

  const resolved = resolveRuntimeCatalogAnchor(records, stepAnchor.key);
  if (resolved.ok === false) {
    return {
      status: 'centered_fallback',
      useCenteredFallback: true,
      reason: resolved.reason,
      key: stepAnchor.key,
    };
  }

  return {
    status: 'resolved',
    useCenteredFallback: false,
    enriched: {
      key: resolved.anchor.anchorKey,
      targetRoute: stepAnchor.targetRoute,
      placement: stepAnchor.placement,
      testId: resolved.anchor.testId,
      label: resolved.anchor.label,
      allowedPlacements: resolved.anchor.allowedPlacements,
      openers: resolveOpenerLocators(records, resolved.record.openerAnchorKeys),
    },
  };
}
