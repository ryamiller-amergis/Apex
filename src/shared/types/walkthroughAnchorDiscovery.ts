/**
 * Walkthrough AI anchor discovery — agent output contracts for finding a new
 * coachable catalog anchor from a proposal step context.
 */

import type { WalkthroughRegistryPlacement } from '../walkthroughAnchors';

export const DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH =
  '.cursor/skills/walkthrough-anchor-discovery/SKILL.md';

export const WALKTHROUGH_ANCHOR_DISCOVERY_OUTPUT_RELATIVE_PATH = [
  '.ai-pilot',
  'output',
  'walkthrough-anchor-discovery.json',
] as const;

export interface WalkthroughAnchorDiscoveryProposal {
  testId: string;
  anchorKey: string;
  label: string;
  suggestedRoute: string | null;
  allowedPlacements: WalkthroughRegistryPlacement[];
  smartTags: string[];
  sourceLocations: Array<{ filePath: string; line?: number | null }>;
  confidence: number;
  rationale: string;
}

export interface WalkthroughAnchorDiscoveryResult {
  proposals: WalkthroughAnchorDiscoveryProposal[];
}

export type WalkthroughAnchorDiscoveryValidationCode =
  | 'INVALID_JSON'
  | 'MISSING_PROPOSALS'
  | 'INVALID_PROPOSAL';

export class WalkthroughAnchorDiscoveryError extends Error {
  readonly code: WalkthroughAnchorDiscoveryValidationCode;

  constructor(code: WalkthroughAnchorDiscoveryValidationCode, message: string) {
    super(message);
    this.name = 'WalkthroughAnchorDiscoveryError';
    this.code = code;
  }
}

const PLACEMENTS = new Set<WalkthroughRegistryPlacement>([
  'top',
  'right',
  'bottom',
  'left',
]);

const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WalkthroughAnchorDiscoveryError(
      'INVALID_PROPOSAL',
      `${field} is required`,
    );
  }
  return value.trim();
}

function parsePlacements(value: unknown): WalkthroughRegistryPlacement[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WalkthroughAnchorDiscoveryError(
      'INVALID_PROPOSAL',
      'allowedPlacements must be a non-empty array',
    );
  }
  const out: WalkthroughRegistryPlacement[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !PLACEMENTS.has(item as WalkthroughRegistryPlacement)) {
      throw new WalkthroughAnchorDiscoveryError(
        'INVALID_PROPOSAL',
        `Invalid placement: ${String(item)}`,
      );
    }
    const placement = item as WalkthroughRegistryPlacement;
    if (!out.includes(placement)) out.push(placement);
  }
  return out;
}

function parseSmartTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 8) {
    throw new WalkthroughAnchorDiscoveryError(
      'INVALID_PROPOSAL',
      'smartTags must contain 3–8 kebab-case tags',
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !TAG_RE.test(item)) {
      throw new WalkthroughAnchorDiscoveryError(
        'INVALID_PROPOSAL',
        `Invalid smart tag: ${String(item)}`,
      );
    }
    if (!out.includes(item)) out.push(item);
  }
  if (out.length < 3 || out.length > 8) {
    throw new WalkthroughAnchorDiscoveryError(
      'INVALID_PROPOSAL',
      'smartTags must contain 3–8 unique kebab-case tags',
    );
  }
  return out;
}

function parseSourceLocations(
  value: unknown,
): Array<{ filePath: string; line?: number | null }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ filePath: string; line?: number | null }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.filePath !== 'string' || !row.filePath.trim()) continue;
    const line =
      typeof row.line === 'number' && Number.isFinite(row.line) ? row.line : null;
    out.push({ filePath: row.filePath.trim(), line });
  }
  return out;
}

export function parseWalkthroughAnchorDiscoveryOutput(
  raw: string,
): WalkthroughAnchorDiscoveryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WalkthroughAnchorDiscoveryError(
      'INVALID_JSON',
      'Discovery output is not valid JSON',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new WalkthroughAnchorDiscoveryError(
      'MISSING_PROPOSALS',
      'Discovery output must be an object',
    );
  }
  const proposalsRaw = (parsed as { proposals?: unknown }).proposals;
  if (!Array.isArray(proposalsRaw)) {
    throw new WalkthroughAnchorDiscoveryError(
      'MISSING_PROPOSALS',
      'Discovery output must include a proposals array',
    );
  }

  const proposals: WalkthroughAnchorDiscoveryProposal[] = proposalsRaw.map(
    (item, index) => {
      if (!item || typeof item !== 'object') {
        throw new WalkthroughAnchorDiscoveryError(
          'INVALID_PROPOSAL',
          `proposals[${index}] must be an object`,
        );
      }
      const row = item as Record<string, unknown>;
      const testId = asNonEmptyString(row.testId, `proposals[${index}].testId`);
      const anchorKey = asNonEmptyString(
        row.anchorKey ?? row.testId,
        `proposals[${index}].anchorKey`,
      );
      const label = asNonEmptyString(row.label, `proposals[${index}].label`);
      const confidence =
        typeof row.confidence === 'number' && Number.isFinite(row.confidence)
          ? Math.min(1, Math.max(0, row.confidence))
          : (() => {
              throw new WalkthroughAnchorDiscoveryError(
                'INVALID_PROPOSAL',
                `proposals[${index}].confidence must be a number in [0, 1]`,
              );
            })();
      const rationale = asNonEmptyString(
        row.rationale,
        `proposals[${index}].rationale`,
      );
      const suggestedRoute =
        row.suggestedRoute === null || row.suggestedRoute === undefined
          ? null
          : asNonEmptyString(
              row.suggestedRoute,
              `proposals[${index}].suggestedRoute`,
            );

      return {
        testId,
        anchorKey,
        label,
        suggestedRoute,
        allowedPlacements: parsePlacements(row.allowedPlacements),
        smartTags: parseSmartTags(row.smartTags),
        sourceLocations: parseSourceLocations(row.sourceLocations),
        confidence,
        rationale,
      };
    },
  );

  return { proposals };
}
