import { createHash } from 'crypto';
import type { ValidationScorecard } from '../types/interview';

const TEMPLATE_TOKEN_RE = /\{[a-zA-Z][a-zA-Z0-9_.-]*\}/;
const TBD_RE = /\[TBD\]/i;

/** Required PRD markdown section headings — match to-prd template, not the old rubric aliases. */
const REQUIRED_PRD_HEADING_ALIASES: ReadonlyArray<readonly string[]> = [
  ['Problem Statement'],
  // to-prd writes "## Solution"; older docs / rubric may say "Proposed Solution".
  ['Solution', 'Proposed Solution'],
];

function hasAnyHeading(body: string, aliases: readonly string[]): boolean {
  return aliases.some((heading) => {
    const re = new RegExp(`^#{1,3}\\s+${heading}\\b`, 'im');
    return re.test(body);
  });
}

export function hashPrdValidationContent(
  content: string,
  backlogJson: unknown,
): string {
  return createHash('sha256')
    .update(content ?? '', 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(backlogJson ?? null), 'utf8')
    .digest('hex');
}

export function scorecardMatchesContentHash(
  scorecard: ValidationScorecard | null | undefined,
  content: string,
  backlogJson: unknown,
): boolean {
  if (!scorecard?.contentHash) return false;
  return scorecard.contentHash === hashPrdValidationContent(content, backlogJson);
}

/**
 * Deterministic fail-fast before launching the validation agent.
 * Returns a failing scorecard when structural gaps are obvious; null when OK to run the agent.
 *
 * Do not require "## User Stories" / "## Acceptance Criteria" in markdown — to-prd
 * owns those in the backlog and projects them into the PRD view.
 */
export function evaluatePrdStructuralValidation(
  content: string,
  backlogJson: unknown,
): ValidationScorecard | null {
  const gaps: NonNullable<ValidationScorecard['gaps']> = [];
  const body = content ?? '';

  if (!body.trim()) {
    gaps.push({
      id: 'prd-empty',
      file: 'prd.md',
      section: 'PRD',
      score: 0,
      description: 'PRD content is empty.',
      what_3_looks_like: 'A complete PRD with all required sections filled in.',
      resolution: 'pending',
    });
  }

  for (const aliases of REQUIRED_PRD_HEADING_ALIASES) {
    if (!hasAnyHeading(body, aliases)) {
      const primary = aliases[0];
      gaps.push({
        id: `missing-${primary.toLowerCase().replace(/\s+/g, '-')}`,
        file: 'prd.md',
        section: primary,
        score: 0,
        description: `Required section "${primary}" is missing.`,
        what_3_looks_like: `A "## ${primary}" section with substantive content.`,
        resolution: 'pending',
      });
    }
  }

  if (TEMPLATE_TOKEN_RE.test(body)) {
    gaps.push({
      id: 'template-tokens',
      file: 'prd.md',
      section: 'PRD',
      score: 0,
      description: 'PRD still contains unresolved {template} tokens.',
      what_3_looks_like: 'No curly-brace template tokens remain in the document.',
      resolution: 'pending',
    });
  }

  if (TBD_RE.test(body)) {
    gaps.push({
      id: 'tbd-markers',
      file: 'prd.md',
      section: 'PRD',
      score: 1,
      description: 'PRD still contains [TBD] placeholders.',
      what_3_looks_like: 'All [TBD] markers replaced with concrete decisions.',
      resolution: 'pending',
    });
  }

  if (backlogJson == null) {
    gaps.push({
      id: 'backlog-missing',
      file: 'backlog.json',
      section: 'Backlog',
      score: 0,
      description: 'Backlog JSON is missing.',
      what_3_looks_like: 'A valid backlog.json with epics, features, and PBIs.',
      resolution: 'pending',
    });
  } else if (typeof backlogJson !== 'object') {
    gaps.push({
      id: 'backlog-invalid',
      file: 'backlog.json',
      section: 'Backlog',
      score: 0,
      description: 'Backlog JSON is not an object.',
      what_3_looks_like: 'A JSON object matching the backlog schema.',
      resolution: 'pending',
    });
  }

  if (gaps.length === 0) return null;

  const contentHash = hashPrdValidationContent(content, backlogJson);
  return {
    slug: 'prd-structural',
    generated_at: new Date().toISOString(),
    review_phase: 'initial',
    overall_score: 0,
    ready_threshold: 90,
    is_ready: false,
    verdict: 'significant_gaps',
    gaps,
    contentHash,
  };
}
