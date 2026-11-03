// Load before the application so instrumentation patches http, express, and
// pg before they are imported:
//   node --import ./dist/instrument.js dist/index.js
// The container must run that command as its main process, not through pnpm
// or a shell, or SIGTERM never reaches Node.
import { register } from 'node:module';
import { loadTelemetryEnv } from './config/env.ts';
import { createLogger } from './observability/logger.ts';
import {
  resolveTelemetryPlan,
  startTelemetry,
} from './observability/telemetry.ts';

const env = loadTelemetryEnv();

if (resolveTelemetryPlan(env).enabled) {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
}

export const logger = createLogger(env);
export const telemetry = startTelemetry(env, { logger });
