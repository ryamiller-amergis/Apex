import {
  buildPassingValidationReasonsMarkdown,
  collectValidationGaps,
  designDocFeatureSectionScore,
  normalizeCrossCuttingCheck,
  normalizeValidationGap,
  normalizeValidationScorecard,
  resolveScorecardOverallScore,
} from '../../../shared/utils/validationReport';
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

  it('does not throw when cross-cutting checks are foundation-skill objects', () => {
    const markdown = buildPassingValidationReasonsMarkdown(
      makeScorecard({
        cross_cutting_checks: {
          template_tokens: {
            label: 'Template token scan',
            status: 'pass',
            detail: 'None found',
          },
          tbd_markers: {
            label: '[TBD] scan',
            status: 'fail',
            detail: '3 TBD markers remain',
          },
        },
      }),
    );

    expect(markdown).toContain('## Passing Validation Reasons');
    expect(markdown).toContain('**Template token scan**: pass — None found');
    expect(markdown).not.toContain('3 TBD markers remain');
  });
});

describe('collectValidationGaps', () => {
  it('reads nested feature gaps (canonical design-doc shape)', () => {
    const gaps = collectValidationGaps(
      makeScorecard({
        features: [
          {
            feature_slug: 'counter',
            feature_title: 'Counter',
            design_score: 90,
            tech_spec_score: 90,
            assumptions_score: 90,
            overall_score: 90,
            verdict: 'ready',
            gaps: [
              {
                id: 'g1',
                file: 'design',
                section: 'UI/UX',
                score: 2,
                description: 'Missing empty state',
                what_3_looks_like: 'Empty state described',
                resolution: 'pending',
              },
            ],
          },
        ],
      }),
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0].id).toBe('g1');
    expect(gaps[0].description).toBe('Missing empty state');
  });

  it('does not throw when features omit gaps (alternate scorecard crash case)', () => {
    const gaps = collectValidationGaps(
      makeScorecard({
        features: [
          {
            feature_slug: 'counter',
            feature_title: 'Counter',
            design_score: 90,
            tech_spec_score: 90,
            assumptions_score: 90,
            overall_score: 93,
            verdict: 'ready',
            // gaps intentionally omitted — previously crashed UI with "d.gaps is not iterable"
          } as any,
        ],
        gaps: [
          {
            id: 'pending-tech-tbd',
            file: 'tech-spec',
            section: 'No residual template tokens',
            score: 1,
            description: '',
            what_3_looks_like: '',
            resolution: 'pending',
          },
        ],
      }),
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0].id).toBe('pending-tech-tbd');
    expect(gaps[0].file).toBe('tech-spec');
  });

  it('normalizes top-level design-spec-review gaps (detail + file_type)', () => {
    const gaps = collectValidationGaps(
      makeScorecard({
        features: [
          {
            name: 'View Pending Timecards',
            design: { score_pct: 96 },
            tech_spec: { score_pct: 91 },
            assumptions: { score_pct: 94 },
          } as any,
        ],
        gaps: [
          {
            id: 'tbd-gap',
            score: 1,
            detail: '1 TBD match found in Data and Contracts',
            feature: 'View Pending Timecards',
            section: 'No residual template tokens',
            file_type: 'tech-spec',
            resolution: 'pending',
            target_score: 3,
          } as any,
        ],
      }),
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        id: 'tbd-gap',
        file: 'tech-spec',
        description: '1 TBD match found in Data and Contracts',
        resolution: 'pending',
      }),
    ]);
  });

  it('prefers nested feature gaps over root gaps when both exist', () => {
    const gaps = collectValidationGaps(
      makeScorecard({
        features: [
          {
            feature_slug: 'a',
            feature_title: 'A',
            design_score: 90,
            tech_spec_score: 90,
            assumptions_score: 90,
            overall_score: 90,
            verdict: 'ready',
            gaps: [
              {
                id: 'nested',
                file: 'design',
                section: 'Scope',
                score: 2,
                description: 'Nested gap',
                what_3_looks_like: '',
                resolution: 'pending',
              },
            ],
          },
        ],
        gaps: [
          {
            id: 'root',
            file: 'design',
            section: 'Scope',
            score: 1,
            description: 'Root gap',
            what_3_looks_like: '',
            resolution: 'pending',
          },
        ],
      }),
    );

    expect(gaps.map((g) => g.id)).toEqual(['nested']);
  });

  it('returns empty for null/undefined scorecards', () => {
    expect(collectValidationGaps(null)).toEqual([]);
    expect(collectValidationGaps(undefined)).toEqual([]);
  });
});

