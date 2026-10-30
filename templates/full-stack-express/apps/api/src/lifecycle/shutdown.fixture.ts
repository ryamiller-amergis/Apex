// Process-level fixture for shutdown.process.test.ts. Start it the way
// production starts the API:
//   node --import ./src/instrument.ts src/lifecycle/shutdown.fixture.ts
import type { AddressInfo } from 'node:net';
import express from 'express';
import { loadEnv } from '../config/env.ts';
import { logger, telemetry } from '../instrument.ts';
import { errorLogging } from '../observability/errorLogging.ts';
import { requestId } from '../observability/requestId.ts';
import { requestLogging } from '../observability/requestLogging.ts';
import { createInFlightRegistry } from './inFlight.ts';
import {
  createShutdown,
  registerSignalHandlers,
  type ClosableResource,
  type Lifecycle,
} from './shutdown.ts';

const env = loadEnv();
const inFlight = createInFlightRegistry();

const app = express();
app.use(requestId());
app.use(requestLogging(logger));
app.use(inFlight.middleware);
app.get('/slow', (req, res) => {
  const ms = Number(req.query.ms ?? 500);
  setTimeout(() => res.json({ ok: true }), ms);
});
app.get('/hang', () => {});
app.get('/probe', (_req, res) => {
  if (lifecycle.isShuttingDown()) {
    res.status(503).json({ status: 'not_ready' });
    return;
  }
  res.json({ status: 'ready' });
});
app.use(errorLogging(logger));

const database: ClosableResource = {
  name: 'database',
  async close() {
    logger.info({}, 'database.closed');
  },
};

const server = app.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  logger.info({ port }, 'fixture.listening');
});

const lifecycle: Lifecycle = createShutdown({
  server,
  inFlight,
  resources: [database],
  telemetry,
  logger,
  exit: (code) => process.exit(code),
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});
registerSignalHandlers(lifecycle);
