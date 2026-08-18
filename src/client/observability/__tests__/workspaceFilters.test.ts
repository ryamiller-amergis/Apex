import {
  emptyFilterDraft,
  formatStoreBytes,
  formatTrailDescription,
  isBufferAtCapacity,
  isRetentionBoundaryReached,
  validateWorkspaceFilters,
} from '../workspaceFilters';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const NOW = Date.parse('2026-08-17T18:00:00.000Z');

describe('validateWorkspaceFilters', () => {
  it('PBI-004 AC-3 rejects a missing or non-UUID actor before search', () => {
    const missing = validateWorkspaceFilters({ ...emptyFilterDraft(), actorId: '' }, NOW);
    expect(missing.applied).toBeNull();
    expect(missing.errors.actorId).toMatch(/required/i);

    const invalid = validateWorkspaceFilters({ ...emptyFilterDraft(), actorId: 'jsmith@@bad' }, NOW);
    expect(invalid.applied).toBeNull();
    expect(invalid.errors.actorId).toMatch(/uuid/i);
  });

  it('PBI-004 AC-3 rejects a malformed trace ID', () => {
    const result = validateWorkspaceFilters(
      { ...emptyFilterDraft(), actorId: ACTOR, traceId: 'ZZ-NOT-VALID!!' },
      NOW,
    );
    expect(result.applied).toBeNull();
    expect(result.errors.traceId).toMatch(/32 hexadecimal/i);
  });

  it('PBI-004 AC-3 rejects an unsupported custom time range over 30 days', () => {
    const result = validateWorkspaceFilters(
      {
        ...emptyFilterDraft(),
        actorId: ACTOR,
        timeRange: 'custom',
        customFrom: '2026-06-01T00:00:00.000Z',
        customTo: '2026-08-17T00:00:00.000Z',
      },
      NOW,
    );
    expect(result.applied).toBeNull();
    expect(result.errors.timeRange).toMatch(/30 days/i);
  });

  it('PBI-004 AC-0 accepts a valid actor, optional 32-hex trace, and preset range', () => {
    const result = validateWorkspaceFilters(
      { ...emptyFilterDraft(), actorId: ACTOR, traceId: TRACE, timeRange: '1h' },
      NOW,
    );
    expect(result.errors).toEqual({});
    expect(result.applied).toEqual({
      from: '2026-08-17T17:00:00.000Z',
      to: '2026-08-17T18:00:00.000Z',
      actorId: ACTOR,
      traceId: TRACE,
      eventType: null,
    });
  });
});

describe('capture health boundary helpers', () => {
  it('PBI-005 AC-2 flags buffer depth at capacity', () => {
    expect(isBufferAtCapacity(10_000, 10_000)).toBe(true);
    expect(isBufferAtCapacity(8_700, 10_000)).toBe(false);
  });

  it('PBI-005 AC-2 flags oldest retained event at the 30-day boundary', () => {
    expect(isRetentionBoundaryReached('2026-07-18T18:00:00.000Z', NOW)).toBe(true);
    expect(isRetentionBoundaryReached('2026-08-01T18:00:00.000Z', NOW)).toBe(false);
  });

  it('PBI-005 AC-0 formats store size without event payload content', () => {
    expect(formatStoreBytes(12.4 * 1024 * 1024 * 1024)).toBe('12.4 GB');
  });
});

describe('formatTrailDescription', () => {
  it('PBI-004 AC-0 prefers a scrubbed diagnostic summary and never invents email', () => {
    expect(
      formatTrailDescription({
        eventType: 'error',
        routeTemplate: '/api/admin/flags',
        method: 'GET',
        statusCode: 403,
        durationMs: 12,
        diagnosticSummary: 'HTTP 403 Forbidden',
      }),
    ).toBe('HTTP 403 Forbidden');
  });
});
