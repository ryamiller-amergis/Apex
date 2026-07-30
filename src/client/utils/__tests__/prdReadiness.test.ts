import type { TestCaseSummary } from '../../../shared/types/interview';
import { derivePrdReadiness, type PrdReadiness } from '../../../shared/utils/prdReadiness';

const generatedPrd = { status: 'draft' as const, content: '# Generated PRD' };

function makeTestCase(overrides: Partial<TestCaseSummary> = {}): TestCaseSummary {
  return {
    id: 'tc-1',
    prdId: 'prd-1',
    chatThreadId: null,
    status: 'ready',
    coverageSummary: {
      totalCases: 10,
      pbisCovered: 1,
      acCovered: '4/4',
      brCovered: '4/4',
      gaps: 0,
    },
    validationStatus: 'passed',
    validationSummary: { status: 'passed' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function getStage(readiness: PrdReadiness, id: PrdReadiness['stages'][number]['id']) {
  const stage = readiness.stages.find((item) => item.id === id);
  if (!stage) throw new Error(`Missing readiness stage: ${id}`);
  return stage;
}

describe('derivePrdReadiness', () => {
  it('blocks review when acceptance criteria are not fully covered', () => {
    const readiness = derivePrdReadiness(
      generatedPrd,
      makeTestCase({
        coverageSummary: {
          totalCases: 10,
          pbisCovered: 1,
          acCovered: '3/4',
          brCovered: '4/4',
          gaps: 0,
        },
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      { prdValidationEnabled: true },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'coverage_gaps',
        label: 'Coverage gaps remain',
        readyForReviewActions: false,
        blockingReason: 'Resolve coverage gaps before review.',
      }),
    );
    expect(readiness.qaFailures).toContain('Acceptance criteria not fully covered: 3/4.');
    expect(getStage(readiness, 'test_cases')).toEqual(
      expect.objectContaining({
        label: 'Coverage gaps remain',
        status: 'blocked',
      }),
    );
    expect(getStage(readiness, 'ready')).toEqual(
      expect.objectContaining({
        label: 'Review locked',
        status: 'blocked',
      }),
    );
  });

  it('blocks review when validation is configured but has not run yet', () => {
    const readiness = derivePrdReadiness(
      generatedPrd,
      makeTestCase({
        coverageSummary: {
          totalCases: 10,
          pbisCovered: 1,
          acCovered: '4/4',
          brCovered: '4/4',
          gaps: 3,
        },
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      { prdValidationEnabled: true },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_pending',
        label: 'Validation pending',
        readyForReviewActions: false,
        blockingReason: 'Run PRD validation before review.',
      }),
    );
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({
        label: 'Validation pending',
        status: 'current',
        detail: 'Run PRD validation before review.',
      }),
    );
    expect(getStage(readiness, 'ready')).toEqual(
      expect.objectContaining({
        label: 'Review locked',
        status: 'pending',
      }),
    );
  });

  it('allows review when validation is not configured and coverage is complete', () => {
    const readiness = derivePrdReadiness(
      generatedPrd,
      makeTestCase({
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      { prdValidationEnabled: false },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_unavailable',
        label: 'Ready for review',
        readyForReviewActions: true,
      }),
    );
    expect(getStage(readiness, 'test_cases')).toEqual(
      expect.objectContaining({
        status: 'complete',
        detail: '10 cases, 4/4 AC, 4/4 BR',
      }),
    );
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({
        label: 'Validation not configured',
        status: 'complete',
      }),
    );
    expect(getStage(readiness, 'ready')).toEqual(
      expect.objectContaining({
        label: 'Ready for review',
        status: 'complete',
      }),
    );
  });

  it('marks ready for review when generation, coverage, and validation all pass', () => {
    const readiness = derivePrdReadiness(generatedPrd, makeTestCase(), undefined, {
      prdValidationEnabled: true,
    });

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'ready_for_review',
        label: 'Ready for review',
        readyForReviewActions: true,
      }),
    );
    expect(readiness.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'prd', status: 'complete' }),
        expect.objectContaining({ id: 'test_cases', status: 'complete' }),
        expect.objectContaining({ id: 'validation', status: 'complete' }),
        expect.objectContaining({
          id: 'ready',
          label: 'Ready for review',
          status: 'complete',
        }),
      ]),
    );
  });

  it('marks ready when PRD spec validation passed even if test-case validation is unavailable', () => {
    const readiness = derivePrdReadiness(
      {
        ...generatedPrd,
        validationScore: 92,
        validationScorecard: {
          is_ready: true,
          overall_score: 92,
          ready_threshold: 90,
        },
      },
      makeTestCase({
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      { prdValidationEnabled: true },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'ready_for_review',
        label: 'Ready for review',
        readyForReviewActions: true,
      }),
    );
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({
        label: 'PRD validation passed',
        status: 'complete',
      }),
    );
  });

  it('blocks review when PRD spec validation completed below threshold', () => {
    const readiness = derivePrdReadiness(
      {
        ...generatedPrd,
        validationScore: 84,
        validationScorecard: {
          is_ready: false,
          overall_score: 84,
          ready_threshold: 90,
        },
      },
      makeTestCase({
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      { prdValidationEnabled: true },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_failed',
        label: 'PRD validation gaps',
        readyForReviewActions: false,
        blockingReason: 'Resolve PRD validation gaps before review.',
      }),
    );
    expect(readiness.qaFailures).toContain('PRD validation score is 84%.');
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({
        label: 'PRD validation gaps',
        status: 'blocked',
        detail: 'PRD validation needs 90% to pass.',
      }),
    );
  });

  it('shows validating readiness while status is validating even with a stale failed scorecard', () => {
    const readiness = derivePrdReadiness(
      {
        status: 'validating',
        content: '# Generated PRD',
        validationScore: 69,
        validationScorecard: {
          is_ready: false,
          overall_score: 69,
          ready_threshold: 90,
        },
      },
      makeTestCase({
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      { prdValidationEnabled: true },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'prd_validating',
        label: 'Validating PRD',
        severity: 'info',
        readyForReviewActions: false,
        blockingReason: 'PRD validation must finish before review.',
      }),
    );
    expect(readiness.qaFailures).toEqual([]);
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({
        label: 'Validating PRD',
        status: 'current',
        detail: 'PRD validation is running.',
      }),
    );
  });

  it('distinguishes validation failures from generation and coverage failures', () => {
    const readiness = derivePrdReadiness(
      generatedPrd,
      makeTestCase({
        validationStatus: 'failed',
        validationSummary: {
          status: 'failed',
          failures: ['A generated test case has no expected result.'],
        },
      }),
      undefined,
      { prdValidationEnabled: true },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_failed',
        label: 'Validation failed',
        readyForReviewActions: false,
        blockingReason: 'Resolve validation failures before review.',
      }),
    );
    expect(readiness.qaFailures).toContain(
      'A generated test case has no expected result.',
    );
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({ label: 'Validation failed', status: 'blocked' }),
    );
  });

  it('does not block on missing test cases when testCasesRequired is false and validation is not configured', () => {
    const readiness = derivePrdReadiness(generatedPrd, null, undefined, {
      testCasesRequired: false,
      prdValidationEnabled: false,
    });

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_unavailable',
        readyForReviewActions: true,
      }),
    );
    expect(getStage(readiness, 'test_cases')).toEqual(
      expect.objectContaining({
        label: 'Test cases not required',
        status: 'complete',
      }),
    );
  });

  it('blocks review when test cases are not required but PRD validation is configured and has not run', () => {
    const readiness = derivePrdReadiness(generatedPrd, null, undefined, {
      testCasesRequired: false,
      prdValidationEnabled: true,
    });

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_pending',
        label: 'Validation pending',
        readyForReviewActions: false,
        blockingReason: 'Run PRD validation before review.',
      }),
    );
    expect(getStage(readiness, 'validation')).toEqual(
      expect.objectContaining({
        label: 'Validation pending',
        status: 'current',
        detail: 'Run PRD validation before review.',
      }),
    );
  });

  it('allows review when coverage_gaps is overridden', () => {
    const readiness = derivePrdReadiness(
      generatedPrd,
      makeTestCase({
        coverageSummary: {
          totalCases: 10,
          pbisCovered: 1,
          acCovered: '3/4',
          brCovered: '4/4',
          gaps: 0,
        },
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
      undefined,
      {
        prdValidationEnabled: true,
        overriddenStates: ['coverage_gaps'],
      },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'coverage_gaps',
        label: 'Proceeding with unresolved gaps',
        severity: 'warning',
        readyForReviewActions: true,
        overridden: true,
      }),
    );
    expect(readiness.blockingReason).toBeUndefined();
  });

  it('allows review when validation_failed is overridden', () => {
    const readiness = derivePrdReadiness(
      {
        ...generatedPrd,
        validationScore: 70,
        validationScorecard: { is_ready: false, overall_score: 70, ready_threshold: 90 },
      },
      makeTestCase(),
      90,
      {
        prdValidationEnabled: true,
        overriddenStates: ['validation_failed'],
      },
    );

    expect(readiness).toEqual(
      expect.objectContaining({
        state: 'validation_failed',
        label: 'Proceeding with unresolved gaps',
        severity: 'warning',
        readyForReviewActions: true,
        overridden: true,
      }),
    );
  });
});
