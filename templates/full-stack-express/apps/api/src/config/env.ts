import { formatEnvIssues } from '@project-scope/config/format-env-issues';
import { z } from 'zod';

const PORT_MESSAGE = 'expected an integer from 1 to 65535';
const POSTGRES_URL_MESSAGE = 'expected a postgres or postgresql URL';
const NODE_ENV_MESSAGE = 'expected development, test, or production';
const LOG_LEVEL_MESSAGE =
  'expected fatal, error, warn, info, debug, trace, or silent';
const AUTH_MODE_MESSAGE = 'expected development or external';
const PRODUCTION_AUTH_MESSAGE =
  'development is not allowed when NODE_ENV is production';
const SHUTDOWN_TIMEOUT_MESSAGE = 'expected an integer from 1000 to 120000';
const BOOLEAN_MESSAGE = 'expected true or false';
const SERVICE_NAME_MESSAGE = 'expected a non-empty service name';
const HTTP_URL_MESSAGE = 'expected an http or https URL';
const OTLP_PROTOCOL_MESSAGE = 'expected http/protobuf';
const OTLP_HEADERS_MESSAGE = 'expected comma-separated key=value pairs';
const OTEL_EXPORTER_MESSAGE = 'expected otlp, console, or none';
const POSITIVE_MS_MESSAGE = 'expected a positive integer of milliseconds';

// Endpoints can carry user information and headers carry collector credentials.
const SECRET_NAMES = new Set([
  'DATABASE_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
]);

const OTLP_HEADERS_PATTERN = /^[^=,\s]+\s*=[^,]*(?:,\s*[^=,\s]+\s*=[^,]*)*$/;

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

function unsetBlank(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const portSchema = z.preprocess(
  unsetBlank,
  z.coerce
    .number({ error: PORT_MESSAGE })
    .int({ error: PORT_MESSAGE })
    .min(1, { error: PORT_MESSAGE })
    .max(65535, { error: PORT_MESSAGE })
    .default(3000)
);

const httpUrlSchema = z.preprocess(
  unsetBlank,
  z
    .string({ error: HTTP_URL_MESSAGE })
    .refine(isHttpUrl, { error: HTTP_URL_MESSAGE })
    .optional()
);

const exporterSchema = z.preprocess(
  unsetBlank,
  z
    .enum(['otlp', 'console', 'none'], { error: OTEL_EXPORTER_MESSAGE })
    .optional()
);

const positiveMsSchema = z.preprocess(
  unsetBlank,
  z.coerce
    .number({ error: POSITIVE_MS_MESSAGE })
    .int({ error: POSITIVE_MS_MESSAGE })
    .min(1, { error: POSITIVE_MS_MESSAGE })
    .optional()
);

const telemetryEnvObject = z.object({
  LOG_LEVEL: z.preprocess(
    unsetBlank,
    z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
        error: LOG_LEVEL_MESSAGE,
      })
      .default('info')
  ),
  OTEL_SDK_DISABLED: z.preprocess(
    unsetBlank,
    z
      .enum(['true', 'false'], { error: BOOLEAN_MESSAGE })
      .default('false')
      .transform((value) => value === 'true')
  ),
  OTEL_SERVICE_NAME: z.preprocess(
    unsetBlank,
    z
      .string({ error: SERVICE_NAME_MESSAGE })
      .trim()
      .min(1, { error: SERVICE_NAME_MESSAGE })
      .default('api')
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrlSchema,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: httpUrlSchema,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: httpUrlSchema,
  OTEL_EXPORTER_OTLP_PROTOCOL: z.preprocess(
    unsetBlank,
    z
      .enum(['http/protobuf'], { error: OTLP_PROTOCOL_MESSAGE })
      .default('http/protobuf')
  ),
  OTEL_EXPORTER_OTLP_HEADERS: z.preprocess(
    unsetBlank,
    z
      .string({ error: OTLP_HEADERS_MESSAGE })
      .regex(OTLP_HEADERS_PATTERN, { error: OTLP_HEADERS_MESSAGE })
      .optional()
  ),
  OTEL_EXPORTER_OTLP_TIMEOUT: positiveMsSchema,
  OTEL_TRACES_EXPORTER: exporterSchema,
  OTEL_METRICS_EXPORTER: exporterSchema,
  OTEL_METRIC_EXPORT_INTERVAL: positiveMsSchema,
  OTEL_BSP_SCHEDULE_DELAY: positiveMsSchema,
});

