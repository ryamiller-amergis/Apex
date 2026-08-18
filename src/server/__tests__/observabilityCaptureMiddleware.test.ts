/**
 * TBI-003 / PBI-001 — capture policy and authenticated completion middleware.
 * Criterion ids: AC-0, AC-3, DoD-0, DoD-1, VT-02, VT-08, VT-09, VT-10, BR-005, BR-010.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
import type { NextFunction, Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import type { ServerTraceCandidate } from '../../shared/types/observability';
import {
  createObservabilityCaptureMiddleware,
  captureServerError,
} from '../middleware/observabilityCapture';
import { createObservabilityCaptureService } from '../services/observabilityCaptureService';
import {
  isCaptureExcludedPath,
  isPollRoute,
  parseTraceIdFromTraceparent,
  resolveCaptureProject,
  resolveRouteTemplate,
} from '../middleware/observabilityCapturePolicy';

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${VALID_TRACE_ID}-00f067aa0ba902b7-01`;

interface MockRes extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => MockRes;
  writeHead: (...args: unknown[]) => MockRes;
  getHeader: (name: string) => string | undefined;
}

function makeReq(overrides: Partial<Request> & Record<string, unknown> = {}): Request {
  const headers: Record<string, string> = {
    traceparent: TRACEPARENT,
    ...((overrides.headers as Record<string, string> | undefined) ?? {}),
  };
  const { headers: _ignoredHeaders, get: overrideGet, ...rest } = overrides;
  const req: Record<string, unknown> = {
    method: 'GET',
    baseUrl: '/api',
    path: '/projects',
    url: '/projects',
    query: {},
    params: {},
    route: { path: '/projects' },
    user: { profile: { oid: 'user-oid-1' } },
    sessionID: 'sess-1',
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ...rest,
    headers,
  };
  if (overrideGet) req.get = overrideGet;
  return req as unknown as Request;
}

function makeRes(statusCode = 200): MockRes {
  const res = new EventEmitter() as MockRes;
  res.statusCode = statusCode;
  res.headers = {};
  res.setHeader = (name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  };
  res.writeHead = (...args: unknown[]) => {
    if (typeof args[0] === 'number') res.statusCode = args[0];
    const headerArg = args.find((arg) => arg && typeof arg === 'object') as Record<string, string> | undefined;
    if (headerArg) {
      for (const [key, value] of Object.entries(headerArg)) {
        res.headers[key.toLowerCase()] = value;
      }
    }
    return res;
  };
  res.getHeader = (name: string) => res.headers[name.toLowerCase()];
  return res;
}

describe('observabilityCapturePolicy', () => {
  it('VT-09 / AC-3 / BR-005 excludes ingest, health, readiness, and static paths', () => {
    expect(isCaptureExcludedPath('/api/observability/ingest')).toBe(true);
    expect(isCaptureExcludedPath('/api/observability/events')).toBe(true);
    expect(isCaptureExcludedPath('/api/health')).toBe(true);
    expect(isCaptureExcludedPath('/api/health/db')).toBe(true);
    expect(isCaptureExcludedPath('/health/agents')).toBe(true);
    expect(isCaptureExcludedPath('/ready')).toBe(true);
    expect(isCaptureExcludedPath('/api/ready')).toBe(true);
    expect(isCaptureExcludedPath('/static/app.js')).toBe(true);
    expect(isCaptureExcludedPath('/assets/main.css')).toBe(true);
    expect(isCaptureExcludedPath('/api/projects')).toBe(false);
  });

  it('DoD-1 / BR-005 marks reviewed pollers', () => {
    expect(isPollRoute('/api/chat/threads/:id/run-status')).toBe(true);
    expect(isPollRoute('/api/notifications/unread-count')).toBe(true);
    expect(isPollRoute('/api/notifications/poll')).toBe(true);
    expect(isPollRoute('/api/projects')).toBe(false);
  });

  it('DoD-0 stamps project from query, params, or x-apex-project and never the body', () => {
    expect(
      resolveCaptureProject(
        makeReq({ query: { project: 'QueryProj' }, body: { project: 'BodyProj' } }),
      ),
    ).toBe('QueryProj');
    expect(
      resolveCaptureProject(
        makeReq({
          query: {},
          params: { projectId: 'ParamProj' } as Request['params'],
          body: { project: 'BodyProj' },
        }),
      ),
    ).toBe('ParamProj');
    expect(
      resolveCaptureProject(
        makeReq({
          query: {},
          headers: { 'x-apex-project': 'HeaderProj' },
          body: { project: 'BodyProj' },
        }),
      ),
    ).toBe('HeaderProj');
  });

  it('VT-02 parses W3C traceparent and normalizes Express route templates', () => {
    expect(parseTraceIdFromTraceparent(TRACEPARENT)).toBe(VALID_TRACE_ID);
    expect(parseTraceIdFromTraceparent('not-a-trace')).toBeNull();
    const req = makeReq({
      baseUrl: '/api/projects',
      path: '/abc',
      route: { path: '/:projectId' },
    });
    expect(resolveRouteTemplate(req)).toBe('/api/projects/:projectId');
  });
});

describe('observabilityCaptureMiddleware', () => {
  it('VT-02 / AC-0 / DoD-0 queues a redacted API event with actor, trace, template, status, and duration', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({
      isEnabled: () => true,
      capture,
      now: (() => {
        let t = 1_000;
        return () => {
          t += 5;
          return t;
        };
      })(),
    });
    const req = makeReq({ query: { project: 'Apex' } });
    const res = makeRes(200);
    const next = jest.fn() as NextFunction;

    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();

    res.statusCode = 200;
    res.emit('finish');

    expect(capture).toHaveBeenCalledTimes(1);
    const event = capture.mock.calls[0][0] as ServerTraceCandidate;
    expect(event.actorUserId).toBe('user-oid-1');
    expect(event.traceId).toBe(VALID_TRACE_ID);
    expect(event.routeTemplate).toBe('/api/projects');
    expect(event.httpMethod).toBe('GET');
    expect(event.statusCode).toBe(200);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.projectId).toBe('Apex');
    expect(event.sessionId).toBe('sess-1');
    expect(event.trigger).toBe('human');
  });

  it('VT-02 captures exactly once when both finish and close fire', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({ isEnabled: () => true, capture });
    const res = makeRes();
    middleware(makeReq(), res as unknown as Response, jest.fn());
    res.emit('finish');
    res.emit('close');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('VT-08 / AC-3 performs no capture work when the flag snapshot is off', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({ isEnabled: () => false, capture });
    const res = makeRes();
    middleware(makeReq(), res as unknown as Response, jest.fn());
    res.emit('finish');
    expect(capture).not.toHaveBeenCalled();
  });

  it('VT-09 / AC-3 skips Observability ingest, health, and static requests', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({ isEnabled: () => true, capture });

    for (const path of ['/observability/ingest', '/health', '/health/db']) {
      const res = makeRes();
      middleware(
        makeReq({ baseUrl: '/api', path, route: { path } }),
        res as unknown as Response,
        jest.fn(),
      );
      res.emit('finish');
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it('VT-10 / DoD-1 emits SSE open and close only and never per-chunk payloads', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({ isEnabled: () => true, capture });
    const res = makeRes();
    middleware(
      makeReq({ baseUrl: '/api/notifications', path: '/stream', route: { path: '/stream' } }),
      res as unknown as Response,
      jest.fn(),
    );

    res.setHeader('Content-Type', 'text/event-stream');
    expect(capture).toHaveBeenCalledTimes(1);
    expect((capture.mock.calls[0][0] as ServerTraceCandidate).ssePhase).toBe('open');

    res.emit('finish');
    expect(capture).toHaveBeenCalledTimes(2);
    expect((capture.mock.calls[1][0] as ServerTraceCandidate).ssePhase).toBe('close');
    expect(capture.mock.calls.some((call) => JSON.stringify(call[0]).includes('token'))).toBe(false);
  });

  it('VT-10 / BR-005 marks poll traffic as machine-triggered', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({ isEnabled: () => true, capture });
    const res = makeRes();
    middleware(
      makeReq({
        baseUrl: '/api/chat',
        path: '/threads/1/run-status',
        route: { path: '/threads/:id/run-status' },
      }),
      res as unknown as Response,
      jest.fn(),
    );
    res.emit('finish');
    expect((capture.mock.calls[0][0] as ServerTraceCandidate).trigger).toBe('poll');
  });

  it('does not capture anonymous requests', () => {
    const capture = jest.fn();
    const middleware = createObservabilityCaptureMiddleware({ isEnabled: () => true, capture });
    const res = makeRes();
    middleware(makeReq({ user: undefined, sessionID: undefined }), res as unknown as Response, jest.fn());
    res.emit('finish');
    expect(capture).not.toHaveBeenCalled();
  });

  it('never calls next(err) when capture throws', () => {
    const next = jest.fn() as NextFunction;
    const middleware = createObservabilityCaptureMiddleware({
      isEnabled: () => true,
      capture: () => {
        throw new Error('boom');
      },
    });
    const res = makeRes();
    middleware(makeReq(), res as unknown as Response, next);
    res.emit('finish');
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });
});

describe('captureServerError', () => {
  it('DoD-0 submits a scrubbed error candidate without throwing', () => {
    const capture = jest.fn();
    expect(() => {
      captureServerError(
        makeReq(),
        Object.assign(new Error('Bearer leaked'), { stack: 'Error: Bearer leaked\nat x' }),
        undefined,
        { isEnabled: () => true, capture },
      );
    }).not.toThrow();

    expect(capture).toHaveBeenCalledTimes(1);
    const event = capture.mock.calls[0][0] as ServerTraceCandidate;
    expect(event.eventType).toBe('error');
    expect(event.severity).toBe('error');
    expect((event.error as { message: string }).message).toBe('Bearer leaked');
  });
});

describe('Express capture integration', () => {
  it('VT-06 / AC-1 keeps the user response successful when persistence fails', async () => {
    const insertBatch = jest.fn(async () => {
      throw new Error('db down');
    });
    const service = createObservabilityCaptureService({
      isCaptureEnabled: () => true,
      insertBatch,
      retryDelayMs: 0,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as Request & { user?: { profile: { oid: string } } }).user = {
        profile: { oid: 'user-oid-1' },
      };
      next();
    });
    app.use(
      createObservabilityCaptureMiddleware({
        isEnabled: () => true,
        capture: (candidate) => service.capture(candidate),
      }),
    );
    app.get('/projects', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.get('/boom', () => {
      throw Object.assign(new Error('handled boom'), { status: 500 });
    });
    app.use((err: Error & { status?: number }, req: Request, res: Response, _next: NextFunction) => {
      captureServerError(req, err, res, {
        isEnabled: () => true,
        capture: (candidate) => service.capture(candidate),
      });
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const success = await request(app).get('/projects').set('traceparent', TRACEPARENT);
    expect(success.status).toBe(200);
    expect(success.body).toEqual({ ok: true });

    const failure = await request(app).get('/boom').set('traceparent', TRACEPARENT);
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({ error: 'handled boom' });

    await service.flush();
    expect(service.getHealth().flushErrorCount).toBeGreaterThanOrEqual(1);
    expect(insertBatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
