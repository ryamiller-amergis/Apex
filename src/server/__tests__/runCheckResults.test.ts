import type { RunCheckResult } from '../../shared/types/agentRunLifecycle';
import { deriveFailingChecks, shouldClaimAllChecksPassed } from '../../shared/utils/runCheckResults';

const passed = (kind: RunCheckResult['kind']): RunCheckResult => ({ kind, outcome: 'passed' });
const failed = (kind: RunCheckResult['kind']): RunCheckResult => ({ kind, outcome: 'failed' });

describe('deriveFailingChecks (TBI-005 DoD-0; PBI-006 AC-a/AC-b; supports VT-03, VT-04)', () => {
  it('PBI-006 AC-a — returns no failing kinds when every check passed, so a PR row shows no failure indicator', () => {
    expect(deriveFailingChecks([passed('unit'), passed('e2e'), passed('wcag')])).toEqual([]);
  });

  it('PBI-006 AC-b — returns only the failed kinds when outcomes are mixed', () => {
    expect(
      deriveFailingChecks([passed('unit'), failed('e2e'), failed('wcag')]),
    ).toEqual(['e2e', 'wcag']);
  });

  it('PBI-006 AC-b — preserves the input order of failed entries', () => {
    expect(
      deriveFailingChecks([failed('wcag'), passed('unit'), failed('e2e')]),
    ).toEqual(['wcag', 'e2e']);
  });

  it('TBI-005 DoD-0 — covers all three check kinds (unit, e2e, wcag)', () => {
    expect(deriveFailingChecks([failed('unit'), failed('e2e'), failed('wcag')])).toEqual([
      'unit',
      'e2e',
      'wcag',
    ]);
  });

  it('TBI-005 DoD-0 — returns an empty list for null or empty results rather than throwing', () => {
    expect(deriveFailingChecks(null)).toEqual([]);
    expect(deriveFailingChecks([])).toEqual([]);
  });

  it('does not mutate or alias the caller-supplied results array', () => {
    const results: RunCheckResult[] = [failed('unit'), passed('e2e')];
    const snapshot = JSON.parse(JSON.stringify(results));
    deriveFailingChecks(results);
    expect(results).toEqual(snapshot);
  });
});

describe('shouldClaimAllChecksPassed (TBI-005 DoD-2; PBI-006 AC-a/AC-c; supports VT-05)', () => {
  it('PBI-006 AC-a — claims all passed when a PR exists and every check passed', () => {
    expect(shouldClaimAllChecksPassed([passed('unit'), passed('e2e'), passed('wcag')], false)).toBe(
      true,
    );
  });

  it('PBI-006 AC-b — does not claim all passed when any check failed', () => {
    expect(shouldClaimAllChecksPassed([passed('unit'), failed('e2e')], false)).toBe(false);
  });

  it('TBI-005 DoD-2 — never claims passed checks for a run that finished without a PR, even when all checks passed', () => {
    expect(shouldClaimAllChecksPassed([passed('unit'), passed('e2e'), passed('wcag')], true)).toBe(
      false,
    );
  });

  it('TBI-005 DoD-2 — never claims passed checks for a run that finished without a PR, for any results value', () => {
    expect(shouldClaimAllChecksPassed(null, true)).toBe(false);
    expect(shouldClaimAllChecksPassed([], true)).toBe(false);
    expect(shouldClaimAllChecksPassed([failed('unit')], true)).toBe(false);
  });

  it('TBI-005 DoD-2 — does not claim passed checks when no results were reported', () => {
    expect(shouldClaimAllChecksPassed(null, false)).toBe(false);
    expect(shouldClaimAllChecksPassed([], false)).toBe(false);
  });
});
