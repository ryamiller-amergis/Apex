import { SpanKind } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTelemetryEnv } from '../config/env.ts';
import { captureLogs } from './testing/captureLogs.ts';
import { startTelemetry, type TelemetryHandle } from './telemetry.ts';

const MARKERS = {
  displayName: 'Span Marker Person 4K9',
  email: 'span.marker.4k9@example.test',
  subject: 'span-subject-4k9-marker',
};

const spans = new InMemorySpanExporter();
const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
let telemetry: TelemetryHandle;

beforeAll(() => {
  telemetry = startTelemetry(
    parseTelemetryEnv({
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'console',
      OTEL_BSP_SCHEDULE_DELAY: '10',
      OTEL_METRIC_EXPORT_INTERVAL: '60000',
    }),
    { exporters: { traces: spans, metrics } }
  );
});

afterAll(async () => {
  await telemetry.shutdown();
});

// Express and supertest load after the SDK starts, the same order instrument.ts
// enforces with --import. Vitest imports Express outside the ESM loader hook,
// so Express spans and http.route are asserted in shutdown.process.test.ts,
// which runs the real --import command.
async function buildApp() {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { createLogger } = await import('./logger.ts');
  const { requestId } = await import('./requestId.ts');
  const { requestLogging } = await import('./requestLogging.ts');
  const capture = captureLogs();
  const logger = createLogger({ LOG_LEVEL: 'info' }, capture.stream);
  const app = express();
  app.use(requestId());
  app.use(requestLogging(logger));
  app.use(express.json());
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/items/:id', (_req, res) => {
    logger.info('inside handler');
    res.json({ ok: true });
  });
  app.put('/api/v1/me', (req, res) => {
    res.json(req.body);
  });
  return { app, request, capture };
}

function allTelemetryText(): string {
  const parts: unknown[] = [];
  for (const span of spans.getFinishedSpans()) {
    parts.push(
      span.name,
      span.attributes,
      span.events,
      span.links,
      span.resource.attributes
    );
  }
  for (const resourceMetrics of metrics.getMetrics()) {
    parts.push(resourceMetrics.resource.attributes);
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        parts.push(
          metric.descriptor.name,
          metric.dataPoints.map((point) => point.attributes)
        );
      }
    }
  }
  return JSON.stringify(parts);
}

describe('OpenTelemetry instrumentation', () => {
  it('VT-11 TBI-017 DoD-0 produces an HTTP server span and the HTTP duration metric', async () => {
    const { app, request, capture } = await buildApp();
    await request(app).get('/items/42').expect(200);
    await telemetry.forceFlush();
    const server = spans
      .getFinishedSpans()
      .find(
        (span) =>
          span.kind === SpanKind.SERVER &&
          span.attributes['http.request.method'] === 'GET'
      );
    expect(server).toBeDefined();
    expect(server?.attributes['url.path']).toBe('/items/42');
    const names = metrics
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics.map((m) => m.descriptor.name));
    expect(names).toContain('http.server.request.duration');
    const handlerLine = capture
      .lines()
      .find((line) => line.msg === 'inside handler');
    expect(handlerLine?.trace_id).toBe(server?.spanContext().traceId);
    expect(handlerLine?.span_id).toEqual(expect.any(String));
  });

  it('VT-11 does not trace probe requests', async () => {
    spans.reset();
    const { app, request } = await buildApp();
    await request(app).get('/health/live').expect(200);
    await telemetry.forceFlush();
    const probeServerSpans = spans
      .getFinishedSpans()
      .filter(
        (span) =>
          span.kind === SpanKind.SERVER &&
          JSON.stringify(span.attributes).includes('/health')
      );
    expect(probeServerSpans).toEqual([]);
  });

  it('VT-12 TBI-017 DoD-3 PBI-013 AC-3 keeps identity markers out of spans, events, resources, and metrics', async () => {
    const { app, request } = await buildApp();
    await request(app)
      .put('/api/v1/me')
      .set('X-User-Email', MARKERS.email)
      .set('Cookie', `subject=${MARKERS.subject}`)
      .send(MARKERS)
      .expect(200);
    await telemetry.forceFlush();
    const text = allTelemetryText();
    expect(text).toContain('/api/v1/me');
    for (const marker of Object.values(MARKERS)) {
      expect(text).not.toContain(marker);
    }
  });
});
