import {
  hasActiveFilters,
  isDateRangeInvalid,
  parseWorkflowEvaluationFilters,
  writeWorkflowEvaluationFilters,
} from '../workflowEvaluationFilters';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

describe('workflowEvaluationFilters', () => {
  it('round-trips known values and keeps unrelated params', () => {
    const params = new URLSearchParams(
      `outcome=reject&stage=prd_human_review&reason=too_vague&subjectType=prd&from=2026-10-01&to=2026-10-21&q=abc&eventId=${EVENT_ID}&drawer=${EVENT_ID}`,
    );
    const filters = parseWorkflowEvaluationFilters(params);
    expect(filters).toEqual({
      outcome: 'reject', stage: 'prd_human_review', reason: 'too_vague', subjectType: 'prd',
      from: '2026-10-01', to: '2026-10-21', q: 'abc', eventId: EVENT_ID,
    });
    const written = writeWorkflowEvaluationFilters(params, { ...filters, outcome: undefined });
    expect(written.get('outcome')).toBeNull();
    expect(written.get('drawer')).toBe(EVENT_ID);
  });

  it('drops unknown values silently', () => {
    expect(parseWorkflowEvaluationFilters(new URLSearchParams(
      'outcome=maybe&stage=design&reason=nope&subjectType=x&from=2026-02-30&to=yesterday&eventId=abc&q=%20%20',
    ))).toEqual({});
  });

  it('flags an inverted date range and active filters', () => {
    expect(isDateRangeInvalid({ from: '2026-10-21', to: '2026-10-01' })).toBe(true);
    expect(isDateRangeInvalid({ from: '2026-10-01', to: '2026-10-01' })).toBe(false);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: 'x' })).toBe(true);
  });
});
