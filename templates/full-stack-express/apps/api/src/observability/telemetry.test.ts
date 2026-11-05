import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTelemetryEnv } from '../config/env.ts';
import {
  activeTelemetry,
  createDiagLogger,
  createExportFailureReporter,
  createInstrumentations,
  resolveTelemetryPlan,
  startTelemetry,
} from './telemetry.ts';

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

afterEach(async () => {
  await activeTelemetry().shutdown();
});

describe('resolveTelemetryPlan', () => {
  it('VT-13 PBI-014 AC-2 TBI-017 DoD-2 is disabled when no exporter is configured', () => {
    expect(resolveTelemetryPlan(parseTelemetryEnv({}))).toMatchObject({
      enabled: false,
      reason: 'no exporter configured',
      traces: 'none',
      metrics: 'none',
    });
  });

  it('VT-13 an explicit otlp exporter without an endpoint stays off', () => {
    const plan = resolveTelemetryPlan(
      parseTelemetryEnv({
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
      })
    );
    expect(plan.enabled).toBe(false);
  });

  it('VT-13 OTEL_SDK_DISABLED wins over an endpoint', () => {
    const plan = resolveTelemetryPlan(
      parseTelemetryEnv({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      })
    );
    expect(plan).toMatchObject({ enabled: false, reason: 'OTEL_SDK_DISABLED' });
  });

  it('TBI-017 DoD-1 derives both signal URLs from the base endpoint', () => {
    const plan = resolveTelemetryPlan(
      parseTelemetryEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer abc, x-tenant = one',
      })
    );
    expect(plan).toMatchObject({
      enabled: true,
      traces: 'otlp',
      metrics: 'otlp',
      tracesUrl: 'http://collector:4318/v1/traces',
      metricsUrl: 'http://collector:4318/v1/metrics',
      headers: { authorization: 'Bearer abc', 'x-tenant': 'one' },
    });
  });

  it('TBI-017 DoD-1 signal endpoints and exporter names override the base', () => {
    const plan = resolveTelemetryPlan(
      parseTelemetryEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example/custom',
        OTEL_METRICS_EXPORTER: 'none',
      })
    );
    expect(plan).toMatchObject({
      enabled: true,
      traces: 'otlp',
      metrics: 'none',
      tracesUrl: 'https://traces.example/custom',
    });
  });

  it('TBI-017 console exporters enable telemetry with no endpoint', () => {
    const plan = resolveTelemetryPlan(
      parseTelemetryEnv({ OTEL_TRACES_EXPORTER: 'console' })
    );
    expect(plan).toMatchObject({
      enabled: true,
      traces: 'console',
      metrics: 'none',
    });
  });
});

describe('startTelemetry', () => {
  it('VT-13 PBI-014 AC-2 returns a disabled handle, makes no network call, and shuts down at once', async () => {
    const received: string[] = [];
    const collector = createServer((req: IncomingMessage, res) => {
      received.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => collector.listen(0, resolve));
    const { port } = collector.address() as AddressInfo;
    const logger = fakeLogger();
    const handle = startTelemetry(
      parseTelemetryEnv({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      }),
      { logger }
    );
    expect(handle.enabled).toBe(false);
    expect(activeTelemetry()).toBe(handle);
    let settled = false;
    const done = handle.shutdown().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(true);
    await done;
    expect(received).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      { reason: 'OTEL_SDK_DISABLED' },
      'telemetry.disabled'
    );
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it('PBI-014 NFR startup logs name exporters and never the endpoint or headers', async () => {
    const logger = fakeLogger();
    const handle = startTelemetry(
      parseTelemetryEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://secret-host.invalid:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=MARKER_SECRET',
        OTEL_METRICS_EXPORTER: 'none',
      }),
      { logger }
    );
    expect(handle.enabled).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { traces: 'otlp', metrics: 'none' },
      'telemetry.started'
    );
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain('secret-host');
    expect(logged).not.toContain('MARKER_SECRET');
    await handle.shutdown();
    expect(activeTelemetry().enabled).toBe(false);
  });
});

describe('createInstrumentations', () => {
  it('TBI-017 DoD-0 DoD-3 instruments HTTP, Express, and pg without headers or SQL parameters', () => {
    const instrumentations = createInstrumentations();
    expect(instrumentations.map((i) => i.instrumentationName)).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-express',
      '@opentelemetry/instrumentation-pg',
    ]);
    const http = instrumentations[0] as HttpInstrumentation;
    expect(http.getConfig().headersToSpanAttributes).toBeUndefined();
    const ignore = http.getConfig().ignoreIncomingRequestHook;
    expect(ignore?.({ url: '/health/live' } as IncomingMessage)).toBe(true);
    expect(ignore?.({ url: '/health/ready?x=1' } as IncomingMessage)).toBe(
      true
    );
    expect(ignore?.({ url: '/api/v1/me' } as IncomingMessage)).toBe(false);
    const pg = instrumentations[2] as PgInstrumentation;
    expect(pg.getConfig().enhancedDatabaseReporting).toBe(false);
    for (const instrumentation of instrumentations) {
      instrumentation.disable();
    }
  });
});

describe('export failure reporting', () => {
  it('VT-15 PBI-014 AC-1 logs each signal once per window', () => {
    let now = 0;
    const logger = fakeLogger();
    const report = createExportFailureReporter(logger, {
      windowMs: 60000,
      now: () => now,
    });
    report('traces', new Error('connect ECONNREFUSED'));
    report('traces', new Error('connect ECONNREFUSED'));
    report('metrics', new Error('connect ECONNREFUSED'));
    now = 59999;
    report('traces', new Error('again'));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    now = 60000;
    const later = new Error('later');
    report('traces', later);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenLastCalledWith(
      { signal: 'traces', err: later },
      'telemetry.export_failed'
    );
    report('metrics', { code: 14 });
    now = 120000;
    report('metrics', { code: 14 });
    expect(logger.warn).toHaveBeenLastCalledWith(
      { signal: 'metrics', err: new Error('export failed') },
      'telemetry.export_failed'
    );
  });

  it('VT-15 the diagnostic adapter routes errors and warnings to warn and de-duplicates by message', () => {
    let now = 0;
    const logger = fakeLogger();
    const diag = createDiagLogger(logger, { windowMs: 60000, now: () => now });
    diag.error('export failed', { headers: 'MARKER_SECRET' });
    diag.warn('export failed');
    diag.info('ignored');
    diag.debug('ignored');
    diag.verbose('ignored');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { diagnostic: 'export failed' },
      'telemetry.diagnostic'
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'MARKER_SECRET'
    );
    now = 60000;
    diag.warn('export failed');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
