/**
 * Pure parser for the `apex-evidence` (version 1) fenced JSON block emitted
 * at the end of a build implementer agent's final message (TBI-020, TBI-021, PBI-022).
 *
 * Keeps no database or storage imports.
 */
import type { BuildTestTier } from '../../../shared/types/build';

export const MAX_EVIDENCE_OUTPUT_BYTES = 100 * 1024;
export const HEAD_EVIDENCE_BYTES = 20 * 1024;
export const TAIL_EVIDENCE_BYTES = 80 * 1024;
export const EVIDENCE_TRUNCATION_MARKER = '\n...[truncated]...\n';

export type EvidenceTier = BuildTestTier;

export interface EvidenceTestReference {
  file: string;
  name: string;
}

export interface EvidenceRedRun {
  commit: string;
  command: string;
  exitCode: number;
  failedTests: string[];
  output: string;
}

export interface EvidenceGreenRun {
  commit: string;
  command: string;
  exitCode: number;
  passedTests: string[];
  output: string;
}

export interface EvidenceDeferral {
  reason: string;
}

export interface EvidenceEntry {
  requirementId: string;
  tier: EvidenceTier;
  testReferences: EvidenceTestReference[];
  red: EvidenceRedRun | null;
  green: EvidenceGreenRun | null;
  deferral: EvidenceDeferral | null;
}

export interface EvidenceCheckResult {
  command: string;
  exitCode: number;
}

export interface EvidenceChecks {
  typeCheck: EvidenceCheckResult | null;
  lint: EvidenceCheckResult | null;
  relatedTests: EvidenceCheckResult | null;
}

export interface EvidenceStandardsReview {
  completed: boolean;
  findings: string[];
}

export interface EvidenceEscalation {
  reason: string;
  planPath: string;
}

export interface EvidenceBlock {
  version: 1;
  taskKey: string;
  attemptNumber: number;
  entries: EvidenceEntry[];
  checks: EvidenceChecks;
  standardsReview: EvidenceStandardsReview | null;
  escalation: EvidenceEscalation | null;
}

export type EvidenceParseErrorCode =
  | 'no_block'
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_shape';

export type EvidenceParseResult =
  | { ok: true; block: EvidenceBlock }
  | { ok: false; code: EvidenceParseErrorCode };

const EVIDENCE_FENCE_PATTERN = /```[ \t]*apex-evidence\b[ \t]*\r?\n([\s\S]*?)```/g;

const VALID_TIERS: ReadonlySet<string> = new Set<EvidenceTier>(['unit', 'integration', 'e2e']);

/**
 * Caps a single red or green command output to at most 100 KB before redaction
 * and storage: retains the first 20 KB, a truncation marker, and the last 80 KB.
 */
