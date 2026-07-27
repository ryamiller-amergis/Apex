import {
  buildOverrideHistory,
  resolveOverrideHistory,
  type ValidationOverrideBase,
} from '../../../shared/utils/validationOverride';

describe('resolveOverrideHistory', () => {
  it('returns empty for null override', () => {
    expect(resolveOverrideHistory(null, 'legacy')).toEqual([]);
  });

  it('seeds a legacy single-entry override into history', () => {
    const override: ValidationOverrideBase = {
      reason: 'ship it',
      userId: 'u1',
      userDisplayName: 'Ada',
      at: '2026-07-26T12:00:00.000Z',
    };
    expect(resolveOverrideHistory(override, 'Overrode score')).toEqual([
      {
        reason: 'ship it',
        userId: 'u1',
        userDisplayName: 'Ada',
        at: '2026-07-26T12:00:00.000Z',
        summary: 'Overrode score',
      },
    ]);
  });

  it('returns stored history sorted oldest-first', () => {
    const override: ValidationOverrideBase = {
      reason: 'second',
      userId: 'u2',
      at: '2026-07-26T14:00:00.000Z',
      history: [
        {
          reason: 'second',
          userId: 'u2',
          at: '2026-07-26T14:00:00.000Z',
          summary: 'second summary',
        },
        {
          reason: 'first',
          userId: 'u1',
          at: '2026-07-26T12:00:00.000Z',
          summary: 'first summary',
        },
      ],
    };
    const history = resolveOverrideHistory(override, 'legacy');
    expect(history.map((e) => e.reason)).toEqual(['first', 'second']);
  });
});

describe('buildOverrideHistory', () => {
  it('starts a new history when there is no prior override', () => {
    const history = buildOverrideHistory(
      null,
      {
        reason: 'first',
        userId: 'u1',
        at: '2026-07-26T12:00:00.000Z',
        summary: 'first summary',
      },
      'legacy',
    );
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('first');
  });

  it('appends onto a legacy prior override', () => {
    const prior: ValidationOverrideBase = {
      reason: 'first',
      userId: 'u1',
      at: '2026-07-26T12:00:00.000Z',
    };
    const history = buildOverrideHistory(
      prior,
      {
        reason: 'second',
        userId: 'u2',
        at: '2026-07-26T14:00:00.000Z',
        summary: 'second summary',
      },
      'first legacy',
    );
    expect(history.map((e) => e.reason)).toEqual(['first', 'second']);
  });
});
