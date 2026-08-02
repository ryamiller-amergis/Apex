/**
 * Smart Anchor Management — Phase 4 smart-tagging skill output contracts.
 *
 * Wave 1: schema + validators + pure merge helper for pending catalog rows.
 * Wave 2: async Cursor start/status/cancel and DB persistence (see
 * `walkthroughGenerationService.ts` for the orchestration pattern to mirror).
 */

import type { WalkthroughRegistryPlacement } from '../walkthroughAnchors';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../walkthroughAnchors';
import { isWalkthroughRoute } from '../walkthroughRoutes';
import {
  isValidSmartTag,
  normalizeSmartTags,
  type WalkthroughAnchorAiProvenance,
  type WalkthroughAnchorReviewStatus,
} from './walkthroughAnchorRegistry';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH =
  '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md';

export const WALKTHROUGH_ANCHOR_SMART_TAGGING_OUTPUT_RELATIVE_PATH = [
  '.ai-pilot',
  'output',
  'walkthrough-anchor-smart-tagging.json',
] as const;

export const SMART_TAG_COUNT_MIN = 3;
export const SMART_TAG_COUNT_MAX = 8;

/** Noise tokens we never promote from testId into smart tags. */
const EVIDENCE_TAG_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'btn',
  'button', // prefer explicit UI dim from AI; keep if only evidence
  'test',
  'testid',
  'data',
  'item',
  'new',
  'old',
  'tmp',
]);


// ── Skill output shapes ───────────────────────────────────────────────────────

/** One classified candidate written by the smart-tagging skill. */
export interface WalkthroughAnchorSmartTagSuggestion {
  testId: string;
  anchorKey: string;
  suggestedLabel: string;
  suggestedRoute: string | null;
  allowedPlacements: WalkthroughRegistryPlacement[];
  /** Normalized lowercase kebab-case tags; length 3–8. */
  smartTags: string[];
  /** Inclusive [0, 1] confidence for the whole suggestion. */
  confidence: number;
  rationale: string;
}

/** Root JSON artifact at `.ai-pilot/output/walkthrough-anchor-smart-tagging.json`. */
export interface WalkthroughAnchorSmartTaggingResult {
  suggestions: WalkthroughAnchorSmartTagSuggestion[];
}

export type WalkthroughAnchorSmartTaggingValidationCode =
  | 'INVALID_OUTPUT'
  | 'UNEXPECTED_FIELD'
  | 'EMPTY_SUGGESTIONS'
  | 'INVALID_TEST_ID'
  | 'INVALID_ANCHOR_KEY'
  | 'INVALID_LABEL'
  | 'INVALID_ROUTE'
  | 'INVALID_PLACEMENTS'
  | 'INVALID_SMART_TAGS'
  | 'INVALID_CONFIDENCE'
  | 'INVALID_RATIONALE';

export interface WalkthroughAnchorSmartTaggingValidationError {
  field: string;
  code: WalkthroughAnchorSmartTaggingValidationCode;
  message: string;
}

export class WalkthroughAnchorSmartTaggingError extends Error {
  readonly code: WalkthroughAnchorSmartTaggingValidationCode;
  readonly errors: WalkthroughAnchorSmartTaggingValidationError[];

  constructor(
    message: string,
    code: WalkthroughAnchorSmartTaggingValidationCode,
    errors: WalkthroughAnchorSmartTaggingValidationError[] = [],
  ) {
    super(message);
    this.name = 'WalkthroughAnchorSmartTaggingError';
    this.code = code;
    this.errors = errors;
  }
}

/** Pending (or other) catalog row slice used by the pure merge helper. */
export interface WalkthroughAnchorSmartTagMergeTarget {
  id: string;
  testId: string;
  anchorKey: string;
  label: string;
  suggestedRoute: string | null;
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  smartTags: readonly string[];
  reviewStatus: WalkthroughAnchorReviewStatus;
  aiProvenance: WalkthroughAnchorAiProvenance | null;
}

