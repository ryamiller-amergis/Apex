import {
  isRfpVerdict,
  type SuggestedReviewerDecision,
} from '../types/rfpIntake';

export const REVIEWER_DECISION_MARKER = '[Apex reviewer decision]';

const FENCE_RE = /:::reviewer-decision\s*([\s\S]*?):::/i;

export function stripReviewerDecisionFence(raw: string): string {
  return raw.replace(FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseSuggestedReviewerDecision(raw: string): SuggestedReviewerDecision | null {
  const match = raw.match(FENCE_RE);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!isRfpVerdict(obj.verdict)) return null;
  if (typeof obj.rationale !== 'string' || obj.rationale.trim() === '') return null;
  const constraintsToAdd = typeof obj.constraintsToAdd === 'string' ? obj.constraintsToAdd.trim() : '';
  return {
    verdict: obj.verdict,
    rationale: obj.rationale.trim(),
    constraintsToAdd,
  };
}

export function parseReviewerDecisionFence(raw: string): {
  displayBody: string;
  suggestion: SuggestedReviewerDecision | null;
} {
  return {
    displayBody: stripReviewerDecisionFence(raw),
    suggestion: parseSuggestedReviewerDecision(raw),
  };
}

export function appendReviewerConstraints(
  existing: string | null | undefined,
  rationale: string,
  extra: string | null | undefined,
): string {
  const parts = [`${REVIEWER_DECISION_MARKER} ${rationale.trim()}`];
  const extraTrimmed = extra?.trim();
  if (extraTrimmed) parts.push(extraTrimmed);
  const block = parts.join('\n');
  const current = existing?.trim() ?? '';
  if (!current) return block;
  const idx = current.lastIndexOf(REVIEWER_DECISION_MARKER);
  if (idx >= 0) {
    const prefix = current.slice(0, idx).trimEnd();
    return [prefix, block].filter(Boolean).join('\n\n');
  }
  return `${current}\n\n${block}`;
}
