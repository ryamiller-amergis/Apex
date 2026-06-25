jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      chatThreads: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  readOutputValidationScorecard: jest.fn(),
  readOutputValidationScorecardMd: jest.fn(),
  isThreadIdle: jest.fn(),
  createThread: jest.fn(),
  cancelRun: jest.fn(),
  sendMessage: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn();
  return {
    getSkillConfig,
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string }) => getSkillConfig(opts.project)),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
  };
});

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

import { generateFallbackReport } from '../services/documentValidationService';
import type { ValidationScorecard } from '../../shared/types/interview';

function makeScorecard(overrides: Partial<ValidationScorecard> = {}): ValidationScorecard {
  return {
    slug: 'feature-prd',
    generated_at: '2026-01-01T00:00:00Z',
    review_phase: 'final',
    overall_score: 91,
    ready_threshold: 90,
    is_ready: true,
    verdict: 'ready',
    features: [],
    files: [],
    cross_cutting_checks: {},
    accepted_gaps: [],
    deferred_gaps: [],
    ...overrides,
  };
}

describe('generateFallbackReport', () => {
  it('renders scorecard metadata, passing reasons, feature scores, and gap sections', () => {
    const report = generateFallbackReport(
      makeScorecard({
        passing_reasons: ['All required evidence is present.'],
        features: [
          {
            feature_slug: 'slider',
            feature_title: 'Slider Defaults',
            design_score: 90,
            tech_spec_score: 92,
            assumptions_score: 91,
            overall_score: 91,
            verdict: 'ready',
            gaps: [
              {
                id: 'gap-1',
                file: 'design',
                section: 'Assumptions',
                score: 2,
                description: 'Clarify launch assumptions.',
                what_3_looks_like: 'Launch assumptions are explicit.',
                resolution: 'pending',
              },
            ],
          },
        ],
        cross_cutting_checks: {
          traceability: 'No traceability blockers remain.',
        },
        accepted_gaps: ['Manual QA will cover legacy browser behavior.'],
        deferred_gaps: ['Analytics refinement deferred to phase 2.'],
      } as any),
    );

    expect(report).toContain('# Validation Report');
    expect(report).toContain('| Overall Score | **91%** |');
    expect(report).toContain('## Passing Validation Reasons');
    expect(report).toContain('- All required evidence is present.');
    expect(report).toContain('| Slider Defaults | 90% | 92% | 91% | 91% | ready |');
    expect(report).toContain('- **Assumptions** (design): Clarify launch assumptions.');
    expect(report).toContain('- **traceability**: No traceability blockers remain.');
    expect(report).toContain('- Manual QA will cover legacy browser behavior.');
    expect(report).toContain('- Analytics refinement deferred to phase 2.');
  });

  it('handles PRD validation scorecards that provide files instead of features', () => {
    const report = generateFallbackReport(
      makeScorecard({
        features: undefined,
        files: [
          {
            file: 'prd',
            score: 93,
            verdict: 'ready',
            gaps: [],
          },
        ],
      }),
    );

    expect(report).toContain('# Validation Report');
    expect(report).toContain('**PRD Content** passed at 93%');
    expect(report).not.toContain('## Feature Scores');
  });
});
