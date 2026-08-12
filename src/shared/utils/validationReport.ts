import type {
  ValidationScorecard,
  ValidationScorecardGap,
} from '../types/interview';

const GAP_RESOLUTIONS = new Set([
  'pending',
  'filled',
  'deferred',
  'accepted',
]);

/** Normalize a loose scorecard gap (feature-nested or top-level alternate shape). */
export function normalizeValidationGap(raw: unknown): ValidationScorecardGap | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  const resolutionRaw = String(record.resolution ?? 'pending');
  const resolution = GAP_RESOLUTIONS.has(resolutionRaw)
    ? (resolutionRaw as ValidationScorecardGap['resolution'])
    : 'pending';
  return {
    id,
    file: String(record.file ?? record.file_type ?? ''),
    section: String(record.section ?? ''),
    score: Number(record.score ?? 0),
    description: String(record.description ?? record.detail ?? ''),
    what_3_looks_like: String(record.what_3_looks_like ?? ''),
    resolution,
  };
}

/**
 * Collect gaps from either the canonical nested shape (`features[].gaps` /
 * `files[].gaps`) or the alternate design-doc root `gaps` array.
 */
export function collectValidationGaps(
  scorecard: ValidationScorecard | null | undefined,
): ValidationScorecardGap[] {
  if (!scorecard) return [];

  const nested: ValidationScorecardGap[] = [];
  for (const feature of scorecard.features ?? []) {
    const gaps = Array.isArray(feature.gaps) ? feature.gaps : [];
    for (const gap of gaps) {
      const normalized = normalizeValidationGap(gap);
      if (normalized) nested.push(normalized);
    }
  }
  for (const file of scorecard.files ?? []) {
    const gaps = Array.isArray(file.gaps) ? file.gaps : [];
    for (const gap of gaps) {
      const normalized = normalizeValidationGap(gap);
      if (normalized) nested.push(normalized);
    }
  }
  if (nested.length > 0) return nested;

  const topLevel = Array.isArray(scorecard.gaps) ? scorecard.gaps : [];
  const fromRoot: ValidationScorecardGap[] = [];
  for (const gap of topLevel) {
    const normalized = normalizeValidationGap(gap);
    if (normalized) fromRoot.push(normalized);
  }
  return fromRoot;
}

/** Section % for design-doc scorecards (canonical fields or nested score_pct). */
export function designDocFeatureSectionScore(
  feature: Record<string, unknown> | null | undefined,
  key: 'design_score' | 'tech_spec_score' | 'assumptions_score',
): number | null {
  if (!feature) return null;
  const direct = feature[key];
  if (typeof direct === 'number' && Number.isFinite(direct)) return Math.round(direct);
  const nestedKey =
    key === 'design_score'
      ? 'design'
      : key === 'tech_spec_score'
        ? 'tech_spec'
        : 'assumptions';
  const nested = asRecord(feature[nestedKey]);
  const pct = nested?.score_pct;
  if (typeof pct === 'number' && Number.isFinite(pct)) return Math.round(pct);
  return null;
}

const EXPLICIT_REASON_KEYS = [
  'passing_reasons',
  'passed_reasons',
  'pass_reasons',
  'passing_evidence',
  'positive_findings',
  'strengths',
  'evidence',
  'why_it_passed',
  'reason',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringifyReason(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = cleanText(value);
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringifyReason);
  }
  const record = asRecord(value);
  if (record) {
    return Object.entries(record).flatMap(([key, val]) => {
      const values = stringifyReason(val);
      return values.map((text) => `${humanizeLabel(key)}: ${text}`);
    });
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return [];
}

function collectExplicitReasons(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  return EXPLICIT_REASON_KEYS.flatMap((key) => stringifyReason(record[key]));
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function fileLabel(file: string, filename?: string): string {
  if (filename) return filename;
  if (file === 'prd') return 'PRD Content';
  if (file === 'backlog') return 'Backlog';
  if (file === 'test_cases') return 'Test Cases';
  return humanizeLabel(file);
}

function isReadyVerdict(verdict?: string): boolean {
  return (verdict ?? '').toLowerCase().replace(/[_-]+/g, ' ') === 'ready';
}

function isPositiveCheckText(value: string): boolean {
  const text = value.toLowerCase();
  const noGaps = /\b(no|none|zero|without)\b[^.]{0,24}\bgaps?\b/.test(text);
  const clearlyPositive = /\b(pass|passed|ready|complete|covered|aligned|sufficient|valid|consistent|ok|yes)\b/.test(text)
    || /\b(no|none|zero|without)\b[^.]{0,24}\b(issues?|risks?|blockers?|missing|errors?)\b/.test(text)
    || noGaps;
  const clearlyNegative = /\b(fail|failed|missing|incomplete|insufficient|blocked|error|unmet|unclear|inconsistent|needs?)\b/.test(text)
    || (/\bgaps?\b/.test(text) && !noGaps);
  return clearlyPositive || !clearlyNegative;
}

function pushUnique(lines: string[], seen: Set<string>, line: string): void {
  const cleaned = cleanText(line);
  if (!cleaned || seen.has(cleaned)) return;
  seen.add(cleaned);
  lines.push(`- ${cleaned}`);
}

export function buildPassingValidationReasonsMarkdown(scorecard: ValidationScorecard): string {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const readyThreshold = scorecard.ready_threshold ?? 90;

  for (const reason of collectExplicitReasons(scorecard)) {
    pushUnique(reasons, seen, reason);
  }

  for (const file of scorecard.files ?? []) {
    const label = fileLabel(file.file, file.filename);
    const explicitReasons = collectExplicitReasons(file);
    const passed = file.score >= readyThreshold || isReadyVerdict(file.verdict);

    if (passed) {
      const suffix = explicitReasons.length > 0
        ? `: ${explicitReasons.join('; ')}`
        : ' with no pending validation gaps.';
      pushUnique(reasons, seen, `**${label}** passed at ${Math.round(file.score)}%${suffix}`);
    } else {
      for (const reason of explicitReasons) {
        pushUnique(reasons, seen, `**${label}**: ${reason}`);
      }
    }

    for (const gap of file.gaps ?? []) {
      if (gap.resolution === 'filled' || gap.resolution === 'accepted') {
        pushUnique(reasons, seen, `**${label}** resolved: ${gap.description}`);
      }
    }
  }

  for (const feature of scorecard.features ?? []) {
    const label = feature.feature_title;
    const explicitReasons = collectExplicitReasons(feature);
    const passed = feature.overall_score >= readyThreshold || isReadyVerdict(feature.verdict);

    if (passed) {
      const suffix = explicitReasons.length > 0
        ? `: ${explicitReasons.join('; ')}`
        : ' with no pending validation gaps.';
      pushUnique(reasons, seen, `**${label}** passed at ${Math.round(feature.overall_score)}%${suffix}`);
    } else {
      for (const reason of explicitReasons) {
        pushUnique(reasons, seen, `**${label}**: ${reason}`);
      }
    }

    for (const gap of feature.gaps ?? []) {
      if (gap.resolution === 'filled' || gap.resolution === 'accepted') {
        pushUnique(reasons, seen, `**${label}** resolved: ${gap.description}`);
      }
    }
  }

  for (const [check, result] of Object.entries(scorecard.cross_cutting_checks ?? {})) {
    if (isPositiveCheckText(result)) {
      pushUnique(reasons, seen, `**${humanizeLabel(check)}**: ${result}`);
    }
  }

  if (reasons.length === 0) return '';
  return ['## Passing Validation Reasons', '', ...reasons].join('\n');
}
