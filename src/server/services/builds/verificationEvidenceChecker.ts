/**
 * Pure verification evidence checker for build tasks (TBI-021, PBI-022, PBI-023).
 *
 * Evaluates a parsed `apex-evidence` block against the task's owned requirement
 * and risk-decision IDs, quality manifest commands, and owned files.
 * Keeps no database or storage imports.
 */
import type {
  VerificationKind,
  VerificationStatus,
  VerificationTier,
} from '../../../shared/types/buildView';
import type {
  EvidenceBlock,
  EvidenceGreenRun,
  EvidenceRedRun,
  EvidenceTestReference,
} from './evidenceBlockParser';

export type ViolationCode =
  | 'missing_evidence_entry'
  | 'missing_test_reference'
  | 'missing_red_evidence'
  | 'missing_green_evidence'
  | 'red_not_failing'
  | 'green_not_passing'
  | 'red_green_same_commit'
  | 'test_not_in_run'
  | 'check_missing'
  | 'check_failed'
  | 'command_mismatch'
  | 'invalid_test_reference'
  | 'deferral_not_allowed';

export interface Violation {
  code: ViolationCode;
  requirementId: string | null;
}

export interface OwnedRequirementSpec {
  id: string;
  kind: VerificationKind;
  retired: boolean;
}

export interface VerificationRowWrite {
  requirementId: string;
  kind: VerificationKind;
  tier: VerificationTier | null;
  status: VerificationStatus;
  testReferences: { file: string; name: string }[];
  red: EvidenceRedRun | null;
  green: EvidenceGreenRun | null;
  deferralReason: string | null;
}

export interface DecideTaskDoneInput {
  ownedIds: OwnedRequirementSpec[];
  block: EvidenceBlock;
  manifest: { typeCheck: string; lint: string; relatedTests: string };
  ownedFiles: string[] | null;
}

export interface DecideTaskDoneResult {
  outcome: 'done' | 'refused' | 'escalate';
  mayReportDone: boolean;
  rows: VerificationRowWrite[];
  violations: Violation[];
  unknownRequirementIds: string[];
  escalation: { reason: string; planPath: string } | null;
}

const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;

/**
 * Normalizes a repository-relative path (stripping leading `./` and converting `\` to `/`).
 * Returns `null` if the path is empty, absolute, contains line breaks, or contains `.` or `..` segments.
 */
function normalizeRepoRelativePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
    return null;
  }
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    WINDOWS_DRIVE_PATTERN.test(trimmed)
  ) {
    return null;
  }

  const stripped = trimmed.replace(/^\.[\\/]+/, '');
  const normalized = stripped.replace(/\\/g, '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    WINDOWS_DRIVE_PATTERN.test(normalized)
  ) {
    return null;
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return null;
    }
  }

  return normalized;
}

