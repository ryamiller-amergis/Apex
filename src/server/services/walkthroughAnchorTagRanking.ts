/**
 * Smart Anchor Management — Wave 2 Track D.
 * Pure tag-ranking for walkthrough generation kickoff enrichment.
 *
 * Rank approved+active anchors by route compatibility first, then
 * intent/heading/body overlap against normalized smart tags and labels.
 *
 * Integration wave (Phase 7) feeds ranked candidates into
 * walkthroughGenerationService kickoff + skill selection.
 */

import {
  isRuntimeEligibleAnchor,
  normalizeSmartTags,
  type WalkthroughAnchorRegistryRecord,
} from '../../shared/types/walkthroughAnchorRegistry';
import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';

/**
 * Conservative auto-select floor for Phase 7.
 * Below this score, generation should surface ranked recommendations
 * instead of silently picking an anchor.
 */
export const DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD = 0.72;

export interface WalkthroughAnchorTagRankingQuery {
  /** Preferred step/route context; exact approvedRoute matches rank first. */
  route?: string | null;
  intent?: string | null;
  heading?: string | null;
  body?: string | null;
}

export interface WalkthroughAnchorTagRankingEvidence {
  routeCompatible: boolean;
  routeExactMatch: boolean;
  matchedTags: string[];
  matchedLabelTokens: string[];
  queryTokens: string[];
  /** Matched query-token coverage in [0, 1]. */
  overlapRatio: number;
}

export interface RankedWalkthroughAnchorCandidate {
  anchorKey: string;
  testId: string;
  label: string;
  approvedRoute: string | null;
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  smartTags: readonly string[];
  /** Composite score in [0, 1] (route boost + text overlap). */
  score: number;
  evidence: WalkthroughAnchorTagRankingEvidence;
}

export interface RankWalkthroughAnchorsOptions {
  /** Max candidates to return (default: all ranked). */
  limit?: number;
}

export interface AutoSelectAnchorOptions {
  /** Inclusive score floor; defaults to DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD. */
  threshold?: number;
  /**
   * When the query includes a route, require routeCompatible for auto-select
   * (default true).
   */
  requireRouteCompatible?: boolean;
}

const TOKEN_SPLIT = /[^a-z0-9]+/g;

/** Lowercase alphanumeric tokens; drops empties and single-char noise. */
export function tokenizeRankingText(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.toLowerCase().split(TOKEN_SPLIT)) {
    const token = raw.trim();
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function collectQueryTokens(query: WalkthroughAnchorTagRankingQuery): string[] {
  const merged = [
    ...tokenizeRankingText(query.intent),
    ...tokenizeRankingText(query.heading),
    ...tokenizeRankingText(query.body),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of merged) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function expandTagTokens(tags: readonly string[]): {
  normalizedTags: string[];
  tagTokenSet: Set<string>;
} {
  const normalizedTags = normalizeSmartTags([...tags]);
  const tagTokenSet = new Set<string>();
  for (const tag of normalizedTags) {
    tagTokenSet.add(tag);
    for (const part of tokenizeRankingText(tag)) {
      tagTokenSet.add(part);
    }
  }
  return { normalizedTags, tagTokenSet };
}

function scoreCandidate(
  record: WalkthroughAnchorRegistryRecord,
  query: WalkthroughAnchorTagRankingQuery,
  queryTokens: readonly string[],
): RankedWalkthroughAnchorCandidate {
  const route = query.route?.trim() || null;
  const approvedRoute = record.approvedRoute?.trim() || null;
  const routeExactMatch = Boolean(route && approvedRoute && route === approvedRoute);
  const routeCompatible =
    !route || approvedRoute == null || approvedRoute === route;

  const { normalizedTags, tagTokenSet } = expandTagTokens(record.smartTags);
  const labelTokens = tokenizeRankingText(record.label);
  const labelTokenSet = new Set(labelTokens);

  const matchedTags: string[] = [];
  const matchedLabelTokens: string[] = [];
  let matchedQueryCount = 0;

  for (const token of queryTokens) {
    let hit = false;
    if (tagTokenSet.has(token) || normalizedTags.includes(token)) {
      if (!matchedTags.includes(token)) matchedTags.push(token);
      hit = true;
    }
    // Also match full kebab tags contained in query phrases via token parts.
    for (const tag of normalizedTags) {
      if (tag === token || tag.split('-').includes(token)) {
        if (!matchedTags.includes(tag)) matchedTags.push(tag);
        hit = true;
      }
    }
    if (labelTokenSet.has(token)) {
      if (!matchedLabelTokens.includes(token)) matchedLabelTokens.push(token);
      hit = true;
    }
    if (hit) matchedQueryCount += 1;
  }

  const overlapRatio =
    queryTokens.length === 0 ? 0 : matchedQueryCount / queryTokens.length;

  // Route is the primary signal; overlap fills the remainder.
  let score = overlapRatio * 0.7;
  if (routeExactMatch) score += 0.3;
  else if (routeCompatible && route) score += 0.15;
  else if (!route && overlapRatio > 0) score += 0.05;
  if (score > 1) score = 1;
  // Round for stable fixture assertions.
  score = Math.round(score * 1000) / 1000;

  return {
    anchorKey: record.anchorKey,
    testId: record.testId,
    label: record.label,
    approvedRoute: record.approvedRoute,
    allowedPlacements: record.allowedPlacements,
    smartTags: record.smartTags,
    score,
    evidence: {
      routeCompatible,
      routeExactMatch,
      matchedTags,
      matchedLabelTokens,
      queryTokens: [...queryTokens],
      overlapRatio: Math.round(overlapRatio * 1000) / 1000,
    },
  };
}

/**
 * Rank runtime-eligible catalog anchors for generation.
 * Sort order: routeCompatible DESC → score DESC → anchorKey ASC.
 */
export function rankWalkthroughAnchorsByTags(
  records: readonly WalkthroughAnchorRegistryRecord[],
  query: WalkthroughAnchorTagRankingQuery,
  options: RankWalkthroughAnchorsOptions = {},
): RankedWalkthroughAnchorCandidate[] {
  const queryTokens = collectQueryTokens(query);
  const ranked = records
    .filter((record) => isRuntimeEligibleAnchor(record))
    .map((record) => scoreCandidate(record, query, queryTokens))
    .sort((a, b) => {
      if (a.evidence.routeCompatible !== b.evidence.routeCompatible) {
        return a.evidence.routeCompatible ? -1 : 1;
      }
      if (b.score !== a.score) return b.score - a.score;
      return a.anchorKey.localeCompare(b.anchorKey);
    });

  if (options.limit != null && options.limit >= 0) {
    return ranked.slice(0, options.limit);
  }
  return ranked;
}

/**
 * Conservative auto-select: returns the top ranked candidate only when it
 * clears the score threshold (and route compatibility when a route is set).
 */
export function pickAutoSelectAnchorCandidate(
  ranked: readonly RankedWalkthroughAnchorCandidate[],
  query: WalkthroughAnchorTagRankingQuery = {},
  options: AutoSelectAnchorOptions = {},
): RankedWalkthroughAnchorCandidate | null {
  const threshold =
    options.threshold ?? DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD;
  const requireRouteCompatible = options.requireRouteCompatible ?? true;
  const top = ranked[0];
  if (!top) return null;
  if (top.score < threshold) return null;

  const route = query.route?.trim();
  if (requireRouteCompatible && route && !top.evidence.routeCompatible) {
    return null;
  }
  return top;
}
