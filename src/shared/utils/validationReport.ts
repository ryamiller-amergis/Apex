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

const OVERALL_PERCENT_KEYS = [
  'overall_score',
  'overall_percentage',
  'overall_percent',
  'overall_pct',
  'overall',
] as const;

const PERCENT_KEYS = [
  'percentage',
  'percent',
  'pct',
  'score_pct',
  'weighted_percentage',
  'weighted_pct',
  'overall_score',
  'score',
  'value',
] as const;

/** Section lists the prd-spec-review skill scores on its 0–3 rubric. */
const RUBRIC_SECTION_KEYS = ['prd_sections', 'backlog_sections'] as const;
const RUBRIC_MAX_SECTION_SCORE = 3;

/**
 * Resolve the overall percentage from a scorecard. Prefers a percentage the
 * agent wrote (top-level, `summary`, `scores`, or `files[]`); only when none is
 * present does it apply the skill's weighted 0–3 formula to the stored section
 * scores. Returns null when nothing usable is present.
 */
export function resolveScorecardOverallScore(raw: unknown): number | null {
  const record = asRecord(raw);
  if (!record) return null;

  const direct = firstPercent(record, OVERALL_PERCENT_KEYS);
  if (direct !== null) return direct;

  const summary = asRecord(record.summary);
  if (summary) {
    const fromSummary = firstPercent(summary, OVERALL_PERCENT_KEYS);
    if (fromSummary !== null) return fromSummary;
  }

  const scores = asRecord(record.scores);
  if (scores) {
    const overall = firstPercent(scores, OVERALL_PERCENT_KEYS);
    if (overall !== null) return overall;

    const parts = Object.entries(scores)
      .filter(([key]) => !(OVERALL_PERCENT_KEYS as readonly string[]).includes(key))
      .map(([, value]) => percentOf(value));
    const average = averageOf(parts);
    if (average !== null) return average;
  }

  const files = Array.isArray(record.files) ? record.files : [];
  const fileAverage = averageOf(files.map((file) => percentOf(file)));
  if (fileAverage !== null) return fileAverage;

  return averageOf(RUBRIC_SECTION_KEYS.map((key) => rubricSectionsPercent(record[key])));
}

function firstPercent(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = percentOf(record[key]);
    if (value !== null) return value;
  }
  return null;
}

/** A number, a "82%" string, `{ score, max }`, or a record carrying a percent field. */
function percentOf(value: unknown): number | null {
  const direct = finitePercent(value);
  if (direct !== null) return direct;
  const record = asRecord(value);
  if (!record) return null;

  const max = finiteNumber(record.max) ?? finiteNumber(record.out_of) ?? finiteNumber(record.max_score);
  const earned = finiteNumber(record.score) ?? finiteNumber(record.value);
  if (max !== null && max > 0 && earned !== null) return (earned / max) * 100;

  for (const key of PERCENT_KEYS) {
    const pct = finitePercent(record[key]);
    if (pct !== null) return pct;
  }
  return null;
}

/** Applies `Σ(score × weight) / (3 × Σ weight) × 100`; null if any score is off the 0–3 rubric. */
function rubricSectionsPercent(value: unknown): number | null {
  const entries = Array.isArray(value)
    ? value
    : asRecord(value)
      ? Object.values(value as Record<string, unknown>)
      : [];
  let weighted = 0;
  let totalWeight = 0;
  for (const entry of entries) {
    const section = asRecord(entry);
    const score = section ? finiteNumber(section.score) : finiteNumber(entry);
    if (score === null) continue;
    if (score < 0 || score > RUBRIC_MAX_SECTION_SCORE) return null;
    const weight = section ? finiteNumber(section.weight) ?? 1 : 1;
    if (weight <= 0) continue;
    weighted += score * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? (weighted / (RUBRIC_MAX_SECTION_SCORE * totalWeight)) * 100 : null;
}

function averageOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

function finitePercent(value: unknown): number | null {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/%$/, '').trim();
    return trimmed === '' ? null : finiteNumber(trimmed);
  }
  return finiteNumber(value);
}

/** True for the placeholder Apex stores when the agent's scorecard had no usable score. */
export function isUnusableValidationScorecard(
  scorecard: Pick<ValidationScorecard, 'slug'> | null | undefined,
): boolean {
  return scorecard?.slug === 'validation-unusable';
}