function validateTestReferences(
  testReferences: EvidenceTestReference[],
  ownedFilesSet: ReadonlySet<string> | null,
): ViolationCode | null {
  if (testReferences.length === 0) {
    return 'missing_test_reference';
  }

  for (const ref of testReferences) {
    if (ref.name.trim().length === 0) {
      return 'invalid_test_reference';
    }
    const normalizedFile = normalizeRepoRelativePath(ref.file);
    if (normalizedFile === null) {
      return 'invalid_test_reference';
    }
    if (ownedFilesSet !== null && !ownedFilesSet.has(normalizedFile)) {
      return 'invalid_test_reference';
    }
  }

  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesManifestCommand(
  checkKey: 'typeCheck' | 'lint' | 'relatedTests',
  reportedCommand: string,
  expectedManifestCommand: string,
): boolean {
  const actual = reportedCommand.trim();
  const expected = expectedManifestCommand.trim();
  if (actual === expected) {
    return true;
  }
  if (checkKey === 'relatedTests' && expected.includes('{files}')) {
    const patternSource = expected
      .split('{files}')
      .map((part) => escapeRegExp(part))
      .join('(\\S[\\s\\S]*)');
    const regex = new RegExp(`^${patternSource}$`);
    return regex.test(actual);
  }
  return false;
}

/**
 * Pure decision function for build task completion and verification row writes.
 */
export function decideTaskDone(input: DecideTaskDoneInput): DecideTaskDoneResult {
  const { ownedIds, block, manifest, ownedFiles } = input;

  const ownedById = new Map<string, OwnedRequirementSpec>();
  for (const spec of ownedIds) {
    ownedById.set(spec.id, spec);
  }

  const unknownRequirementIds: string[] = [];
  const entryByRequirementId = new Map<string, (typeof block.entries)[number]>();

  for (const entry of block.entries) {
    const spec = ownedById.get(entry.requirementId);
    if (!spec) {
      if (!unknownRequirementIds.includes(entry.requirementId)) {
        unknownRequirementIds.push(entry.requirementId);
      }
      continue;
    }
    if (spec.retired) {
      continue;
    }
    entryByRequirementId.set(entry.requirementId, entry);
  }

  const activeSpecs = ownedIds.filter((spec) => !spec.retired);

  // Escalation on the small path preserves committed red evidence rows as 'fail' and does not report done.
  if (
    block.escalation !== null &&
    block.escalation.reason.trim().length > 0 &&
    block.escalation.planPath.trim().length > 0
  ) {
    const escalationRows: VerificationRowWrite[] = [];
    for (const spec of activeSpecs) {
      const entry = entryByRequirementId.get(spec.id);
      if (entry && entry.red !== null) {
        escalationRows.push({
          requirementId: spec.id,
          kind: spec.kind,
          tier: entry.tier,
          status: 'fail',
          testReferences: entry.testReferences,
          red: entry.red,
          green: null,
          deferralReason: null,
        });
      }
    }

    return {
      outcome: 'escalate',
      mayReportDone: false,
      rows: escalationRows,
      violations: [],
      unknownRequirementIds,
      escalation: {
        reason: block.escalation.reason,
        planPath: block.escalation.planPath,
      },
    };
  }

  const ownedFilesSet: Set<string> | null =
    ownedFiles === null
      ? null
      : new Set(
          ownedFiles
            .map((file) => normalizeRepoRelativePath(file))
            .filter((file): file is string => file !== null),
        );

  const rows: VerificationRowWrite[] = [];
  const violations: Violation[] = [];

  for (const spec of activeSpecs) {
    const entry = entryByRequirementId.get(spec.id);
    if (!entry) {
      violations.push({ code: 'missing_evidence_entry', requirementId: spec.id });
      rows.push({
        requirementId: spec.id,
        kind: spec.kind,
        tier: null,
        status: 'fail',
        testReferences: [],
        red: null,
        green: null,
        deferralReason: null,
      });
      continue;
    }

    const entryViolations: Violation[] = [];
    const testRefViolation = validateTestReferences(entry.testReferences, ownedFilesSet);
    if (testRefViolation !== null) {
      entryViolations.push({ code: testRefViolation, requirementId: spec.id });
    }

    if (entry.deferral !== null) {
      const reason = entry.deferral.reason.trim();
      const deferralAllowed =
        (entry.tier === 'e2e' || spec.kind === 'nfr') && reason.length > 0;

      if (!deferralAllowed) {
        entryViolations.push({ code: 'deferral_not_allowed', requirementId: spec.id });
      }

      violations.push(...entryViolations);
      const isDeferredPass = entryViolations.length === 0;
      rows.push({
        requirementId: spec.id,
        kind: spec.kind,
        tier: entry.tier,
        status: isDeferredPass ? 'deferred' : 'fail',
        testReferences: entry.testReferences,
        red: isDeferredPass ? null : entry.red,
        green: isDeferredPass ? null : entry.green,
        deferralReason: reason.length > 0 ? reason : null,
      });
      continue;
    }

    let testNotInRunEmitted = false;

    if (entry.red === null || entry.red.commit.trim().length === 0) {
      entryViolations.push({ code: 'missing_red_evidence', requirementId: spec.id });
    } else {
      if (entry.red.exitCode === 0) {
        entryViolations.push({ code: 'red_not_failing', requirementId: spec.id });
      }
      if (
        entry.testReferences.length > 0 &&
        !entry.testReferences.every((ref) => entry.red!.failedTests.includes(ref.name))
      ) {
        entryViolations.push({ code: 'test_not_in_run', requirementId: spec.id });
        testNotInRunEmitted = true;
      }
    }

    if (entry.green === null || entry.green.commit.trim().length === 0) {
      entryViolations.push({ code: 'missing_green_evidence', requirementId: spec.id });
    } else {
      if (entry.green.exitCode !== 0) {
        entryViolations.push({ code: 'green_not_passing', requirementId: spec.id });
      }
      if (
        !testNotInRunEmitted &&
        entry.testReferences.length > 0 &&
        !entry.testReferences.every((ref) => entry.green!.passedTests.includes(ref.name))
      ) {
        entryViolations.push({ code: 'test_not_in_run', requirementId: spec.id });
      }
    }

    if (
      entry.red !== null &&
      entry.green !== null &&
      entry.red.commit.trim().length > 0 &&
      entry.red.commit.trim() === entry.green.commit.trim()
    ) {
      entryViolations.push({ code: 'red_green_same_commit', requirementId: spec.id });
    }

    violations.push(...entryViolations);
    rows.push({
      requirementId: spec.id,
      kind: spec.kind,
      tier: entry.tier,
      status: entryViolations.length === 0 ? 'pass' : 'fail',
      testReferences: entry.testReferences,
      red: entry.red,
      green: entry.green,
      deferralReason: null,
    });
  }

  const checkKeys: Array<'typeCheck' | 'lint' | 'relatedTests'> = [
    'typeCheck',
    'lint',
    'relatedTests',
  ];
  for (const checkKey of checkKeys) {
    const reported = block.checks?.[checkKey] ?? null;
    if (!reported) {
      violations.push({ code: 'check_missing', requirementId: null });
      continue;
    }
    if (!matchesManifestCommand(checkKey, reported.command, manifest[checkKey])) {
      violations.push({ code: 'command_mismatch', requirementId: null });
    }
    if (reported.exitCode !== 0) {
      violations.push({ code: 'check_failed', requirementId: null });
    }
  }

  const mayReportDone = violations.length === 0;
  return {
    outcome: mayReportDone ? 'done' : 'refused',
    mayReportDone,
    rows,
    violations,
    unknownRequirementIds,
    escalation: null,
  };
}