describe('normalizeValidationGap', () => {
  it('returns null for invalid input', () => {
    expect(normalizeValidationGap(null)).toBeNull();
    expect(normalizeValidationGap({})).toBeNull();
    expect(normalizeValidationGap({ id: '' })).toBeNull();
  });
});

describe('normalizeCrossCuttingCheck', () => {
  it('keeps the string scorecard shape', () => {
    expect(normalizeCrossCuttingCheck('template_tokens', 'PASS')).toEqual({
      key: 'template_tokens',
      label: 'Template Tokens',
      status: 'pass',
      detail: '',
      displayText: 'PASS',
    });
  });

  it('reads the foundation-skill object shape', () => {
    expect(
      normalizeCrossCuttingCheck('tbd_markers', {
        label: '[TBD] / TODO / FIXME scan',
        status: 'pass',
        detail: 'None found',
      }),
    ).toEqual({
      key: 'tbd_markers',
      label: '[TBD] / TODO / FIXME scan',
      status: 'pass',
      detail: 'None found',
      displayText: 'pass — None found',
    });
  });

  it('does not throw for non-string values', () => {
    expect(normalizeCrossCuttingCheck('ok', true).displayText).toBe('true');
    expect(normalizeCrossCuttingCheck('count', 2).displayText).toBe('2');
    expect(normalizeCrossCuttingCheck('empty', null).displayText).toBe('');
  });
});

describe('designDocFeatureSectionScore', () => {
  it('reads canonical design_score fields', () => {
    expect(
      designDocFeatureSectionScore(
        {
          design_score: 88,
          tech_spec_score: 91,
          assumptions_score: 94,
        },
        'tech_spec_score',
      ),
    ).toBe(91);
  });

  it('reads alternate nested score_pct fields', () => {
    expect(
      designDocFeatureSectionScore(
        {
          design: { score_pct: 96.4 },
          tech_spec: { score_pct: 91.2 },
          assumptions: { score_pct: 94 },
        },
        'design_score',
      ),
    ).toBe(96);
  });
});

describe('resolveScorecardOverallScore', () => {
  it('prefers the canonical top-level overall_score', () => {
    expect(resolveScorecardOverallScore({ overall_score: 94, scores: { overall: 12 } })).toBe(94);
  });

  it('falls back to scores.overall when overall_score is absent', () => {
    expect(
      resolveScorecardOverallScore({
        scores: { prd: { percentage: 97.33 }, backlog: { percentage: 95 }, overall: 96.17 },
      }),
    ).toBeCloseTo(96.17);
  });

  it('averages per-file percentages when no overall is reported', () => {
    expect(
      resolveScorecardOverallScore({
        scores: { prd: { percentage: 90 }, backlog: { percentage: 80 } },
      }),
    ).toBe(85);
  });

  it('returns null when no finite score is present', () => {
    expect(resolveScorecardOverallScore({ verdict: 'ready' })).toBeNull();
    expect(resolveScorecardOverallScore({ overall_score: 'n/a' })).toBeNull();
    expect(resolveScorecardOverallScore({ scores: { overall: null } })).toBeNull();
    expect(resolveScorecardOverallScore(null)).toBeNull();
  });
});

describe('normalizeValidationScorecard', () => {
  it('stamps a canonical overall_score onto the nested prd-spec-review shape', () => {
    const normalized = normalizeValidationScorecard({
      review_phase: 'initial',
      is_ready: true,
      verdict: 'Ready',
      scores: { prd: { percentage: 97.33 }, backlog: { percentage: 95 }, overall: 96.17 },
    });

    expect(normalized?.overall_score).toBeCloseTo(96.17);
    expect(Math.round(normalized!.overall_score)).toBe(96);
    expect(normalized?.is_ready).toBe(true);
  });

  it('rejects a scorecard with no usable score rather than yielding NaN', () => {
    const normalized = normalizeValidationScorecard({ review_phase: 'initial', is_ready: true });

    expect(normalized).toBeNull();
  });
});
