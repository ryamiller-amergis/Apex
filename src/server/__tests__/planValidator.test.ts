/**
 * TBI-012 / PBI-014 / PBI-015 — plan validator.
 * VT-01 through VT-11, adapted to the shipped violation codes.
 */
import { validateBuildPlan } from '../services/buildPlanning/planValidator';
import type { BuildPlan } from '../../shared/buildPlanSchema';
import { invalidBuildPlans, validBuildPlans, validFullPlan, validSmallPlan } from '../../shared/fixtures/buildPlanFixtures';
import type { BuildRequirement, BuildRiskDecision } from '../../shared/types/build';

function requirement(id: string, retired = false): BuildRequirement {
  const kind = id.startsWith('DOD') ? 'dod' : id.startsWith('BR') ? 'br' : id.startsWith('NFR') ? 'nfr' : 'ac';
  return { id, kind, text: id, retired };
}

function risk(id: string): BuildRiskDecision {
  return { id, category: 'data', rating: 'low', decision: 'keep', rationale: 'audit' };
}

const fullRequirements = [requirement('AC-1'), requirement('AC-2'), requirement('DOD-1'), requirement('DOD-2')];
const fullRisks = [risk('RD-1')];

function codes(plan: unknown, requirements = fullRequirements, riskDecisions = fullRisks) {
  const result = validateBuildPlan({ plan, requirements, riskDecisions });
  return result.ok ? [] : result.violations.map((row) => row.code);
}

