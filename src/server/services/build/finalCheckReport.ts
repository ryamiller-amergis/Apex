/**
 * Final check report parser, pass predicate, and single-agent skip predicate (FEAT-012, S2).
 */
import type {
  BuildTaskRole,
  BuildTaskRunMode,
  BuildTaskStatus,
} from '../../../shared/types/build';
import type {
  FinalCheckCommandResult,
  FinalCheckKind,
  FinalCheckReport,
  StandardsFinding,
  StandardsReview,
  StandardsRule,
} from '../../../shared/types/buildFinalCheck';
import { redactText } from '../buildRedactionService';

const FENCE_RE = /```apex-final-check-report\s*\r?\n([\s\S]*?)\r?\n```/;
const MAX_TEXT = 500;
const MAX_LIST = 50;

const ALLOWED_TOP_KEYS = new Set([
  'schemaVersion',
  'validatedCommit',
  'repairedInSession',
  'checks',
  'standards',
  'summary',
]);

const ALLOWED_CHECK_KEYS = new Set([
  'kind',
  'outcome',
  'failedTests',
  'summary',
]);
const ALLOWED_CHECK_KINDS: ReadonlySet<FinalCheckKind> = new Set([
  'unit_full',
  'unit_related',
  'type_check',
  'lint',
]);

const ALLOWED_FINDING_KEYS = new Set([
  'rule',
  'file',
  'line',
  'resolution',
  'detail',
  'exceptionReason',
]);

const ALLOWED_RULES: ReadonlySet<StandardsRule> = new Set([
  'duplicate_helper',
  'hard_coded_colour',
  'off_library_component',
  'missing_accessibility',
]);

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function hasOnlyKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

function cleanText(raw: string): string {
  return redactText(raw).slice(0, MAX_TEXT);
}

function parseCheckEntry(raw: unknown): FinalCheckCommandResult | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ALLOWED_CHECK_KEYS)) return null;
  const { kind, outcome, failedTests, summary } = raw;
  if (
    typeof kind !== 'string' ||
    !ALLOWED_CHECK_KINDS.has(kind as FinalCheckKind)
  )
    return null;
  if (outcome !== 'passed' && outcome !== 'failed') return null;
  if (typeof summary !== 'string') return null;

  let cleanedFailedTests: string[] | undefined;
  if (failedTests !== undefined) {
    if (
      !Array.isArray(failedTests) ||
      !failedTests.every((t) => typeof t === 'string')
    ) {
      return null;
    }
    cleanedFailedTests = failedTests
      .slice(0, MAX_LIST)
      .map((t) => cleanText(t));
  }

  return {
    kind: kind as FinalCheckKind,
    outcome,
    ...(cleanedFailedTests !== undefined
      ? { failedTests: cleanedFailedTests }
      : {}),
    summary: cleanText(summary),
  };
}

function parseFinding(raw: unknown): StandardsFinding | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ALLOWED_FINDING_KEYS)) return null;
  const { rule, file, line, resolution, detail, exceptionReason } = raw;
  if (typeof rule !== 'string' || !ALLOWED_RULES.has(rule as StandardsRule))
    return null;
  if (typeof file !== 'string' || file.trim().length === 0) return null;
  if (
    line !== undefined &&
    (typeof line !== 'number' || !Number.isInteger(line) || line < 1)
  ) {
    return null;
  }
  if (
    resolution !== 'fixed' &&
    resolution !== 'exception' &&
    resolution !== 'open'
  ) {
    return null;
  }
  if (typeof detail !== 'string') return null;
  if (resolution === 'exception') {
    if (
      typeof exceptionReason !== 'string' ||
      exceptionReason.trim().length === 0
    ) {
      return null;
    }
  } else if (
    exceptionReason !== undefined &&
    typeof exceptionReason !== 'string'
  ) {
    return null;
  }

  return {
    rule: rule as StandardsRule,
    file: cleanText(file),
    ...(line !== undefined ? { line } : {}),
    resolution,
    detail: cleanText(detail),
    ...(exceptionReason !== undefined
      ? { exceptionReason: cleanText(exceptionReason) }
      : {}),
  };
}

