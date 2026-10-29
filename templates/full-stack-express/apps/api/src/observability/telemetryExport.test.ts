import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTelemetryEnv } from '../config/env.ts';
import { ServerPool, startCollector, waitFor } from './testing/network.ts';
import { startTelemetry, type TelemetryHandle } from './telemetry.ts';

const HEADER_SECRET = 'MARKER_EXPORT_SECRET';

const pool = new ServerPool();
let telemetry: TelemetryHandle | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  await pool.closeAll();
});

describe('OTLP export', () => {
  it('VT-14 PBI-014 AC-0 TBI-017 DoD-1 sends protobuf traces and metrics to the configured endpoint', async () => {
    const collector = await startCollector(pool);
    telemetry = startTelemetry(
      parseTelemetryEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=${HEADER_SECRET}`,
        OTEL_METRIC_EXPORT_INTERVAL: '300',
        OTEL_BSP_SCHEDULE_DELAY: '100',
      })
    );
    const { default: express } = await import('express');
    const app = express();
    app.get('/items', (_req, res) => {
      res.json({ ok: true });
    });
    const appPort = await pool.listen(createServer(app));
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`http://127.0.0.1:${appPort}/items`);
      expect(response.status).toBe(200);
    }
    await waitFor(
      () =>
        collector.received.some((r) => r.path === '/v1/traces') &&
        collector.received.some((r) => r.path === '/v1/metrics'),
      5000
    );
    for (const path of ['/v1/traces', '/v1/metrics']) {
      const hit = collector.received.find((r) => r.path === path);
      expect(hit?.contentType).toBe('application/x-protobuf');
      expect(hit?.authorization).toBe(HEADER_SECRET);
    }
  });
});
