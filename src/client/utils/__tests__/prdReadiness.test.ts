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

  it('does not block review for informational caveats when AC/BR coverage is complete', () => {
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
    );

    expect(readiness.state).toBe('validation_unavailable');
    expect(readiness.readyForReviewActions).toBe(true);
  });

  it('allows review when validation is not available but coverage is complete', () => {
    const readiness = derivePrdReadiness(
      generatedPrd,
      makeTestCase({
        validationStatus: 'not_available',
        validationSummary: { status: 'not_available' },
      }),
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
    expect(getStage(readiness, 'ready')).toEqual(
      expect.objectContaining({
        label: 'Ready for review',
        status: 'complete',
      }),
    );
  });

  it('marks ready for review when generation, coverage, and validation all pass', () => {
    const readiness = derivePrdReadiness(generatedPrd, makeTestCase());

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
});
