/**
 * TBI-004 / PBI-002 — ObservabilityIngestService.
 * Criterion ids: AC-0, AC-2, AC-3, DoD-0, DoD-1, VT-02, VT-05, VT-06, VT-07, VT-08, VT-09, VT-12, BR-002, BR-003, BR-010.
 */
jest.mock('../db/drizzle', () => ({ db: { select: jest.fn() } }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/observabilityCaptureService', () => ({
  getObservabilityCaptureService: jest.fn(),
}));

import {
  INGEST_MAX_BYTES,
  INGEST_MAX_EVENTS,
  UNKNOWN_ROUTE_TEMPLATE,
  type CaptureDisposition,
  type ServerTraceCandidate,
} from '../../shared/types/observability';
import { createObservabilityIngestService } from '../services/observabilityIngestService';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const OCCURRED_AT = '2026-08-17T17:00:00.000Z';
const NOW = Date.parse(OCCURRED_AT);

function routeView(overrides: Record<string, unknown> = {}) {
  return {
    type: 'route_view',
    occurredAt: OCCURRED_AT,
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    routeTemplate: '/home',
    ...overrides,
  };
}

function ingestBody(events: unknown[], project = 'Apex') {
  return { project, events };
}

describe('ObservabilityIngestService', () => {
  const capture = jest.fn((_: ServerTraceCandidate): CaptureDisposition => 'queued');
  const isCaptureEnabled = jest.fn().mockResolvedValue(true);
  const hasProjectAccess = jest.fn().mockResolvedValue(true);
  const emitMetric = jest.fn();

  function service() {
    return createObservabilityIngestService({
      capture,
      isCaptureEnabled,
      hasProjectAccess,
      emitMetric,
      now: () => NOW,
    });
  }

  beforeEach(() => {
    capture.mockClear().mockReturnValue('queued');
    isCaptureEnabled.mockReset().mockResolvedValue(true);
    hasProjectAccess.mockReset().mockResolvedValue(true);
    emitMetric.mockReset();
  });

  it('AC-0 / VT-02 / DoD-0 queues a valid batch with the session-derived actor', async () => {
    const result = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 200,
      body: ingestBody([routeView()]),
    });
    expect(result).toEqual({ ok: true, accepted: 1 });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0].actorUserId).toBe('user-a');
    expect(capture.mock.calls[0][0].traceId).toBe(TRACE_ID);
    expect(capture.mock.calls[0][0].eventType).toBe('ui_action');
    expect(capture.mock.calls[0][0].routeTemplate).toBe('/home');
  });

  it('AC-2 / VT-05 accepts an exact 10-event boundary batch atomically', async () => {
    const events = Array.from({ length: INGEST_MAX_EVENTS }, (_, i) =>
      routeView({ spanId: `00f067aa0ba902b${i.toString(16)}`.slice(0, 16).padEnd(16, '0') }),
    );
    const result = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: INGEST_MAX_BYTES,
      body: ingestBody(events),
    });
    expect(result).toEqual({ ok: true, accepted: 10 });
    expect(capture).toHaveBeenCalledTimes(10);
  });

  it('AC-2 / VT-07 rejects an 11-event or oversized batch with no capture', async () => {
    const overCount = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 200,
      body: ingestBody(Array.from({ length: 11 }, () => routeView())),
    });
    expect(overCount).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(capture).not.toHaveBeenCalled();

    capture.mockClear();
    const overSize = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: INGEST_MAX_BYTES + 1,
      body: ingestBody([routeView()]),
    });
    expect(overSize).toEqual(expect.objectContaining({ ok: false, status: 400, code: 'PAYLOAD_TOO_LARGE' }));
    expect(capture).not.toHaveBeenCalled();
  });

  it('AC-2 / VT-06 rate-limits the 13th accepted batch in a minute', async () => {
    const ingestService = service();
    for (let i = 0; i < 12; i += 1) {
      const result = await ingestService.ingest({
        actorUserId: 'user-a',
        rawBodyBytes: 120,
        body: ingestBody([routeView({ spanId: (i + 1).toString(16).padStart(16, '0') })]),
      });
      expect(result.ok).toBe(true);
    }
    const limited = await ingestService.ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 120,
      body: ingestBody([routeView()]),
    });
    expect(limited).toEqual(expect.objectContaining({ ok: false, status: 429 }));
    expect(limited.ok === false && limited.retryAfterSec ? limited.retryAfterSec : 0).toBeGreaterThan(0);
    expect(capture).toHaveBeenCalledTimes(12);
  });

  it('AC-3 / VT-08 / BR-002 ignores a spoofed actor and strips concrete identifiers', async () => {
    const result = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 400,
      body: ingestBody([
        routeView({
          actor: 'user-b-id',
          routeTemplate: '/projects/abc-123/prd/xyz?secret=1',
        }),
      ]),
    });
    expect(result.ok).toBe(true);
    const queued = capture.mock.calls[0][0];
    expect(queued.actorUserId).toBe('user-a');
    expect(queued.routeTemplate).toBe(UNKNOWN_ROUTE_TEMPLATE);
    expect(JSON.stringify(queued)).not.toMatch(/user-b-id|abc-123|secret=1/);
    expect(emitMetric).toHaveBeenCalledWith(
      'observability.browser_batch.actor_spoof_ignored',
      expect.objectContaining({ count: 1 }),
    );
  });

  it('BR-003 / DoD-0 delegates client errors through capture for server-side re-redaction', async () => {
    await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 500,
      body: ingestBody([
        {
          type: 'client_error',
          occurredAt: OCCURRED_AT,
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          routeTemplate: '/home',
          severity: 'error',
          details: {
            message: 'Authorization: Bearer eyJabc.def.ghi',
            stack: 'at secret',
            email: 'user@test.com',
          },
        },
      ]),
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const queued = capture.mock.calls[0][0];
    expect(queued.eventType).toBe('error');
    expect(queued.actorUserId).toBe('user-a');
    expect(queued.error).toEqual({
      message: 'Authorization: Bearer eyJabc.def.ghi',
      stack: 'at secret',
    });
    expect(queued).not.toHaveProperty('actor');
  });

  it('BR-010 / VT-09 returns 404 and queues nothing when the flag is disabled', async () => {
    isCaptureEnabled.mockResolvedValue(false);
    const result = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 120,
      body: ingestBody([routeView()]),
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 404, code: 'FLAG_DISABLED' }));
    expect(capture).not.toHaveBeenCalled();
  });

  it('VT-12 / AC-1 does not await persistence and still accepts when capture later drops', async () => {
    capture.mockImplementation((): CaptureDisposition => 'dropped');
    const result = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 120,
      body: ingestBody([routeView()]),
    });
    expect(result).toEqual({ ok: true, accepted: 1 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('DoD-1 rejects malformed W3C identifiers without partial capture', async () => {
    const result = await service().ingest({
      actorUserId: 'user-a',
      rawBodyBytes: 200,
      body: ingestBody([routeView(), routeView({ traceId: '00000000000000000000000000000000' })]),
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(capture).not.toHaveBeenCalled();
  });
});
