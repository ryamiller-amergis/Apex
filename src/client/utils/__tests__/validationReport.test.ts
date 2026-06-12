import { buildPassingValidationReasonsMarkdown } from '../../../shared/utils/validationReport';
import type { ValidationScorecard } from '../../../shared/types/interview';

function makeScorecard(overrides: Partial<ValidationScorecard> = {}): ValidationScorecard {
  return {
    slug: 'feature-prd',
    generated_at: '2026-01-01T00:00:00Z',
    review_phase: 'final',
    overall_score: 94,
    ready_threshold: 90,
    is_ready: true,
    verdict: 'ready',
    files: [],
    features: [],
    cross_cutting_checks: {},
    accepted_gaps: [],
    deferred_gaps: [],
    ...overrides,
  };
}

describe('buildPassingValidationReasonsMarkdown', () => {
  it('builds passing reasons from explicit scorecard, file, feature, and cross-cutting evidence', () => {
    const markdown = buildPassingValidationReasonsMarkdown(
      makeScorecard({
        passing_reasons: ['All required artifacts are present.'],
        files: [
          {
            file: 'prd',
            score: 95,
            verdict: 'ready',
            passing_evidence: ['Acceptance criteria are measurable.'],
            gaps: [
              {
                id: 'gap-1',
                file: 'prd',
                section: 'Scope',
                score: 3,
                description: 'Out-of-scope work is explicit.',
                what_3_looks_like: 'Scope boundaries are clear.',
                resolution: 'filled',
              },
            ],
          } as any,
        ],
        features: [
          {
            feature_slug: 'slider',
            feature_title: 'Slider Defaults',
            design_score: 3,
            tech_spec_score: 3,
            assumptions_score: 3,
            overall_score: 92,
            verdict: 'ready',
            strengths: ['Behavior matches backlog defaults.'],
            gaps: [],
          } as any,
        ],
        cross_cutting_checks: {
          accessibility: 'No accessibility blockers remain.',
        },
      } as any),
    );

    expect(markdown).toContain('## Passing Validation Reasons');
    expect(markdown).toContain('- All required artifacts are present.');
    expect(markdown).toContain('**PRD Content** passed at 95%: Acceptance criteria are measurable.');
    expect(markdown).toContain('**PRD Content** resolved: Out-of-scope work is explicit.');
    expect(markdown).toContain('**Slider Defaults** passed at 92%: Behavior matches backlog defaults.');
    expect(markdown).toContain('**Accessibility**: No accessibility blockers remain.');
  });

  it('returns an empty string when there is no positive evidence to report', () => {
    const markdown = buildPassingValidationReasonsMarkdown(
      makeScorecard({
        overall_score: 72,
        is_ready: false,
        verdict: 'gaps',
        files: [
          {
            file: 'prd',
            score: 72,
            verdict: 'gaps',
            gaps: [],
          },
        ],
        cross_cutting_checks: {
          consistency: 'Missing acceptance criteria create gaps.',
        },
      }),
    );

    expect(markdown).toBe('');
  });
});
