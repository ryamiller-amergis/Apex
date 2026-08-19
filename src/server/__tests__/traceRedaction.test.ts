/**
 * TBI-002 / VT-05–VT-10 / VT-13 — mandatory redaction boundary.
 * Criterion ids are greppable: DoD-0, DoD-1, DoD-2, NFR.
 */
import {
  TRACE_EVENT_TYPES,
  TRACE_REDACTED_MARKER,
  TRACE_TRUNCATED_MARKER,
  TraceRedactionError,
  type TraceEventCandidate,
} from '../../shared/types/observability';
import { redactTraceDetails, toSafeTraceEvent } from '../../shared/utils/traceRedaction';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function candidate(overrides: Partial<TraceEventCandidate> = {}): TraceEventCandidate {
  return {
    eventType: 'api_request',
    occurredAt: '2026-08-17T16:00:00.000Z',
    actorUserId: 'user-oid-1',
    projectId: 'Apex',
    traceId: VALID_TRACE_ID,
    sessionId: 'interview-thread-1',
    routeTemplate: '/api/projects',
    httpMethod: 'GET',
    statusCode: 200,
    durationMs: 12,
    severity: 'info',
    ...overrides,
  };
}

describe('observability shared contracts (S1 / VT-03 enabling)', () => {
  it('DoD-1 exposes the canonical Trace Event discriminators', () => {
    expect([...TRACE_EVENT_TYPES]).toEqual(['api_request', 'error', 'ui_action', 'agent_event']);
  });
});