/** Last-resort scorecard so a finished run always has something the UI can show. */
export function buildUnusableValidationScorecard(description: string): ValidationScorecard {
  return {
    slug: 'validation-unusable',
    generated_at: new Date().toISOString(),
    review_phase: 'initial',
    overall_score: 0,
    ready_threshold: 90,
    is_ready: false,
    verdict: 'significant_gaps',
    gaps: [
      {
        id: 'validation-unusable-scorecard',
        file: 'review-scorecard.json',
        section: 'Scorecard',
        score: 0,
        description,
        what_3_looks_like:
          'A scorecard with overall_score (or files[].score) so Apex can display a result.',
        resolution: 'pending',
      },
    ],
  };
}

/**
 * Parse an agent-written scorecard file. Always returns a scorecard so callers
 * can persist a result even when JSON is missing a usable overall score.
 */
export function parseAgentValidationScorecard(raw: string): ValidationScorecard {
  try {
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeValidationScorecard(parsed);
    const record = asRecord(parsed);
    if (normalized) return normalized;
    const keys = record ? Object.keys(record).slice(0, 24).join(',') : typeof parsed;
    console.warn(`[validation] Unusable scorecard shape keys=${keys}`);
    return buildUnusableValidationScorecard(
      `Validation finished but the scorecard had no usable overall score (keys: ${keys || 'none'}). Re-run validation.`,
    );
  } catch {
    return buildUnusableValidationScorecard(
      'Validation finished but the scorecard file was not valid JSON. Re-run validation.',
    );
  }
}

export const NO_SCORECARD_REASON =
  'Validation finished without writing a scorecard. Re-run validation.';
export const VALIDATION_TIMEOUT_REASON =
  'Validation timed out before a scorecard was available. Re-run validation.';

/**
 * Parse-site guard for agent-written scorecards. Returns the scorecard with a
 * canonical finite `overall_score`, or null when no usable score can be
 * resolved — `validation_score` is an integer column, so an unresolved score
 * must be rejected rather than rounded into NaN.
 */
export function normalizeValidationScorecard(raw: unknown): ValidationScorecard | null {
  const record = asRecord(raw);
  if (!record) return null;
  const overallScore = resolveScorecardOverallScore(record);
  if (overallScore === null) return null;
  return { ...(record as unknown as ValidationScorecard), overall_score: overallScore };
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

function finiteNumber(value: unknown): number | null {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof num === 'number' && Number.isFinite(num) ? num : null;
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

export interface NormalizedCrossCuttingCheck {
  key: string;
  label: string;
  /** Lowercased status token for CSS `data-status` (e.g. `pass`, `fail`). */
  status: string;
  detail: string;
  displayText: string;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return cleanText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Accept both the string shape (`"pass"`) and the foundation-skill object
 * shape (`{ label, status, detail }`) so scorecard UI does not call
 * `.toLowerCase()` on a non-string.
 */
export function normalizeCrossCuttingCheck(
  key: string,
  value: unknown,
): NormalizedCrossCuttingCheck {
  const record = asRecord(value);
  if (record) {
    const status = textFromUnknown(record.status);
    const detail = textFromUnknown(record.detail)
      || textFromUnknown(record.description)
      || textFromUnknown(record.result);
    const label = textFromUnknown(record.label) || humanizeLabel(key);
    const displayText = [status, detail].filter(Boolean).join(' — ') || label;
    return {
      key,
      label,
      status: status.toLowerCase(),
      detail,
      displayText,
    };
  }

  const text = textFromUnknown(value);
  return {
    key,
    label: humanizeLabel(key),
    status: text.toLowerCase(),
    detail: '',
    displayText: text,
  };
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
    const normalized = normalizeCrossCuttingCheck(check, result);
    if (!normalized.displayText) continue;
    if (isPositiveCheckText(normalized.displayText) || isPositiveCheckText(normalized.status)) {
      pushUnique(reasons, seen, `**${normalized.label}**: ${normalized.displayText}`);
    }
  }

  if (reasons.length === 0) return '';
  return ['## Passing Validation Reasons', '', ...reasons].join('\n');
}