export type WalkthroughAnchorSmartTagMergeProvenanceBase = Omit<
  WalkthroughAnchorAiProvenance,
  'confidence' | 'rationale'
>;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * The registry persists the human-readable value as `label`, so agents
 * occasionally mirror that name even though the skill contract calls it
 * `suggestedLabel`. Treat that single known alias as a recoverable boundary
 * mismatch; canonical `suggestedLabel` wins when both are present.
 */
function normalizeSuggestionAliases(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...record };
  const aliases: Array<[canonical: string, alias: string]> = [
    ['anchorKey', 'key'],
    ['suggestedLabel', 'label'],
    ['suggestedRoute', 'route'],
    ['smartTags', 'tags'],
    ['confidence', 'confidenceScore'],
    ['rationale', 'reason'],
  ];
  for (const [canonical, alias] of aliases) {
    if (
      !Object.prototype.hasOwnProperty.call(normalized, canonical) &&
      Object.prototype.hasOwnProperty.call(normalized, alias)
    ) {
      normalized[canonical] = normalized[alias];
    }
    delete normalized[alias];
  }
  return normalized;
}

function isValidAnchorKey(anchorKey: string): boolean {
  return (
    Boolean(anchorKey) &&
    !/[#.[\]>+~*=]|^\s*\/\//.test(anchorKey) &&
    !anchorKey.includes(' ')
  );
}

function labelFromTestId(testId: string): string {
  return testId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
}

function normalizeConfidence(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return 0.5;
  const ratio = numeric > 1 ? numeric / 100 : numeric;
  return Math.max(0, Math.min(1, ratio));
}

function validateSuggestion(
  raw: unknown,
  index: number,
): {
  errors: WalkthroughAnchorSmartTaggingValidationError[];
  suggestion?: WalkthroughAnchorSmartTagSuggestion;
} {
  const fieldPrefix = `suggestions[${index}]`;
  const errors: WalkthroughAnchorSmartTaggingValidationError[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      field: fieldPrefix,
      code: 'INVALID_OUTPUT',
      message: `${fieldPrefix} must be an object`,
    });
    return { errors };
  }

  const record = normalizeSuggestionAliases(raw as Record<string, unknown>);

  const testId = typeof record.testId === 'string' ? record.testId.trim() : '';
  if (!testId) {
    errors.push({
      field: `${fieldPrefix}.testId`,
      code: 'INVALID_TEST_ID',
      message: 'testId is required',
    });
  }

  const emittedAnchorKey =
    typeof record.anchorKey === 'string' ? record.anchorKey.trim() : '';
  const anchorKey = isValidAnchorKey(emittedAnchorKey) ? emittedAnchorKey : testId;

  const emittedLabel =
    typeof record.suggestedLabel === 'string' ? record.suggestedLabel.trim() : '';
  const suggestedLabel = emittedLabel || labelFromTestId(testId);
  if (!suggestedLabel) {
    errors.push({
      field: `${fieldPrefix}.suggestedLabel`,
      code: 'INVALID_LABEL',
      message: 'suggestedLabel is required',
    });
  }

  let suggestedRoute: string | null = null;
  if (record.suggestedRoute === null || record.suggestedRoute === undefined) {
    suggestedRoute = null;
  } else if (typeof record.suggestedRoute === 'string') {
    const trimmed = record.suggestedRoute.trim();
    if (!trimmed) {
      suggestedRoute = null;
    } else {
      suggestedRoute = isWalkthroughRoute(trimmed) ? trimmed : null;
    }
  }

  // Placement policy is deterministic and is not AI-authored. Normalize any
  // emitted value (including legacy terms such as "tooltip") to all four
  // supported sides instead of rejecting an otherwise valid tagging batch.
  const allowedPlacements: WalkthroughRegistryPlacement[] = [
    ...WALKTHROUGH_REGISTRY_PLACEMENTS,
  ];

  const emittedTags = Array.isArray(record.smartTags)
    ? record.smartTags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const smartTags = mergeEvidenceTokensIntoSmartTags(testId, emittedTags);
  for (const fallback of ['walkthrough', 'discover', 'ui-element']) {
    if (smartTags.length >= SMART_TAG_COUNT_MIN) break;
    if (!smartTags.includes(fallback)) smartTags.push(fallback);
  }

  const confidence = normalizeConfidence(record.confidence);

  const emittedRationale =
    typeof record.rationale === 'string' ? record.rationale.trim() : '';
  const rationale =
    emittedRationale ||
    'The smart-tagging agent did not provide a rationale; manual review is required.';

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors: [],
    suggestion: {
      testId,
      anchorKey,
      suggestedLabel,
      suggestedRoute,
      allowedPlacements,
      smartTags,
      confidence,
      rationale,
    },
  };
}

