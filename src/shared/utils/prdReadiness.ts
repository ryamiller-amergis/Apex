import type {
  PrdStatus,
  TestCaseCoverageSummary,
  TestCaseSummary,
  TestCaseValidationStatus,
} from '../types/interview';

export type PrdReadinessState =
  | 'prd_generating'
  | 'test_cases_pending'
  | 'test_cases_generating'
  | 'test_case_generation_failed'
  | 'coverage_gaps'
  | 'test_cases_validating'
  | 'validation_pending'
  | 'validation_unavailable'
  | 'validation_failed'
  | 'ready_for_review'
  | 'approved';

export type PrdReadinessSeverity = 'neutral' | 'info' | 'warning' | 'error' | 'success';

export type PrdReadinessStageStatus = 'complete' | 'current' | 'pending' | 'blocked';

export interface PrdReadinessStage {
  id: 'prd' | 'test_cases' | 'validation' | 'ready';
  label: string;
  status: PrdReadinessStageStatus;
  detail?: string;
}

export interface PrdReadiness {
  state: PrdReadinessState;
  label: string;
  description: string;
  severity: PrdReadinessSeverity;
  readyForReviewActions: boolean;
  blockingReason?: string;
  stages: PrdReadinessStage[];
  qaFailures: string[];
}

type ReadinessPrd = {
  status: PrdStatus;
  content?: string | null;
  validationScore?: number | null;
  validationScorecard?: {
    is_ready?: boolean;
    overall_score?: number;
    ready_threshold?: number;
  } | null;
};

/** Returns true only when actual PBI/AC/BR coverage is incomplete or no cases were generated. */
function coverageHasFailures(summary?: TestCaseCoverageSummary | null): boolean {
  if (!summary) return false;
  if (summary.totalCases === 0) return true;
  return fractionIsIncomplete(summary.acCovered) || fractionIsIncomplete(summary.brCovered);
}

/** Returns true when a "covered/total" fraction string has uncovered items, e.g. "3/5". */
function fractionIsIncomplete(fraction?: string | null): boolean {
  if (!fraction) return false;
  const [covered, total] = fraction.split('/').map(Number);
  return !isNaN(covered) && !isNaN(total) && total > 0 && covered < total;
}

function coverageFailures(summary?: TestCaseCoverageSummary | null): string[] {
  if (!summary) return [];
  const failures: string[] = [];
  if (summary.totalCases === 0) {
    failures.push('No test cases were generated.');
  }
  if (fractionIsIncomplete(summary.acCovered)) {
    failures.push(`Acceptance criteria not fully covered: ${summary.acCovered}.`);
  }
  if (fractionIsIncomplete(summary.brCovered)) {
    failures.push(`Business rules not fully covered: ${summary.brCovered}.`);
  }
  return failures;
}

function coverageDetail(summary?: TestCaseCoverageSummary | null): string | undefined {
  if (!summary) return undefined;
  return `${summary.totalCases} case${summary.totalCases === 1 ? '' : 's'}, ${summary.acCovered} AC, ${summary.brCovered} BR`;
}

function validationStatus(
  testCase: TestCaseSummary | null | undefined
): TestCaseValidationStatus {
  return testCase?.validationStatus ?? 'not_available';
}

function prdSpecValidationStatus(prd: ReadinessPrd): 'passed' | 'failed' | 'not_available' {
  if (prd.validationScorecard?.is_ready === true) return 'passed';
  if (prd.validationScorecard?.is_ready === false) return 'failed';
  const score = prd.validationScore ?? prd.validationScorecard?.overall_score;
  if (score === null || score === undefined) return 'not_available';
  return score >= (prd.validationScorecard?.ready_threshold ?? 90) ? 'passed' : 'failed';
}