function parseStandards(raw: unknown): StandardsReview | null {
  if (!isRecord(raw)) return null;
  if (raw.status === 'unreadable_input') {
    if (!hasOnlyKeys(raw, new Set(['status', 'path']))) return null;
    if (typeof raw.path !== 'string' || raw.path.trim().length === 0)
      return null;
    return { status: 'unreadable_input', path: cleanText(raw.path) };
  }
  if (raw.status === 'reviewed') {
    if (!hasOnlyKeys(raw, new Set(['status', 'findings', 'reviewSeconds'])))
      return null;
    if (!Array.isArray(raw.findings)) return null;
    if (
      raw.reviewSeconds !== undefined &&
      (typeof raw.reviewSeconds !== 'number' ||
        !Number.isFinite(raw.reviewSeconds) ||
        raw.reviewSeconds < 0)
    ) {
      return null;
    }
    const findings: StandardsFinding[] = [];
    for (const item of raw.findings.slice(0, MAX_LIST)) {
      const parsed = parseFinding(item);
      if (!parsed) return null;
      findings.push(parsed);
    }
    return {
      status: 'reviewed',
      findings,
      ...(raw.reviewSeconds !== undefined
        ? { reviewSeconds: raw.reviewSeconds }
        : {}),
    };
  }
  return null;
}

export function parseFinalCheckReport(
  resultText: string | null
):
  | { ok: true; report: FinalCheckReport }
  | { ok: false; reason: 'no_block' | 'invalid_json' | 'schema' } {
  if (!resultText || typeof resultText !== 'string') {
    return { ok: false, reason: 'no_block' };
  }
  const match = FENCE_RE.exec(resultText);
  if (!match) {
    return { ok: false, reason: 'no_block' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (!isRecord(raw) || !hasOnlyKeys(raw, ALLOWED_TOP_KEYS)) {
    return { ok: false, reason: 'schema' };
  }
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'schema' };
  if (
    typeof raw.validatedCommit !== 'string' ||
    raw.validatedCommit.trim().length === 0
  ) {
    return { ok: false, reason: 'schema' };
  }
  if (typeof raw.repairedInSession !== 'boolean')
    return { ok: false, reason: 'schema' };
  if (typeof raw.summary !== 'string') return { ok: false, reason: 'schema' };
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    return { ok: false, reason: 'schema' };
  }

  const checks: FinalCheckCommandResult[] = [];
  for (const item of raw.checks.slice(0, MAX_LIST)) {
    const parsed = parseCheckEntry(item);
    if (!parsed) return { ok: false, reason: 'schema' };
    checks.push(parsed);
  }

  const kinds = new Set(checks.map((c) => c.kind));
  if (!kinds.has('unit_full') || !kinds.has('unit_related')) {
    return { ok: false, reason: 'schema' };
  }

  const standards = parseStandards(raw.standards);
  if (!standards) return { ok: false, reason: 'schema' };

  return {
    ok: true,
    report: {
      schemaVersion: 1,
      validatedCommit: raw.validatedCommit.trim(),
      repairedInSession: raw.repairedInSession,
      checks,
      standards,
      summary: cleanText(raw.summary),
    },
  };
}

export function isCheckPassed(report: FinalCheckReport): boolean {
  if (report.standards.status === 'unreadable_input') return false;
  const kinds = new Set(report.checks.map((c) => c.kind));
  if (!kinds.has('unit_full') || !kinds.has('unit_related')) return false;
  return report.checks.every((c) => c.outcome === 'passed');
}

export interface BuildTaskSummaryRow {
  role: BuildTaskRole;
  status: BuildTaskStatus;
  runMode: BuildTaskRunMode;
}

/**
 * Returns false when the revision's non-omitted implementer/qa tasks include at most one
 * task with `runMode === 'own_agent'` (meaning every task ran in a single agent).
 */
export function shouldRunFinalCheck(
  tasks: readonly BuildTaskSummaryRow[]
): boolean {
  const activeOwnAgentTasks = tasks.filter(
    (task) =>
      task.status !== 'omitted' &&
      (task.role === 'implementer' || task.role === 'qa') &&
      task.runMode === 'own_agent'
  );
  return activeOwnAgentTasks.length > 1;
}