describe('toSafeTraceEvent', () => {
  it('DoD-0 / VT-05 keeps only allow-listed headers and drops denied headers rather than masking them', () => {
    const safe = toSafeTraceEvent(
      candidate({
        details: {
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '42',
            'User-Agent': 'ApexClient/1.0',
            'X-Request-Id': 'req-1',
            traceparent: `00-${VALID_TRACE_ID}-00f067aa0ba902b7-01`,
            Authorization: 'Bearer super-secret-token',
            Cookie: 'session=abc',
            'X-Api-Key': 'sk-live-123',
            Accept: 'application/json',
          },
        },
      }),
    );

    expect(safe.details.headers).toEqual({
      'content-type': 'application/json',
      'content-length': '42',
      'user-agent': 'ApexClient/1.0',
      'x-request-id': 'req-1',
      traceparent: `00-${VALID_TRACE_ID}-00f067aa0ba902b7-01`,
    });
    expect(JSON.stringify(safe.details)).not.toMatch(/Authorization|Cookie|X-Api-Key|Accept|Bearer|sk-live/i);
  });

  it('DoD-1 / VT-09 excludes request and response bodies unless a reviewed opt-in exists', () => {
    const safe = toSafeTraceEvent(
      candidate({
        details: {
          body: { interviewText: 'secret interview payload' },
          requestBody: { password: 'hunter2' },
          responseBody: { token: 'abc' },
          request_body: { note: 'also a body' },
          response_body: { note: 'also a body' },
          status: 201,
        },
      }),
    );

    expect(safe.details).not.toHaveProperty('body');
    expect(safe.details).not.toHaveProperty('requestBody');
    expect(safe.details).not.toHaveProperty('responseBody');
    expect(safe.details).not.toHaveProperty('request_body');
    expect(safe.details).not.toHaveProperty('response_body');
    expect(safe.details.status).toBe(201);
    expect(JSON.stringify(safe.details)).not.toMatch(/secret interview payload|hunter2/);
  });

  it('DoD-1 / VT-06 recursively redacts denied keys in objects and arrays while keeping safe siblings', () => {
    const safe = toSafeTraceEvent(
      candidate({
        details: {
          method: 'POST',
          nested: {
            Authorization: 'secret-header-value',
            api_key: 'ak-123',
            apiKey: 'ak-456',
            connection_string: 'Server=tcp:db;Password=x',
            email: 'user@example.com',
            PAT: 'ado-pat-value',
            token: 'tok',
            secret: 'shh',
            password: 'pw',
            cookie: 'sid=1',
            keep: 'visible',
          },
          items: [{ access_token: 'nested-token', ok: true }],
        },
      }),
    );

    const nested = safe.details.nested as Record<string, unknown>;
    expect(nested.keep).toBe('visible');
    expect(nested.Authorization).toBe(TRACE_REDACTED_MARKER);
    expect(nested.api_key).toBe(TRACE_REDACTED_MARKER);
    expect(nested.apiKey).toBe(TRACE_REDACTED_MARKER);
    expect(nested.connection_string).toBe(TRACE_REDACTED_MARKER);
    expect(nested.email).toBe(TRACE_REDACTED_MARKER);
    expect(nested.PAT).toBe(TRACE_REDACTED_MARKER);
    expect(nested.token).toBe(TRACE_REDACTED_MARKER);
    expect(nested.secret).toBe(TRACE_REDACTED_MARKER);
    expect(nested.password).toBe(TRACE_REDACTED_MARKER);
    expect(nested.cookie).toBe(TRACE_REDACTED_MARKER);
    expect((safe.details.items as Array<Record<string, unknown>>)[0]).toEqual({
      access_token: TRACE_REDACTED_MARKER,
      ok: true,
    });
    expect(safe.details.method).toBe('POST');
  });

  it('DoD-1 / VT-07 scrubs Bearer, JWT, PAT-like, API-key, and connection-string secrets in unkeyed strings', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const pat = 'a'.repeat(52);
    const safe = toSafeTraceEvent(
      candidate({
        details: {
          note: `Bearer abcdef.secret.token leftover ${jwt} PAT ${pat} api_key=sk-live-999 postgres://user:hunter2@db.example.com/app AccountKey=supersecretvalue`,
        },
      }),
    );

    const note = String(safe.details.note);
    expect(note).toContain(TRACE_REDACTED_MARKER);
    expect(note).not.toContain('abcdef.secret.token');
    expect(note).not.toContain(jwt);
    expect(note).not.toContain(pat);
    expect(note).not.toContain('sk-live-999');
    expect(note).not.toContain('hunter2');
    expect(note).not.toContain('supersecretvalue');
    expect(note).toContain('leftover');
  });

  it('DoD-1 / VT-08 projects errors to a scrubbed message and trimmed stack without raw properties', () => {
    const err = new Error(`Authorization Bearer leaked.${'x'.repeat(200)}`);
    Object.assign(err, { cause: { token: 'nested-secret' }, extra: 'enumerable-prop' });
    err.stack = Array.from({ length: 80 }, (_, i) => `    at frame${i} (secret-token-file.js:${i}:1)`).join('\n');

    const safe = toSafeTraceEvent(candidate({ eventType: 'error', error: err }));
    const projected = safe.details.error as { message?: string; stack?: string };

    expect(projected.message).toContain(TRACE_REDACTED_MARKER);
    expect(projected.message).not.toContain('Bearer leaked');
    expect(projected).not.toHaveProperty('cause');
    expect(projected).not.toHaveProperty('extra');
    expect(projected.stack?.split('\n').length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(safe.details)).not.toContain('enumerable-prop');
    expect(JSON.stringify(safe.details)).not.toContain('nested-secret');
  });

  it('DoD-1 NFR / VT-10 does not mutate caller-owned input and is idempotent', () => {
    const details = {
      headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      nested: { token: 'x', keep: 'y' },
    };
    Object.freeze(details);
    Object.freeze(details.headers);
    Object.freeze(details.nested);
    const input = candidate({ details });
    Object.freeze(input);

    const first = toSafeTraceEvent(input);
    const second = toSafeTraceEvent({
      ...first,
      details: first.details,
      traceId: first.traceId,
    });

    expect(details.headers.Authorization).toBe('Bearer abc');
    expect(details.nested.token).toBe('x');
    expect(first.details).toEqual(second.details);
    expect(first.traceId).toBe(second.traceId);
  });

  it('normalizes W3C trace id, route templates, status, duration, and HTTP method (S1 contract)', () => {
    const safe = toSafeTraceEvent(
      candidate({
        traceId: VALID_TRACE_ID.toUpperCase(),
        routeTemplate: '/api/interviews/3fa85f64-5717-4562-b3fc-2c963f66afa6/messages?q=secret',
        httpMethod: 'post',
        statusCode: 201,
        durationMs: 0,
      }),
    );

    expect(safe.traceId).toBe(VALID_TRACE_ID);
    expect(safe.routeTemplate).toBe('/api/interviews/:id/messages');
    expect(safe.routeTemplate).not.toContain('?');
    expect(safe.routeTemplate).not.toContain('3fa85f64');
    expect(safe.httpMethod).toBe('POST');
    expect(safe.statusCode).toBe(201);
    expect(safe.durationMs).toBe(0);
  });

  it('rejects invalid discriminators and trace ids with a rule id and no candidate content', () => {
    expect(() => toSafeTraceEvent(candidate({ eventType: 'not-a-type' }))).toThrow(TraceRedactionError);
    try {
      toSafeTraceEvent(candidate({ eventType: 'not-a-type', details: { token: 'leak-me' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TraceRedactionError);
      expect((err as TraceRedactionError).ruleId).toBe('invalid_event_type');
      expect((err as Error).message).not.toContain('leak-me');
    }

    expect(() => toSafeTraceEvent(candidate({ traceId: 'not-a-trace' }))).toThrow(TraceRedactionError);
  });

  it('coerces invalid status and negative duration to null without throwing secret-bearing text', () => {
    const safe = toSafeTraceEvent(
      candidate({
        statusCode: 99,
        durationMs: -1,
        details: { note: 'ok' },
      }),
    );
    expect(safe.statusCode).toBeNull();
    expect(safe.durationMs).toBeNull();
  });
});

describe('redactTraceDetails', () => {
  it('DoD-1 NFR / VT-13 bounds depth, arrays, strings, and total output with explicit truncation', () => {
    const deep: Record<string, unknown> = { keep: 'root' };
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      const next = { level: i };
      cursor.child = next;
      cursor = next;
    }
    const wide = { items: Array.from({ length: 80 }, (_, i) => `item-${i}`), blob: 'z'.repeat(5000) };
    const cyclic: Record<string, unknown> = { name: 'cycle' };
    cyclic.self = cyclic;

    const redacted = redactTraceDetails({ deep, wide, cyclic });
    const encoded = JSON.stringify(redacted);

    expect(encoded).toContain(TRACE_TRUNCATED_MARKER);
    expect(encoded.length).toBeLessThanOrEqual(12_000);
    expect(() => redactTraceDetails({ deep, wide, cyclic })).not.toThrow();
    expect(JSON.stringify(redacted)).not.toMatch(/Bearer |password=/i);
  });

  it('DoD-1 handles nested arrays, unusual values, and raw thrown objects without leaking', () => {
    const thrown = { message: 'Bearer abc.def', stack: 'long\n'.repeat(40), foo: 1 };
    const result = redactTraceDetails({
      list: [1, 'ok', { token: 'x' }, undefined, () => 'nope', BigInt(12) as unknown as number],
      thrown,
    });

    expect(Array.isArray(result.list)).toBe(true);
    expect((result.list as unknown[])[2]).toEqual({ token: TRACE_REDACTED_MARKER });
    expect(JSON.stringify(result)).not.toContain('abc.def');
  });
});
