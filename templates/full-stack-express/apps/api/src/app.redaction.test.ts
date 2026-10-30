import {
  AggregationTemporality,
  InMemoryMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTelemetryEnv } from './config/env.ts';
import type { Principal } from './identity/principal.ts';
import {
  startTelemetry,
  type TelemetryHandle,
} from './observability/telemetry.ts';

const MARKERS = {
  subject: 'log-span-subject-3x7',
  displayName: 'Log Marker Person 3X7',
  email: 'log.marker.3x7@example.test',
  token: 'log-span-token-3x7',
};

const PRINCIPAL: Principal = Object.freeze({
  subject: MARKERS.subject,
  displayName: MARKERS.displayName,
  email: MARKERS.email,
});

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

function telemetryText(): string {
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

describe('identity values in logs and telemetry', () => {
  it('VT-29 TBI-016 DoD-2 PBI-013 AC-3 keeps subject, name, email, and token out of logs, spans, and metrics across the profile flows', async () => {
    // Loaded after the SDK starts, the order instrument.ts enforces.
    const { default: request } = await import('supertest');
    const { buildTestApp, settle } = await import('../test/support/testApp.ts');
    const auth = `Bearer ${MARKERS.token}`;

    const seeded = buildTestApp({ principal: PRINCIPAL });
    seeded.persistence.seed({
      externalSubject: MARKERS.subject,
      displayName: MARKERS.displayName,
      email: MARKERS.email,
    });
    await request(seeded.app)
      .get('/api/v1/me')
      .set('Authorization', auth)
      .expect(200);

    const fresh = buildTestApp({ principal: PRINCIPAL });
    await request(fresh.app)
      .get('/api/v1/me')
      .set('Authorization', auth)
      .expect(200);
    await request(fresh.app)
      .put('/api/v1/me')
      .set('Authorization', auth)
      .send({ displayName: MARKERS.displayName, email: MARKERS.email })
      .expect(200);
    await request(fresh.app)
      .put('/api/v1/me')
      .set('Authorization', auth)
      .send({ displayName: '', email: `not-an-email ${MARKERS.email}` })
      .expect(400);
    await request(fresh.app)
      .put('/api/v1/me')
      .set('Authorization', auth)
      .send({ displayName: MARKERS.displayName, subject: MARKERS.subject })
      .expect(400);

    await settle();
    await telemetry.forceFlush();

    const logText = [...seeded.capture.raw(), ...fresh.capture.raw()].join(
      '\n'
    );
    const spanText = telemetryText();
    expect(logText).toContain('/api/v1/me');
    expect(spanText).toContain('/api/v1/me');
    for (const marker of Object.values(MARKERS)) {
      expect(logText).not.toContain(marker);
      expect(spanText).not.toContain(marker);
    }
  });
});
