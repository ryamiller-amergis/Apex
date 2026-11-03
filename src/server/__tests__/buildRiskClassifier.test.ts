/**
 * TBI-011 — risk rating and classification module (VT-01 to VT-06).
 */
import type { BuildRequirementInput, RiskCandidate } from '../../shared/types/build';
import {
  analyzeBuildBrief,
  BuildBriefAnalysisError,
  REVERSIBLE_OPTIONS,
} from '../services/buildRiskClassifier';

const DESTRUCTIVE_PHRASES = [/\bdrop\b/i, /\bdelete\b/i, /\btruncate\b/i, /\boverwrite\b/i, /\bremove (the )?column/i, /\bpurge\b/i];

function candidate(overrides: Partial<RiskCandidate> = {}): RiskCandidate {
  return {
    category: 'access',
    rating: 'medium',
    decision: 'Add a builds:export permission',
    rationale: 'Exports need their own gate',
    destructive: false,
    ...overrides,
  };
}

const rows: BuildRequirementInput[] = [
  { id: null, kind: 'ac', text: 'Users can export a build' },
  { id: null, kind: 'ac', text: 'Export shows a progress label' },
  { id: null, kind: 'dod', text: 'Export has unit tests' },
  { id: null, kind: 'br', text: 'Only project members can export' },
  { id: null, kind: 'nfr', text: 'Export finishes in 5 seconds' },
];

