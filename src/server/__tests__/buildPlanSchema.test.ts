/**
 * TBI-002 DoD-1 / VT-10 / VT-11 / VT-12 — plan schema and fixtures.
 */
import { BUILD_PLAN_JSON_SCHEMA, BUILD_PLAN_VIOLATION_CODES, parseBuildPlan } from '../../shared/buildPlanSchema';
import { invalidBuildPlans, validBuildPlans, validFullPlan } from '../../shared/fixtures/buildPlanFixtures';

describe('VT-10 valid build plans', () => {
  it.each(validBuildPlans.map((fixture) => [fixture.id, fixture.plan] as const))(
    'VT-10 parses %s',
    (_id, plan) => {
      expect(parseBuildPlan(plan)).toEqual({ success: true, data: plan });
    },
  );

  it('VT-10 publishes a JSON schema for the planner skill', () => {
    expect(BUILD_PLAN_JSON_SCHEMA).toEqual(expect.any(Object));
  });
});

describe('VT-11 schema rejects invalid plans for the stated reason', () => {
  const schemaFixtures = invalidBuildPlans.filter((fixture) => fixture.stage === 'schema');

  it.each(schemaFixtures.map((fixture) => [fixture.id, fixture] as const))(
    'VT-11 %s fails as %s',
    (_id, fixture) => {
      const result = parseBuildPlan(fixture.plan);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.code).toBe(fixture.expectedCode);
    },
  );

  it.each(['root', 'task', 'reuse', 'test', 'constraint', 'scaffold'] as const)(
    'VT-11 unknown property at %s fails as unknown_property',
    (level) => {
      const plan = structuredClone(validFullPlan) as Record<string, unknown>;
      if (level === 'root') plan.extra = true;
      if (level === 'task') (plan.tasks as Array<Record<string, unknown>>)[0].extra = true;
      if (level === 'reuse') {
        ((plan.tasks as Array<{ reuse: Array<Record<string, unknown>> }>)[0].reuse[0]).extra = true;
      }
      if (level === 'test') (plan.tests as Array<Record<string, unknown>>)[0].extra = true;
      if (level === 'constraint') (plan.riskConstraints as Array<Record<string, unknown>>)[0].extra = true;
      if (level === 'scaffold') (plan.scaffoldManifest as Array<Record<string, unknown>>)[0].extra = true;
      const result = parseBuildPlan(plan);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.code).toBe('unknown_property');
    },
  );
});

describe('VT-12 validator-stage fixtures stay shape-valid', () => {
  const validatorFixtures = invalidBuildPlans.filter((fixture) => fixture.stage === 'validator');

  it.each(validatorFixtures.map((fixture) => [fixture.id, fixture] as const))(
    'VT-12 %s parses and names %s',
    (_id, fixture) => {
      expect(parseBuildPlan(fixture.plan).success).toBe(true);
      expect(BUILD_PLAN_VIOLATION_CODES).toContain(fixture.expectedCode);
      expect(fixture.requirements.length).toBeGreaterThan(0);
    },
  );
});
