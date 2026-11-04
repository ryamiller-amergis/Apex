import { describe, expect, it } from '@jest/globals';
import type { BuildVisualBrief } from '../../shared/buildVisualBrief';
import type { EvidenceBlock } from '../services/builds/evidenceBlockParser';
import { evaluateVisualQualityFromEvidence } from '../services/buildVisualVerificationService';

const brief: BuildVisualBrief = {
  version: 1,
  buildRunId: 'run-1',
  taskDomain: 'ui',
  appName: 'Contoso',
  visualTone: 'professional',
  density: 'comfortable',
  componentStrategy: 'catalog-first',
  responsiveTargets: ['375px', '1280px'],
  screenshotExpectations: ['light', 'dark'],
  preferredPatterns: ['PageHeader'],
  avoidedPatterns: [],
  reuseSearches: ['calendar'],
};

function minimalBlock(overrides: Partial<EvidenceBlock> = {}): EvidenceBlock {
  return {
    version: 1,
    taskKey: 'build-feature',
    attemptNumber: 1,
    entries: [
      {
        requirementId: 'AC-1',
        tier: 'integration',
        testReferences: [{ file: 'apps/web/e2e/home.spec.ts', name: 'home visual snapshot light' }],
        red: null,
        green: {
          commit: 'abc',
          command: 'vitest',
          exitCode: 0,
          passedTests: ['home visual snapshot light'],
          output: 'ok',
        },
        deferral: null,
      },
    ],
    checks: { typeCheck: null, lint: null, relatedTests: null },
    standardsReview: { completed: true, findings: [] },
    visualReview: {
      completed: true,
      findings: [],
      screenshotPaths: ['apps/web/e2e/__screenshots__/home.png'],
      componentReuseRationale: 'Used PageHeader from @project-scope/ui.',
    },
    escalation: null,
    ...overrides,
  };
}

describe('evaluateVisualQualityFromEvidence', () => {
  it('passes when no visual brief is attached', () => {
    expect(
      evaluateVisualQualityFromEvidence({ visualBrief: null, block: minimalBlock() }).passed,
    ).toBe(true);
  });

  it('fails when visual review is incomplete', () => {
    const result = evaluateVisualQualityFromEvidence({
      visualBrief: brief,
      block: minimalBlock({
        visualReview: {
          completed: false,
          findings: [],
          screenshotPaths: [],
          componentReuseRationale: null,
        },
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => /self-review/i.test(f))).toBe(true);
  });

  it('fails when reuse rationale is missing', () => {
    const result = evaluateVisualQualityFromEvidence({
      visualBrief: brief,
      block: minimalBlock({
        visualReview: {
          completed: true,
          findings: [],
          screenshotPaths: ['x.png'],
          componentReuseRationale: '   ',
        },
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.findings.some((f) => /catalog components/i.test(f))).toBe(true);
  });
});