/**
 * Agents sometimes wrap JSON in markdown fences or emit a bare suggestions
 * array. Normalize those shapes before schema validation so a successful write
 * is not rejected for a recoverable packaging mistake.
 */
function stripJsonMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function normalizeSmartTaggingRoot(
  parsed: unknown,
): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    return { suggestions: parsed };
  }
  if (parsed && typeof parsed === 'object') {
    const record = { ...(parsed as Record<string, unknown>) };
    if (!Array.isArray(record.suggestions)) {
      const alias = Array.isArray(record.results)
        ? record.results
        : Array.isArray(record.anchors)
          ? record.anchors
          : null;
      if (alias) record.suggestions = alias;
    }
    return record;
  }
  return null;
}

/**
 * Validate a parsed skill result without throwing.
 * Useful for bulk review UI and merge pre-checks.
 */
export function validateWalkthroughAnchorSmartTaggingResult(
  result: unknown,
): WalkthroughAnchorSmartTaggingValidationError[] {
  const record = normalizeSmartTaggingRoot(result);
  if (!record) {
    return [
      {
        field: '',
        code: 'INVALID_OUTPUT',
        message: 'Smart-tagging output must be an object',
      },
    ];
  }

  const errors: WalkthroughAnchorSmartTaggingValidationError[] = [];

  if (!Array.isArray(record.suggestions)) {
    errors.push({
      field: 'suggestions',
      code: 'INVALID_OUTPUT',
      message: 'suggestions must be an array',
    });
    return errors;
  }

  if (record.suggestions.length === 0) {
    errors.push({
      field: 'suggestions',
      code: 'EMPTY_SUGGESTIONS',
      message: 'suggestions must contain at least one entry',
    });
    return errors;
  }

  for (let i = 0; i < record.suggestions.length; i += 1) {
    errors.push(...validateSuggestion(record.suggestions[i], i).errors);
  }

  return errors;
}

/**
 * Parse + validate the smart-tagging skill JSON artifact.
 * Throws WalkthroughAnchorSmartTaggingError on invalid JSON or schema violations.
 *
 * Recoverable packaging mistakes (markdown fences, bare suggestions array) are
 * normalized before schema checks — the agent must still emit valid suggestion
 * entries.
 */