const envObject = z.object({
  NODE_ENV: z.preprocess(
    unsetBlank,
    z.enum(['development', 'test', 'production'], { error: NODE_ENV_MESSAGE })
  ),
  PORT: portSchema,
  DATABASE_URL: z.preprocess(
    unsetBlank,
    z
      .string({ error: POSTGRES_URL_MESSAGE })
      .refine(isPostgresUrl, { error: POSTGRES_URL_MESSAGE })
  ),
  AUTH_MODE: z.preprocess(
    unsetBlank,
    z.enum(['development', 'external'], { error: AUTH_MODE_MESSAGE })
  ),
  SHUTDOWN_TIMEOUT_MS: z.preprocess(
    unsetBlank,
    z.coerce
      .number({ error: SHUTDOWN_TIMEOUT_MESSAGE })
      .int({ error: SHUTDOWN_TIMEOUT_MESSAGE })
      .min(1000, { error: SHUTDOWN_TIMEOUT_MESSAGE })
      .max(120000, { error: SHUTDOWN_TIMEOUT_MESSAGE })
      .default(25000)
  ),
  ...telemetryEnvObject.shape,
});

export const envSchema = envObject.superRefine((value, ctx) => {
  if (value.NODE_ENV === 'production' && value.AUTH_MODE === 'development') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message: PRODUCTION_AUTH_MESSAGE,
    });
  }
});

// Zod refuses pick() on a schema that already has a refinement. Migrations read
// only these two fields, so the production authentication check stays on envSchema.
export const databaseEnvSchema = envObject.pick({
  NODE_ENV: true,
  DATABASE_URL: true,
});

// instrument.ts runs before the application and reads only this fragment.
export const telemetryEnvSchema = telemetryEnvObject;

export const API_ENV_KEYS = Object.keys(envObject.shape).sort();

export type Env = z.infer<typeof envSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type TelemetryEnv = z.infer<typeof telemetryEnvSchema>;

function parseWith<T>(schema: z.ZodType<T>, source: object): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      formatEnvIssues(result.error.issues, source, SECRET_NAMES)
    );
  }
  return result.data;
}

export interface DatabaseEnvProblem {
  name: keyof DatabaseEnv;
  reason: 'missing' | 'invalid';
}

export type DatabaseEnvResult =
  | { ok: true; env: DatabaseEnv }
  | { ok: false; problems: DatabaseEnvProblem[] };

function isSet(source: object, key: string): boolean {
  const value: unknown = (source as Record<string, unknown>)[key];
  return value !== undefined && value !== '';
}

// The migrate and seed commands read only these two variables. Problems carry
// a name and a reason, never the received value.
export function readDatabaseEnv(
  source: object = process.env
): DatabaseEnvResult {
  const result = databaseEnvSchema.safeParse(source);
  if (result.success) {
    return { ok: true, env: result.data };
  }
  const names = new Set<keyof DatabaseEnv>();
  for (const issue of result.error.issues) {
    const head = issue.path[0];
    if (head === 'NODE_ENV' || head === 'DATABASE_URL') {
      names.add(head);
    }
  }
  return {
    ok: false,
    problems: [...names].sort().map((name) => ({
      name,
      reason: isSet(source, name) ? 'invalid' : 'missing',
    })),
  };
}

function loadWith<T>(parse: (source: object) => T, source: object): T {
  try {
    return parse(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

export function parseEnv(source: object): Env {
  return parseWith(envSchema, source);
}

export function parseTelemetryEnv(source: object): TelemetryEnv {
  return parseWith(telemetryEnvSchema, source);
}

export function loadEnv(source: object = process.env): Env {
  return loadWith(parseEnv, source);
}

export function loadTelemetryEnv(source: object = process.env): TelemetryEnv {
  return loadWith(parseTelemetryEnv, source);
}