describe('plan validator', () => {
  it('VT-01 / DoD-3 accepts a chain when every requirement and risk decision has a test', () => {
    const result = validateBuildPlan({
      plan: validFullPlan,
      requirements: fullRequirements,
      riskDecisions: fullRisks,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a plan whose classification differs from the revision', () => {
    const result = validateBuildPlan({
      plan: validSmallPlan,
      requirements: [requirement('AC-1')],
      riskDecisions: [],
      classification: 'full',
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.violations).toEqual([
      expect.objectContaining({ code: 'invalid_value', path: 'classification' }),
    ]);
    expect(validateBuildPlan({
      plan: validSmallPlan,
      requirements: [requirement('AC-1')],
      riskDecisions: [],
      classification: 'small',
    }).ok).toBe(validateBuildPlan({ plan: validSmallPlan, requirements: [requirement('AC-1')], riskDecisions: [] }).ok);
  });

  it('VT-02 / DoD-3 accepts independent tasks with disjoint files', () => {
    const plan: BuildPlan = {
      classification: 'small',
      tasks: [0, 1, 2, 3].map((index) => ({
        key: `task-${index}`,
        role: 'implementer' as const,
        blockers: [],
        ownedFiles: [`src/task-${index}.ts`],
        reuse: [{ path: `src/shared/task-${index}.ts` }],
        runMode: 'own_agent' as const,
        covers: ['AC-1'],
      })),
      tests: [{ subjectId: 'AC-1', testRef: { path: 'src/task.test.ts', name: 'works' }, tier: 'unit' }],
      riskConstraints: [],
      contextNotesPath: 'docs/notes.md',
    };
    expect(validateBuildPlan({
      plan,
      requirements: [requirement('AC-1')],
      riskDecisions: [],
    })).toEqual({ ok: true });
  });

  it('VT-03 / DoD-0 names the cycle and ignores a task that only sits downstream', () => {
    const broken = {
      ...validSmallPlan,
      tasks: [
        { ...validSmallPlan.tasks[0], key: 't2', blockers: ['t3'], ownedFiles: ['src/t2.ts'], covers: ['AC-1'] },
        { ...validSmallPlan.tasks[0], key: 't3', blockers: ['t2'], ownedFiles: ['src/t3.ts'], covers: ['AC-1'] },
        { ...validSmallPlan.tasks[0], key: 't4', blockers: ['t3'], ownedFiles: ['src/t4.ts'], covers: ['AC-1'] },
      ],
    };
    const result = validateBuildPlan({ plan: broken, requirements: [requirement('AC-1')], riskDecisions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycle = result.violations.find((row) => row.code === 'cycle');
      expect(cycle?.taskKeys).toEqual(['t2', 't3']);
      expect(cycle?.taskKeys).not.toContain('t4');
    }
    expect(validateBuildPlan({
      plan: validSmallPlan,
      requirements: [requirement('AC-1')],
      riskDecisions: [],
    })).toEqual({ ok: true });
  });

  it('VT-04 / DoD-1 reports one overlapping file and the task keys', () => {
    const broken = {
      ...validSmallPlan,
      tasks: [
        validSmallPlan.tasks[0],
        {
          ...validSmallPlan.tasks[0],
          key: 'other',
          ownedFiles: ['./src/widget.ts'],
          covers: ['AC-1'],
        },
      ],
      tests: [
        ...validSmallPlan.tests,
        { subjectId: 'AC-1', testRef: { path: 'src/other.test.ts', name: 'other' }, tier: 'unit' as const },
      ],
    };
    const result = validateBuildPlan({ plan: broken, requirements: [requirement('AC-1')], riskDecisions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const file = result.violations.find((row) => row.code === 'overlapping_owned_file');
      expect(file?.path).toBe('src/widget.ts');
      expect(file?.taskKeys).toEqual(['implement-widget', 'other']);
    }
  });

  it('VT-05 / DoD-1 skips a retired requirement', () => {
    const result = validateBuildPlan({
      plan: validSmallPlan,
      requirements: [requirement('AC-1'), requirement('AC-2'), requirement('AC-3', true)],
      riskDecisions: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((row) => row.requirementId)).toEqual(['AC-2']);
      expect(result.violations.some((row) => row.requirementId === 'AC-3')).toBe(false);
    }
    const covered = {
      ...validSmallPlan,
      tests: [
        ...validSmallPlan.tests,
        { subjectId: 'AC-2', testRef: { path: 'src/ac2.test.ts', name: 'ac2' }, tier: 'unit' as const },
      ],
    };
    expect(validateBuildPlan({
      plan: covered,
      requirements: [requirement('AC-1'), requirement('AC-2'), requirement('AC-3', true)],
      riskDecisions: [],
    })).toEqual({ ok: true });
  });

  it('VT-06 reports an untested risk decision and an unknown one', () => {
    const missing = validateBuildPlan({
      plan: validSmallPlan,
      requirements: [requirement('AC-1')],
      riskDecisions: [risk('RD-1')],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'uncovered_risk_decision', riskDecisionId: 'RD-1' }),
      ]));
    }
    const unknown = {
      ...validSmallPlan,
      tests: [
        ...validSmallPlan.tests,
        { subjectId: 'RD-9', testRef: { path: 'src/rd.test.ts', name: 'rd' }, tier: 'unit' as const },
      ],
    };
    const named = validateBuildPlan({
      plan: unknown,
      requirements: [requirement('AC-1')],
      riskDecisions: [risk('RD-1')],
    });
    expect(named.ok).toBe(false);
    if (!named.ok) {
      expect(named.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_value', riskDecisionId: 'RD-9' }),
      ]));
    }
  });

  it('VT-07 / PBI-015 (c)(d) rejects empty reuse and accepts a justification', () => {
    const empty = {
      ...validSmallPlan,
      tasks: [{ ...validSmallPlan.tasks[0], reuse: [] }],
    };
    const rejected = validateBuildPlan({ plan: empty, requirements: [requirement('AC-1')], riskDecisions: [] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.violations).toEqual([
        expect.objectContaining({
          code: 'empty_reuse',
          taskKeys: ['implement-widget'],
        }),
      ]);
    }
    const justified = {
      ...validSmallPlan,
      tasks: [{
        ...validSmallPlan.tasks[0],
        reuse: [],
        reuseJustification: { searches: ['widget helper'], conclusion: 'Nothing reusable exists' },
      }],
    };
    expect(validateBuildPlan({
      plan: justified,
      requirements: [requirement('AC-1')],
      riskDecisions: [],
    })).toEqual({ ok: true });
  });

  it('VT-08 / DoD-2 returns the same codes when the tasks are shuffled', () => {
    const plan = {
      ...validSmallPlan,
      tasks: [
        { ...validSmallPlan.tasks[0], key: 'left', blockers: ['right'], ownedFiles: ['src/shared.ts'] },
        { ...validSmallPlan.tasks[0], key: 'right', blockers: ['left'], ownedFiles: ['src/shared.ts'] },
        { ...validSmallPlan.tasks[0], key: 'right', blockers: ['missing'], ownedFiles: ['src/other.ts'], covers: ['AC-1'] },
      ],
    };
    const first = validateBuildPlan({ plan, requirements: [requirement('AC-1')], riskDecisions: [] });
    const shuffled = {
      ...plan,
      tasks: [...plan.tasks].reverse(),
    };
    const second = validateBuildPlan({ plan: shuffled, requirements: [requirement('AC-1')], riskDecisions: [] });
    const third = validateBuildPlan({ plan, requirements: [requirement('AC-1')], riskDecisions: [] });
    expect(first).toEqual(second);
    expect(first).toEqual(third);
    expect(codes(plan, [requirement('AC-1')], [])).toEqual(
      expect.arrayContaining(['cycle', 'duplicate_task_key', 'unknown_blocker', 'overlapping_owned_file']),
    );
  });

  it('VT-09 validates a frozen 50-task plan within 200 ms', () => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({
      key: `task-${index}`,
      role: 'implementer' as const,
      blockers: index === 0 ? [] : [`task-${index - 1}`],
      ownedFiles: [`src/task-${index}.ts`],
      reuse: [{ path: 'src/shared/types/build.ts' }],
      runMode: 'own_agent' as const,
      covers: ['AC-1'],
    }));
    tasks.push(...Array.from({ length: 30 }, (_, index) => ({
      key: `extra-${index}`,
      role: 'implementer' as const,
      blockers: ['task-0'],
      ownedFiles: [`src/extra-${index}.ts`],
      reuse: [{ path: 'src/shared/types/build.ts' }],
      runMode: 'own_agent' as const,
      covers: ['AC-1'],
    })));
    const plan = {
      classification: 'small' as const,
      tasks,
      tests: [{ subjectId: 'AC-1', testRef: { path: 'src/task.test.ts', name: 'works' }, tier: 'unit' as const }],
      riskConstraints: [],
      contextNotesPath: 'docs/notes.md',
    };
    deepFreeze(plan);
    const started = Date.now();
    const result = validateBuildPlan({ plan, requirements: [requirement('AC-1')], riskDecisions: [] });
    expect(Date.now() - started).toBeLessThan(200);
    expect(result).toEqual({ ok: true });
  });

  it('VT-10 rejects scaffold, length, and omitted-shape problems without throwing', () => {
    expect(codes({ ...validSmallPlan, scaffoldManifest: validFullPlan.scaffoldManifest }, [requirement('AC-1')], []))
      .toContain('unknown_property');
    const { scaffoldManifest, ...noScaffold } = validFullPlan;
    void scaffoldManifest;
    expect(codes(noScaffold)).toContain('missing_field');
    const newline = {
      ...validSmallPlan,
      tasks: [{ ...validSmallPlan.tasks[0], reuse: [{ path: 'src/a.ts\nsrc/b.ts' }] }],
    };
    expect(codes(newline, [requirement('AC-1')], [])).toContain('invalid_value');
    const longPath = {
      ...validSmallPlan,
      tasks: [{ ...validSmallPlan.tasks[0], reuse: [{ path: `src/${'a'.repeat(220)}.ts` }] }],
    };
    expect(codes(longPath, [requirement('AC-1')], [])).toContain('invalid_value');
    expect(() => validateBuildPlan({ plan: { classification: 'small' }, requirements: [], riskDecisions: [] })).not.toThrow();
  });

  it('VT-11 every published fixture fails or passes for its stated reason', () => {
    for (const fixture of validBuildPlans) {
      const requirements = fixture.plan.tests
        .map((row) => row.subjectId)
        .filter((id) => !id.startsWith('RD-'))
        .map((id) => requirement(id));
      const riskDecisions = fixture.plan.tests
        .map((row) => row.subjectId)
        .filter((id) => id.startsWith('RD-'))
        .map((id) => risk(id));
      const result = validateBuildPlan({ plan: fixture.plan, requirements, riskDecisions });
      expect(result.ok).toBe(true);
    }
    for (const fixture of invalidBuildPlans) {
      const result = validateBuildPlan({
        plan: fixture.plan,
        requirements: fixture.requirements.map((row) => requirement(row.id, row.retired)),
        riskDecisions: fixture.riskDecisions.map((row) => risk(row.id)),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violations.map((row) => row.code)).toContain(fixture.expectedCode);
      }
    }
  });

  it('narrows coverage to the requested ids', () => {
    const result = validateBuildPlan({
      plan: validSmallPlan,
      requirements: [requirement('AC-1'), requirement('AC-2')],
      riskDecisions: [],
      coverageScope: { requirementIds: ['AC-1'] },
    });
    expect(result).toEqual({ ok: true });
  });
});

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
}