export function capEvidenceOutput(output: string): string {
  if (output.length <= MAX_EVIDENCE_OUTPUT_BYTES && Buffer.byteLength(output, 'utf8') <= MAX_EVIDENCE_OUTPUT_BYTES) {
    return output;
  }
  if (output.length > MAX_EVIDENCE_OUTPUT_BYTES) {
    const head = output.slice(0, HEAD_EVIDENCE_BYTES);
    const tail = output.slice(output.length - TAIL_EVIDENCE_BYTES);
    return `${head}${EVIDENCE_TRUNCATION_MARKER}${tail}`;
  }
  const buf = Buffer.from(output, 'utf8');
  const head = buf.subarray(0, HEAD_EVIDENCE_BYTES).toString('utf8');
  const tail = buf.subarray(buf.byteLength - TAIL_EVIDENCE_BYTES).toString('utf8');
  return `${head}${EVIDENCE_TRUNCATION_MARKER}${tail}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseTestReferences(raw: unknown): EvidenceTestReference[] | null {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const refs: EvidenceTestReference[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return null;
    if (typeof item.file !== 'string' || typeof item.name !== 'string') return null;
    refs.push({ file: item.file, name: item.name });
  }
  return refs;
}

function parseRedRun(raw: unknown): { valid: true; value: EvidenceRedRun | null } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null };
  }
  if (!isPlainObject(raw)) {
    return { valid: false };
  }
  if (
    typeof raw.commit !== 'string' ||
    typeof raw.command !== 'string' ||
    typeof raw.exitCode !== 'number' ||
    !Number.isFinite(raw.exitCode) ||
    !isStringArray(raw.failedTests)
  ) {
    return { valid: false };
  }
  if (raw.output !== undefined && typeof raw.output !== 'string') {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      commit: raw.commit,
      command: raw.command,
      exitCode: raw.exitCode,
      failedTests: raw.failedTests,
      output: capEvidenceOutput(typeof raw.output === 'string' ? raw.output : ''),
    },
  };
}

function parseGreenRun(raw: unknown): { valid: true; value: EvidenceGreenRun | null } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null };
  }
  if (!isPlainObject(raw)) {
    return { valid: false };
  }
  if (
    typeof raw.commit !== 'string' ||
    typeof raw.command !== 'string' ||
    typeof raw.exitCode !== 'number' ||
    !Number.isFinite(raw.exitCode) ||
    !isStringArray(raw.passedTests)
  ) {
    return { valid: false };
  }
  if (raw.output !== undefined && typeof raw.output !== 'string') {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      commit: raw.commit,
      command: raw.command,
      exitCode: raw.exitCode,
      passedTests: raw.passedTests,
      output: capEvidenceOutput(typeof raw.output === 'string' ? raw.output : ''),
    },
  };
}

function parseDeferral(raw: unknown): { valid: true; value: EvidenceDeferral | null } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null };
  }
  if (!isPlainObject(raw) || typeof raw.reason !== 'string') {
    return { valid: false };
  }
  return { valid: true, value: { reason: raw.reason } };
}

function parseEntry(raw: unknown): EvidenceEntry | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.requirementId !== 'string' || raw.requirementId.trim().length === 0) {
    return null;
  }

  let tier: EvidenceTier = 'unit';
  if (raw.tier !== undefined && raw.tier !== null) {
    if (typeof raw.tier !== 'string' || !VALID_TIERS.has(raw.tier)) {
      return null;
    }
    tier = raw.tier as EvidenceTier;
  }

  const testReferences = parseTestReferences(raw.testReferences);
  if (!testReferences) return null;

  const red = parseRedRun(raw.red);
  if (!red.valid) return null;

  const green = parseGreenRun(raw.green);
  if (!green.valid) return null;

  const deferral = parseDeferral(raw.deferral);
  if (!deferral.valid) return null;

  return {
    requirementId: raw.requirementId,
    tier,
    testReferences,
    red: red.value,
    green: green.value,
    deferral: deferral.value,
  };
}

function parseCheckResult(raw: unknown): { valid: true; value: EvidenceCheckResult | null } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null };
  }
  if (
    !isPlainObject(raw) ||
    typeof raw.command !== 'string' ||
    typeof raw.exitCode !== 'number' ||
    !Number.isFinite(raw.exitCode)
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      command: raw.command,
      exitCode: raw.exitCode,
    },
  };
}

function parseChecks(raw: unknown): EvidenceChecks | null {
  if (raw === undefined || raw === null) {
    return { typeCheck: null, lint: null, relatedTests: null };
  }
  if (!isPlainObject(raw)) {
    return null;
  }
  const typeCheck = parseCheckResult(raw.typeCheck);
  const lint = parseCheckResult(raw.lint);
  const relatedTests = parseCheckResult(raw.relatedTests);
  if (!typeCheck.valid || !lint.valid || !relatedTests.valid) {
    return null;
  }
  return {
    typeCheck: typeCheck.value,
    lint: lint.value,
    relatedTests: relatedTests.value,
  };
}

function parseStandardsReview(
  raw: unknown,
): { valid: true; value: EvidenceStandardsReview | null } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null };
  }
  if (
    !isPlainObject(raw) ||
    typeof raw.completed !== 'boolean' ||
    !isStringArray(raw.findings)
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      completed: raw.completed,
      findings: raw.findings,
    },
  };
}

function parseEscalation(
  raw: unknown,
): { valid: true; value: EvidenceEscalation | null } | { valid: false } {
  if (raw === undefined || raw === null) {
    return { valid: true, value: null };
  }
  if (
    !isPlainObject(raw) ||
    typeof raw.reason !== 'string' ||
    typeof raw.planPath !== 'string'
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    value: {
      reason: raw.reason,
      planPath: raw.planPath,
    },
  };
}

/**
 * Extracts and validates the last fenced `apex-evidence` JSON block from an
 * agent's final message.
 */
export function parseEvidenceBlock(message: string): EvidenceParseResult {
  if (typeof message !== 'string' || message.length === 0) {
    return { ok: false, code: 'no_block' };
  }

  const matches = Array.from(message.matchAll(EVIDENCE_FENCE_PATTERN));
  if (matches.length === 0) {
    return { ok: false, code: 'no_block' };
  }

  const lastBody = matches[matches.length - 1][1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBody);
  } catch {
    return { ok: false, code: 'invalid_json' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'invalid_shape' };
  }

  if (!('version' in parsed) || typeof parsed.version !== 'number') {
    return { ok: false, code: 'invalid_shape' };
  }
  if (parsed.version !== 1) {
    return { ok: false, code: 'unsupported_version' };
  }

  if (typeof parsed.taskKey !== 'string' || parsed.taskKey.trim().length === 0) {
    return { ok: false, code: 'invalid_shape' };
  }

  if (
    typeof parsed.attemptNumber !== 'number' ||
    !Number.isInteger(parsed.attemptNumber) ||
    parsed.attemptNumber < 1
  ) {
    return { ok: false, code: 'invalid_shape' };
  }

  if (!Array.isArray(parsed.entries)) {
    return { ok: false, code: 'invalid_shape' };
  }

  const entries: EvidenceEntry[] = [];
  for (const rawEntry of parsed.entries) {
    const entry = parseEntry(rawEntry);
    if (!entry) {
      return { ok: false, code: 'invalid_shape' };
    }
    entries.push(entry);
  }

  const checks = parseChecks(parsed.checks);
  if (!checks) {
    return { ok: false, code: 'invalid_shape' };
  }

  const standardsReview = parseStandardsReview(parsed.standardsReview);
  if (!standardsReview.valid) {
    return { ok: false, code: 'invalid_shape' };
  }

  const escalation = parseEscalation(parsed.escalation);
  if (!escalation.valid) {
    return { ok: false, code: 'invalid_shape' };
  }

  return {
    ok: true,
    block: {
      version: 1,
      taskKey: parsed.taskKey,
      attemptNumber: parsed.attemptNumber,
      entries,
      checks,
      standardsReview: standardsReview.value,
      escalation: escalation.value,
    },
  };
}