export function parseWalkthroughAnchorSmartTaggingOutput(
  raw: string,
): WalkthroughAnchorSmartTaggingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonMarkdownFences(raw));
  } catch {
    throw new WalkthroughAnchorSmartTaggingError(
      'Smart-tagging output is not valid JSON.',
      'INVALID_OUTPUT',
    );
  }

  const record = normalizeSmartTaggingRoot(parsed);
  if (!record) {
    throw new WalkthroughAnchorSmartTaggingError(
      'Smart-tagging output is not an object.',
      'INVALID_OUTPUT',
    );
  }

  if (!Array.isArray(record.suggestions)) {
    throw new WalkthroughAnchorSmartTaggingError(
      'Smart-tagging output is missing suggestions.',
      'INVALID_OUTPUT',
      [
        {
          field: 'suggestions',
          code: 'INVALID_OUTPUT',
          message: 'suggestions must be an array',
        },
      ],
    );
  }

  if (record.suggestions.length === 0) {
    throw new WalkthroughAnchorSmartTaggingError(
      'Smart-tagging suggestions array is empty.',
      'EMPTY_SUGGESTIONS',
      [
        {
          field: 'suggestions',
          code: 'EMPTY_SUGGESTIONS',
          message: 'suggestions must contain at least one entry',
        },
      ],
    );
  }

  const suggestions: WalkthroughAnchorSmartTagSuggestion[] = [];
  const allErrors: WalkthroughAnchorSmartTaggingValidationError[] = [];

  for (let i = 0; i < record.suggestions.length; i += 1) {
    const { errors, suggestion } = validateSuggestion(record.suggestions[i], i);
    allErrors.push(...errors);
    if (suggestion) suggestions.push(suggestion);
  }

  if (allErrors.length > 0) {
    const primary = allErrors[0];
    throw new WalkthroughAnchorSmartTaggingError(
      primary.message,
      primary.code,
      allErrors,
    );
  }

  return { suggestions };
}

/**
 * Extract searchable kebab tokens from a discovered testId (e.g. ado-create-error
 * → ado, create, error). Used to keep tags aligned with what rationale already knows.
 */
export function evidenceTokensFromTestId(testId: string): string[] {
  const parts = testId
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.length < 3) continue;
    if (EVIDENCE_TAG_STOPWORDS.has(part)) continue;
    if (!isValidSmartTag(part)) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

/**
 * Prefer evidence tokens from testId, then AI tags, capped at SMART_TAG_COUNT_MAX.
 * Ensures domain words present in the id (ado, error, …) are not dropped when
 * the model leans on generic workflow tags only.
 */
export function mergeEvidenceTokensIntoSmartTags(
  testId: string,
  aiTags: readonly string[],
): string[] {
  const evidence = evidenceTokensFromTestId(testId);
  const ai = normalizeSmartTags(aiTags).filter(isValidSmartTag);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...evidence, ...ai]) {
    if (merged.length >= SMART_TAG_COUNT_MAX) break;
    if (seen.has(tag)) continue;
    seen.add(tag);
    merged.push(tag);
  }
  return merged;
}

/**
 * Pure merge: apply validated AI suggestions onto pending catalog rows only.
 * Does not touch the database — Wave 2 wires persistence after async runs.
 *
 * Matching is by `testId`. Approved / rejected / unmatched rows are returned unchanged.
 */
export function applyValidatedSmartTagSuggestions(
  targets: readonly WalkthroughAnchorSmartTagMergeTarget[],
  result: WalkthroughAnchorSmartTaggingResult,
  provenanceBase: WalkthroughAnchorSmartTagMergeProvenanceBase,
): WalkthroughAnchorSmartTagMergeTarget[] {
  const byTestId = new Map(
    result.suggestions.map((suggestion) => [suggestion.testId, suggestion]),
  );

  return targets.map((row) => {
    if (row.reviewStatus !== 'pending') {
      return row;
    }
    const suggestion = byTestId.get(row.testId);
    if (!suggestion) {
      return row;
    }

    const smartTags = mergeEvidenceTokensIntoSmartTags(
      suggestion.testId,
      suggestion.smartTags,
    );

    return {
      ...row,
      anchorKey: suggestion.anchorKey,
      label: suggestion.suggestedLabel,
      suggestedRoute: suggestion.suggestedRoute,
      // Placements are not AI-evaluated — always allow all sides; step authoring
      // picks the preferred placement, and runtime flip/shift may adjust later.
      allowedPlacements: [...WALKTHROUGH_REGISTRY_PLACEMENTS],
      smartTags,
      aiProvenance: {
        ...provenanceBase,
        confidence: suggestion.confidence,
        rationale: suggestion.rationale,
      },
    };
  });
}
