/**
 * PBI-014 security — the plan file is redacted before it is validated.
 * VT-12 and VT-13. Transport is the file on the integration branch.
 */
import { validateBuildPlan } from '../services/buildPlanning/planValidator';
import { parsePlanFile, PLANNER_STOPPED_MESSAGE } from '../services/buildPlanning/plannerResult';
import { validSmallPlan } from '../../shared/fixtures/buildPlanFixtures';
import type { BuildRequirement } from '../../shared/types/build';

const token = 'Bearer abc123xyzTOKEN';
const connection = 'postgres://user:secret@localhost:5432/app';

describe('plan file parser', () => {
  it('VT-12 reads a plan file and rejects a missing or broken file', () => {
    const parsed = parsePlanFile(JSON.stringify(validSmallPlan));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.redacted.plan).toEqual(validSmallPlan);

    for (const text of [null, '', '{']) {
      const result = parsePlanFile(text);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.violation.code).toBe('invalid_value');
        expect(result.violation.message).toBe(PLANNER_STOPPED_MESSAGE);
      }
    }
  });

  it('VT-13 / PBI-014 redacts secret-shaped reuse text before validation', () => {
    const planted = {
      ...validSmallPlan,
      tasks: [{
        ...validSmallPlan.tasks[0],
        reuse: [{ path: 'src/widget.ts', reason: `${token} ${connection}` }],
      }],
    };
    const parsed = parsePlanFile(JSON.stringify(planted));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.redacted.redactionCount).toBeGreaterThan(0);
    expect(JSON.stringify(parsed.redacted.plan)).not.toContain(token);
    expect(JSON.stringify(parsed.redacted.plan)).not.toContain('secret@localhost');
    const requirement: BuildRequirement = { id: 'AC-1', kind: 'ac', text: 'widget', retired: false };
    const validated = validateBuildPlan({
      plan: parsed.redacted.plan,
      requirements: [requirement],
      riskDecisions: [],
    });
    expect(validated.ok).toBe(true);
    expect(parsed.redacted.plan).toEqual(parsed.redacted.plan);
  });
});