function analyze(overrides: Partial<Parameters<typeof analyzeBuildBrief>[0]> = {}) {
  return analyzeBuildBrief({
    requirements: rows,
    riskCandidates: [],
    estimatedTasks: 2,
    needsMigration: false,
    ...overrides,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('VT-01 — a destructive candidate is raised to high (TBI-011 DoD-0; PBI-013 AC-3)', () => {
  it('VT-01 raises a low destructive data candidate and swaps in the reversible option', () => {
    const result = analyze({
      riskCandidates: [candidate({ category: 'data', rating: 'low', decision: 'Drop the legacy column', destructive: true })],
    });
    const [decision] = result.riskDecisions;
    expect(decision.rating).toBe('high');
    expect(decision.decision).toBe(REVERSIBLE_OPTIONS.data);
    expect(decision.reversible).toBe(true);
    expect(decision.rationale).toContain('Agent proposed: Drop the legacy column');
  });

  it('VT-01 never lowers a rating', () => {
    const result = analyze({ riskCandidates: [candidate({ rating: 'high' })] });
    expect(result.riskDecisions[0].rating).toBe('high');
  });

  it('VT-01 keeps low and medium decisions as the agent wrote them (TBI-011 DoD-3 each rating)', () => {
    const result = analyze({
      riskCandidates: [candidate({ rating: 'low' }), candidate({ rating: 'medium', category: 'integration' })],
    });
    expect(result.riskDecisions.map((d) => [d.id, d.rating, d.decision, d.reversible])).toEqual([
      ['RD-1', 'low', 'Add a builds:export permission', false],
      ['RD-2', 'medium', 'Add a builds:export permission', false],
    ]);
  });
});

describe('VT-02 — every high rating maps to its fixed reversible option (TBI-011 DoD-0)', () => {
  it.each(['data', 'access', 'integration', 'destructive'] as const)('VT-02 %s', (category) => {
    const result = analyze({
      riskCandidates: [candidate({ category, rating: 'high', decision: 'Drop and delete the old table' })],
    });
    const [decision] = result.riskDecisions;
    expect(decision.decision).toBe(REVERSIBLE_OPTIONS[category]);
    for (const phrase of DESTRUCTIVE_PHRASES) {
      expect(decision.decision).not.toMatch(phrase);
    }
  });

  it('VT-02 reversible texts name an additive migration, no-one permission, flagged integration, no destructive operation', () => {
    expect(REVERSIBLE_OPTIONS.data).toMatch(/additive|expand-then-contract/i);
    expect(REVERSIBLE_OPTIONS.access).toMatch(/no role/i);
    expect(REVERSIBLE_OPTIONS.integration).toMatch(/feature flag.*off by default/i);
    expect(REVERSIBLE_OPTIONS.destructive).toMatch(/no destructive data operation/i);
  });
});

describe('VT-03 — requirement IDs are stable (TBI-011 DoD-2; PBI-011 AC-2)', () => {
  it('VT-03 numbers rows per kind in input order', () => {
    expect(analyze().requirements.map((r) => r.id)).toEqual(['AC-1', 'AC-2', 'DOD-1', 'BR-1', 'NFR-1']);
  });

  it('VT-03 gives the same IDs for the same input', () => {
    expect(analyze()).toEqual(analyze());
  });

  it('VT-03 keeps an edited row ID, gives an added row the next number and never reuses a removed number', () => {
    const first = analyze();
    const edited: BuildRequirementInput[] = first.requirements
      .filter((row) => row.id !== 'AC-2')
      .map((row) => ({ id: row.id, kind: row.kind, text: row.id === 'AC-1' ? 'Users can export any build' : row.text }));
    edited.push({ id: null, kind: 'ac', text: 'Export names the file' });

    const second = analyzeBuildBrief({
      requirements: edited,
      estimatedTasks: 2,
      needsMigration: false,
      previous: first,
    });

    expect(second.requirements.find((row) => row.id === 'AC-1')?.text).toBe('Users can export any build');
    expect(second.requirements.map((row) => row.id)).toEqual(['AC-1', 'DOD-1', 'BR-1', 'NFR-1', 'AC-3']);
    expect(second.counters.AC).toBe(3);
  });

  it('VT-03 keeps stored decisions when no new candidates are passed', () => {
    const first = analyze({ riskCandidates: [candidate({ rating: 'high' })] });
    const second = analyzeBuildBrief({
      requirements: first.requirements.map(({ id, kind, text }) => ({ id, kind, text })),
      estimatedTasks: 2,
      needsMigration: false,
      previous: first,
    });
    expect(second.riskDecisions).toEqual(first.riskDecisions);
  });

  it('VT-03 refuses an ID the previous analysis never issued', () => {
    const first = analyze();
    expect(() => analyzeBuildBrief({
      requirements: [{ id: 'AC-9', kind: 'ac', text: 'Forged' }],
      estimatedTasks: 2,
      needsMigration: false,
      previous: first,
    })).toThrow(BuildBriefAnalysisError);
  });
});

describe('VT-04 — classification (TBI-011 DoD-1, DoD-3)', () => {
  it.each([
    [{ estimatedTasks: 1 }, 'small', 'estimated 1 task'],
    [{ estimatedTasks: 2 }, 'small', 'estimated 2 tasks'],
    [{ estimatedTasks: 3 }, 'full', 'estimated 3 tasks'],
    [{ estimatedTasks: 2, riskCandidates: [candidate({ rating: 'high' })] }, 'full', 'high-risk decision RD-1'],
    [{ estimatedTasks: 2, needsMigration: true }, 'full', 'migration needed'],
    [{ estimatedTasks: null }, 'full', 'task estimate missing'],
    [{ estimatedTasks: 0 }, 'full', 'task estimate missing'],
  ] as const)('VT-04 %j → %s', (overrides, value, reason) => {
    const result = analyze(overrides as Partial<Parameters<typeof analyzeBuildBrief>[0]>);
    expect(result.classification.value).toBe(value);
    expect(result.classification.reasons).toContain(reason);
  });
});

describe('VT-05 — invalid input throws with every problem (TBI-011)', () => {
  it('VT-05 lists each problem and returns no partial result', () => {
    let caught: unknown;
    try {
      analyze({
        requirements: [
          { id: null, kind: 'ac', text: 'One' },
          { id: 'AC-1', kind: 'ac', text: 'Two' },
          { id: 'AC-1', kind: 'ac', text: 'Three' },
        ],
        riskCandidates: [
          candidate({ category: 'billing' as never }),
          candidate({ rationale: '' }),
          candidate({ rating: 'critical' as never }),
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BuildBriefAnalysisError);
    const problems = (caught as BuildBriefAnalysisError).problems.join('\n');
    expect(problems).toMatch(/category/);
    expect(problems).toMatch(/rationale/);
    expect(problems).toMatch(/rating/);
    expect(problems).toMatch(/duplicate/i);
  });

  it('VT-05 refuses empty and over-long requirement text', () => {
    expect(() => analyze({ requirements: [{ id: null, kind: 'ac', text: '  ' }] })).toThrow(BuildBriefAnalysisError);
    expect(() => analyze({ requirements: [{ id: null, kind: 'ac', text: 'x'.repeat(1001) }] })).toThrow(BuildBriefAnalysisError);
  });
});

describe('VT-06 — the module is pure (TBI-011 NFR)', () => {
  it('VT-06 does not mutate frozen input and gives equal output twice', () => {
    const input = deepFreeze({
      requirements: rows.map((row) => ({ ...row })),
      riskCandidates: [candidate({ rating: 'high' }), candidate({ destructive: true })],
      estimatedTasks: 2,
      needsMigration: false,
    });
    const first = analyzeBuildBrief(input);
    const second = analyzeBuildBrief(input);
    expect(first).toEqual(second);
  });
});
