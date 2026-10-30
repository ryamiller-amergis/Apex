import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTelemetryEnv } from '../config/env.ts';
import { createLogger } from './logger.ts';
import { captureLogs } from './testing/captureLogs.ts';
import { closedPort, ServerPool } from './testing/network.ts';
import { startTelemetry, type TelemetryHandle } from './telemetry.ts';

const HEADER_SECRET = 'MARKER_EXPORT_SECRET';
const IDENTITY = 'export.marker@example.test';

const pool = new ServerPool();
let telemetry: TelemetryHandle | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  await pool.closeAll();
});

describe('OTLP export to an unreachable endpoint', () => {
  it('VT-15 PBI-014 AC-1 keeps serving and logs one failure per signal per window', async () => {
    const port = await closedPort();
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'info' }, capture.stream);
    telemetry = startTelemetry(
      parseTelemetryEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=${HEADER_SECRET}`,
        OTEL_METRIC_EXPORT_INTERVAL: '200',
        OTEL_BSP_SCHEDULE_DELAY: '50',
        OTEL_EXPORTER_OTLP_TIMEOUT: '200',
      }),
      { logger }
    );
    const { default: express } = await import('express');
    const app = express();
    app.get('/items', (_req, res) => {
      res.json({ ok: true, email: IDENTITY });
    });
    const appPort = await pool.listen(createServer(app));
    const failuresFor = (signal: string) =>
      capture
        .lines()
        .filter(
          (line) =>
            line.msg === 'telemetry.export_failed' && line.signal === signal
        );
    const deadline = Date.now() + 8000;
    let requests = 0;
    while (
      (failuresFor('traces').length === 0 ||
        failuresFor('metrics').length === 0 ||
        requests < 10) &&
      Date.now() < deadline
    ) {
      const response = await fetch(`http://127.0.0.1:${appPort}/items`);
      expect(response.status).toBe(200);
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(failuresFor('traces')).toHaveLength(1);
    expect(failuresFor('metrics')).toHaveLength(1);
    expect(failuresFor('traces')[0]).toMatchObject({
      level: 'warn',
      err: { message: expect.stringContaining('ECONNREFUSED') },
    });
    const text = capture.raw().join('\n');
    expect(text).not.toContain(HEADER_SECRET);
    expect(text).not.toContain(IDENTITY);
  }, 20000);
});
