/**
 * S1 / VT-01 / VT-08 / VT-11 — W3C, route registry, and browser error projection.
 * Criterion ids: AC-0, AC-3, DoD-0 (TBI-005), TBI-004 DoD-0.
 */
import { UNKNOWN_ROUTE_TEMPLATE } from '../../shared/types/observability';
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  isValidSpanId,
  isValidTraceId,
  parseTraceparent,
} from '../../shared/utils/w3cTrace';
import { normalizeApexRouteTemplate } from '../../shared/utils/observabilityRouteRegistry';
import {
  projectBrowserError,
  shouldRetainBrowserEvent,
} from '../../shared/utils/browserErrorProjection';
import { TRACE_REDACTED_MARKER } from '../../shared/types/observability';

describe('W3C helpers (S1 / VT-01)', () => {
  it('AC-0 generates nonzero 32-hex trace IDs and 16-hex span IDs', () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    expect(isValidTraceId(traceId)).toBe(true);
    expect(isValidSpanId(spanId)).toBe(true);
    expect(traceId).not.toBe(spanId);
  });

  it('AC-0 parses a valid traceparent and rejects malformed or all-zero IDs', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const parsed = parseTraceparent(formatTraceparent(traceId, spanId));
    expect(parsed).toEqual({
      version: '00',
      traceId,
      spanId,
      flags: '01',
    });
    expect(parseTraceparent('not-a-traceparent')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
    expect(isValidTraceId('00000000000000000000000000000000')).toBe(false);
    expect(isValidSpanId('0000000000000000')).toBe(false);
  });
});

describe('route registry (S1 / VT-08 / AC-3)', () => {
  it('AC-3 maps concrete Apex paths to templates and strips query/fragment', () => {
    expect(normalizeApexRouteTemplate('/backlog/prd/0fa92805?tab=comments#top')).toBe(
      '/backlog/prd/:id',
    );
    expect(normalizeApexRouteTemplate('/home')).toBe('/home');
    expect(normalizeApexRouteTemplate('/load-tests/abc/runs')).toBe('/load-tests/:definitionId/runs');
  });

  it('AC-3 returns unknown_route without retaining the raw path', () => {
    const concrete = '/projects/abc-123/prd/xyz';
    expect(normalizeApexRouteTemplate(concrete)).toBe(UNKNOWN_ROUTE_TEMPLATE);
    expect(normalizeApexRouteTemplate(concrete)).not.toContain('abc-123');
  });
});

describe('browser error projection (S1 / VT-11)', () => {
  it('VT-11 projects Error Boundary, string, and object rejections without raw objects or secrets', () => {
    const fromError = projectBrowserError(new Error('boom\nBearer abc.def'));
    expect(fromError.message).toContain('boom');
    expect(fromError.stack).toBeDefined();

    expect(projectBrowserError('plain failure').message).toBe('plain failure');

    const fromObject = projectBrowserError({
      message: 'Bearer super-secret-token',
      email: 'user@test.com',
      nested: { password: 'hunter2' },
    });
    expect(fromObject.message).toContain(TRACE_REDACTED_MARKER);
    expect(JSON.stringify(fromObject)).not.toMatch(/nested|password|user@test.com/);
  });

  it('retains route views and errors regardless of sampling rate', () => {
    expect(shouldRetainBrowserEvent('route_view', 0)).toBe(true);
    expect(shouldRetainBrowserEvent('client_error', 0)).toBe(true);
    expect(shouldRetainBrowserEvent('unhandled_rejection', 0.1)).toBe(true);
    expect(shouldRetainBrowserEvent('future_action', 0)).toBe(false);
    expect(shouldRetainBrowserEvent('future_action', 1)).toBe(true);
  });
});