export function derivePrdReadiness(
  prd: ReadinessPrd,
  testCase: TestCaseSummary | null | undefined
): PrdReadiness {
  const hasContentSignal = Object.prototype.hasOwnProperty.call(prd, 'content');
  const prdGenerated =
    prd.status !== 'generating' && (!hasContentSignal || !!prd.content);
  const testCaseStatus = testCase?.status;
  const testCaseValidation = validationStatus(testCase);
  const prdSpecValidation = prdSpecValidationStatus(prd);
  const validation =
    testCaseValidation === 'failed' || testCaseValidation === 'validating'
      ? testCaseValidation
      : prdSpecValidation !== 'not_available'
        ? prdSpecValidation
        : testCaseValidation;
  const testCaseCoverageHasFailures = coverageHasFailures(testCase?.coverageSummary);
  const testCasesReadyForValidation =
    testCaseStatus === 'ready' && !testCaseCoverageHasFailures;
  const qaFailures = [
    ...coverageFailures(testCase?.coverageSummary),
    ...(prdSpecValidation === 'failed'
      ? [`PRD validation score is ${Math.round(prd.validationScore ?? prd.validationScorecard?.overall_score ?? 0)}%.`]
      : []),
    ...(testCase?.validationSummary?.failures ?? []),
  ];

  const prdStage: PrdReadinessStage = {
    id: 'prd',
    label: 'PRD generated',
    status: prdGenerated ? 'complete' : prd.status === 'generating' ? 'current' : 'pending',
    detail: prdGenerated ? undefined : 'PRD content is still being produced.',
  };

  const testCaseStage: PrdReadinessStage = {
    id: 'test_cases',
    label:
      testCaseStatus === 'failed'
        ? 'Test-case generation failed'
        : testCaseStatus === 'ready' && testCaseCoverageHasFailures
          ? 'Coverage gaps remain'
          : testCaseStatus === 'generating'
            ? 'Generating test cases'
            : 'Test-case generation',
    status:
      testCaseStatus === 'ready'
        ? testCaseCoverageHasFailures
          ? 'blocked'
          : 'complete'
        : testCaseStatus === 'failed'
          ? 'blocked'
          : testCaseStatus === 'generating'
            ? 'current'
            : prdGenerated
              ? 'current'
              : 'pending',
    detail:
      testCaseStatus === 'ready'
        ? coverageDetail(testCase?.coverageSummary) ?? 'Generated without a coverage summary.'
        : testCaseStatus === 'failed'
          ? 'Generation did not complete.'
          : testCaseStatus === 'generating'
            ? 'Generating from the PRD backlog.'
            : 'Waiting for test-case generation.',
  };

  const validationStage: PrdReadinessStage = {
    id: 'validation',
    label:
      validation === 'passed'
        ? prdSpecValidation === 'passed'
          ? 'PRD validation passed'
          : 'Test cases validated'
        : validation === 'failed'
          ? prdSpecValidation === 'failed'
            ? 'PRD validation gaps'
            : 'Validation failed'
          : validation === 'validating'
            ? 'Validating test cases'
            : validation === 'not_available' && testCasesReadyForValidation
              ? 'Validation unavailable'
              : 'Validation pending',
    status:
      validation === 'passed'
        ? 'complete'
        : validation === 'failed'
          ? 'blocked'
          : validation === 'validating'
            ? 'current'
            : validation === 'pending'
              ? 'current'
              : validation === 'not_available' && testCasesReadyForValidation
                ? 'blocked'
                : 'pending',
    detail:
      validation === 'passed'
        ? prdSpecValidation === 'passed'
          ? `PRD validation passed at ${Math.round(prd.validationScore ?? prd.validationScorecard?.overall_score ?? 0)}%.`
          : testCase?.validationSummary?.checkedAt
          ? `Validated ${testCase.validationSummary.checkedAt}`
          : 'Validation passed.'
        : validation === 'failed'
          ? prdSpecValidation === 'failed'
            ? `PRD validation needs ${prd.validationScorecard?.ready_threshold ?? 90}% to pass.`
            : 'Validation reported failures.'
          : validation === 'validating'
            ? 'Validation is running.'
            : validation === 'pending'
              ? 'Validation is queued.'
              : testCasesReadyForValidation
                ? 'Validation is not available yet.'
                : testCaseStatus === 'ready' && testCaseCoverageHasFailures
                  ? 'Resolve coverage gaps before validation.'
                  : 'Waiting for generated test cases.',
  };

  const readyStage: PrdReadinessStage = {
    id: 'ready',
    label: 'Review locked',
    status: 'pending',
  };

  const qaGatesPassed =
    prdGenerated &&
    testCaseStatus === 'ready' &&
    !testCaseCoverageHasFailures &&
    validation === 'passed';

  if (prd.status === 'approved' && qaGatesPassed) {
    readyStage.label = 'Ready for review';
    readyStage.status = 'complete';
    return {
      state: 'approved',
      label: 'Approved',
      description: 'Human review is complete.',
      severity: 'success',
      readyForReviewActions: true,
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures,
    };
  }

  if (!prdGenerated) {
    return {
      state: 'prd_generating',
      label: 'Generating PRD',
      description: 'The PRD must finish generating before QA can run.',
      severity: 'info',
      readyForReviewActions: false,
      blockingReason: 'PRD generation must finish before review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures,
    };
  }

  if (!testCase) {
    return {
      state: 'test_cases_pending',
      label: 'Waiting on test cases',
      description: 'Test-case generation is required before PRD review.',
      severity: 'warning',
      readyForReviewActions: false,
      blockingReason: 'Generate PRD test cases before submitting for review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures,
    };
  }

  if (testCase.status === 'generating') {
    return {
      state: 'test_cases_generating',
      label: 'Generating test cases',
      description: 'The PRD is viewable while QA test cases are generated.',
      severity: 'info',
      readyForReviewActions: false,
      blockingReason: 'Test-case generation must finish before review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures,
    };
  }

  if (testCase.status === 'failed' || coverageHasFailures(testCase.coverageSummary)) {
    const hasCoverageFailures = coverageHasFailures(testCase.coverageSummary);
    readyStage.status = 'blocked';
    readyStage.detail =
      testCase.status === 'failed'
        ? 'Regenerate test cases before review.'
        : 'Coverage gaps block review.';
    return {
      state: testCase.status === 'failed' ? 'test_case_generation_failed' : 'coverage_gaps',
      label: testCase.status === 'failed' ? 'Test-case generation failed' : 'Coverage gaps remain',
      description: testCase.status === 'failed'
        ? 'Test-case generation failed before validation could run.'
        : 'Test cases were generated, but coverage gaps must be resolved before review.',
      severity: 'error',
      readyForReviewActions: false,
      blockingReason: testCase.status === 'failed'
        ? 'Regenerate PRD test cases before review.'
        : 'Resolve coverage gaps before review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures:
        qaFailures.length > 0
          ? qaFailures
          : hasCoverageFailures
            ? ['Coverage gaps remain.']
            : ['Test-case generation did not complete.'],
    };
  }

  if (validation === 'validating') {
    return {
      state: 'test_cases_validating',
      label: 'Validating test cases',
      description: 'Test-case validation must complete before review.',
      severity: 'info',
      readyForReviewActions: false,
      blockingReason: 'Test-case validation must finish before review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures,
    };
  }

  if (validation === 'failed') {
    readyStage.status = 'blocked';
    readyStage.detail = prdSpecValidation === 'failed'
      ? 'PRD validation gaps block review.'
      : 'Validation failures block review.';
    return {
      state: 'validation_failed',
      label: prdSpecValidation === 'failed' ? 'PRD validation gaps' : 'Validation failed',
      description: prdSpecValidation === 'failed'
        ? 'Resolve PRD validation gaps before review.'
        : 'Resolve test-case validation failures before review.',
      severity: 'error',
      readyForReviewActions: false,
      blockingReason: prdSpecValidation === 'failed'
        ? 'Resolve PRD validation gaps before review.'
        : 'Resolve validation failures before review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures:
        qaFailures.length > 0
          ? qaFailures
          : prdSpecValidation === 'failed'
            ? ['PRD validation did not meet the ready threshold.']
            : ['Test-case validation failed.'],
    };
  }

  if (validation !== 'passed') {
    const validationUnavailable = validation === 'not_available';
    if (validationUnavailable) {
      // Validation hasn't been run yet (feature not yet configured/available).
      // Don't block review — surface as informational and let the user proceed.
      readyStage.label = 'Ready for review';
      readyStage.status = 'complete';
      return {
        state: 'validation_unavailable',
        label: 'Ready for review',
        description: 'Test cases generated. Validation is not configured — you can proceed to review.',
        severity: 'success',
        readyForReviewActions: true,
        stages: [prdStage, testCaseStage, validationStage, readyStage],
        qaFailures,
      };
    }
    return {
      state: 'validation_pending',
      label: 'Validation pending',
      description: 'Test cases are generated, but validation must complete before review.',
      severity: 'warning',
      readyForReviewActions: false,
      blockingReason: 'Validate generated test cases before review.',
      stages: [prdStage, testCaseStage, validationStage, readyStage],
      qaFailures,
    };
  }

  readyStage.label = 'Ready for review';
  readyStage.status = 'complete';
  return {
    state: 'ready_for_review',
    label: 'Ready for review',
    description: 'PRD generation, test-case generation, and validation are complete.',
    severity: 'success',
    readyForReviewActions: true,
    stages: [prdStage, testCaseStage, validationStage, readyStage],
    qaFailures,
  };
}
