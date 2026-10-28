/**
 * TBI-013 / PBI-014 (b) / PBI-015 (a)(b) — planner prompt.
 * VT-14, VT-15, VT-17.
 */
import fs from 'fs';
import path from 'path';
import { buildPlannerPrompt } from '../services/buildPlanning/plannerPrompt';
import type { BuildRequirement, BuildRiskDecision } from '../../shared/types/build';

const secret = 'Bearer abc123xyzTOKEN';

const standards = {
  designSystemPath: 'docs/design-system.md',
  designSystemHash: 'a'.repeat(64),
  codingRulesPath: '.cursor/rules/react-coding-standards.mdc',
  codingRulesHash: 'b'.repeat(64),
  codeMapPath: '.cursor/CODEMAP.md',
  codeMapHash: 'c'.repeat(64),
};

const requirements: BuildRequirement[] = [{ id: 'AC-1', kind: 'ac', text: 'Save the plan', retired: false }];
const riskDecisions: BuildRiskDecision[] = [{
  id: 'RD-1',
  category: 'data',
  rating: 'low',
  decision: 'Keep the audit row',
  rationale: 'Needed for support',
}];

describe('planner prompt', () => {
  it('VT-14 / PBI-014 (b) lists repair codes and task keys and drops a planted secret', () => {
    const prompt = buildPlannerPrompt({
      mode: 'repair',
      buildRunId: 'run-1',
      integrationBranch: 'apex/build/run-1',
      brief: 'Ship the widget.',
      requirements,
      riskDecisions,
      standards,
      catalogExcerpt: secret,
      violations: [
        { code: 'overlapping_owned_file', message: 'Two tasks both own `src/server/routes/builds.ts`: t2 and t4', taskKeys: ['t2', 't4'], path: 'src/server/routes/builds.ts' },
        { code: 'empty_reuse', message: 'Task t2 names no reuse and no justification', taskKeys: ['t2'] },
      ],
    });
    expect(prompt).toContain('overlapping_owned_file');
    expect(prompt).toContain('empty_reuse');
    expect(prompt).toContain('t2');
    expect(prompt).toContain('plan.json');
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain('function save(');
  });

  it('VT-15 / PBI-015 says reuse is a starting point and clips the catalog', () => {
    const names = Array.from({ length: 300 }, (_, index) => `ComponentNumber${index} ${'x'.repeat(80)}`);
    const prompt = buildPlannerPrompt({
      mode: 'full',
      buildRunId: 'run-1',
      integrationBranch: 'apex/build/run-1',
      brief: 'Ship the widget.',
      requirements,
      riskDecisions,
      standards,
      catalogExcerpt: names.join('\n'),
      catalogBudgetBytes: 500,
    });
    expect(prompt).toContain('starting point');
    expect(prompt).toContain('justification');
    expect(prompt).toContain('AC-1');
    expect(prompt).toContain('RD-1');
    expect(prompt).not.toContain('ComponentNumber299');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(8_000);
  });

  it('VT-17 the planner skill names its modes and rules', () => {
    const text = fs.readFileSync(path.join(process.cwd(), '.cursor/skills/build-planner/SKILL.md'), 'utf8');
    for (const heading of ['Inputs', 'Modes', 'Plan rules', 'Reuse rules', 'Scaffold rules', 'Output contract']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('full');
    expect(text).toContain('small');
    expect(text).toContain('repair');
    expect(text).toContain('plan.json');
  });
});
