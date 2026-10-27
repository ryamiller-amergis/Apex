import { describe, expect, it } from 'vitest';
import {
  API_ENV_KEYS,
  databaseEnvSchema,
  EnvValidationError,
  parseEnv,
  parseTelemetryEnv,
  readDatabaseEnv,
  telemetryEnvSchema,
} from './env.ts';

const DATABASE_URL =
  'postgresql://app_user:local-dev-only-password@localhost:5432/project_db';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL,
  AUTH_MODE: 'development',
};

function messageOf(source: object): string {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected parseEnv to throw');
}

describe('parseEnv', () => {
  it('VT-01 PBI-002 AC-0 TBI-004 DoD-3 applies PORT and LOG_LEVEL defaults', () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe('test');
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
    expect(env.AUTH_MODE).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('VT-01 keeps a full environment', () => {
    const env = parseEnv({
      ...valid,
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      AUTH_MODE: 'external',
    });
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'debug',
      AUTH_MODE: 'external',
    });
  });

  it('VT-02 PBI-002 AC-1 TBI-004 DoD-0 names each missing required variable', () => {
    for (const key of ['NODE_ENV', 'DATABASE_URL', 'AUTH_MODE'] as const) {
      const source = { ...valid, [key]: undefined };
      const message = messageOf(source);
      expect(message).toContain(`${key}: required but not set`);
    }
  });

  it('VT-02 names every missing required variable in one message', () => {
    const message = messageOf({});
    expect(message).toContain('NODE_ENV: required but not set');
    expect(message).toContain('DATABASE_URL: required but not set');
    expect(message).toContain('AUTH_MODE: required but not set');
    expect(message).toContain(
      'Invalid environment configuration (3 problems):'
    );
  });

  it('VT-03 TBI-004 DoD-0 names each malformed variable on its own line', () => {
    const message = messageOf({
      NODE_ENV: 'staging',
      PORT: 'abc',
      LOG_LEVEL: 'loud',
      DATABASE_URL: 'http://host/db',
      AUTH_MODE: 'saml',
    });
    for (const name of [
      'NODE_ENV',
      'PORT',
      'LOG_LEVEL',
      'DATABASE_URL',
      'AUTH_MODE',
    ]) {
      expect(message).toContain(`${name}:`);
    }
    expect(message).toContain(
      'PORT: set but invalid (expected an integer from 1 to 65535)'
    );
    expect(message).toContain('DATABASE_URL: set but invalid (value hidden)');
    expect(message).not.toContain('http://host/db');
  });

  it.each(['0', '65536', '3000.5'])('VT-03 rejects PORT %s', (port) => {
    const message = messageOf({ ...valid, PORT: port });
    expect(message).toContain(
      'PORT: set but invalid (expected an integer from 1 to 65535)'
    );
  });

  it('VT-03 accepts PORT bounds 1 and 65535', () => {
    expect(parseEnv({ ...valid, PORT: '1' }).PORT).toBe(1);
    expect(parseEnv({ ...valid, PORT: '65535' }).PORT).toBe(65535);
  });

  it('VT-04 PBI-002 AC-1 never prints a sentinel or a secret', () => {
    const sentinel = 'SENTINEL_VALUE_123';
    const cases: object[] = [
      { ...valid, NODE_ENV: sentinel },
      { ...valid, PORT: sentinel },
      { ...valid, LOG_LEVEL: sentinel },
      { ...valid, AUTH_MODE: sentinel },
      { ...valid, DATABASE_URL: `http://user:${sentinel}@host/db` },
      { ...valid, DATABASE_URL: `not-a-url-${sentinel}` },
    ];
    for (const source of cases) {
      const message = messageOf(source);
      expect(message).not.toContain(sentinel);
    }
    const hidden = messageOf({
      ...valid,
      DATABASE_URL: `http://user:${sentinel}@host/db`,
    });
    expect(hidden).toContain('DATABASE_URL: set but invalid (value hidden)');
  });

  it('VT-05 treats empty strings as unset', () => {
    const env = parseEnv({ ...valid, PORT: '', LOG_LEVEL: '' });
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    const message = messageOf({ ...valid, DATABASE_URL: '' });
    expect(message).toContain('DATABASE_URL: required but not set');
    expect(message).not.toContain('value hidden');
  });

  it('VT-06 TBI-004 DoD-0 rejects development auth in production', () => {
    const message = messageOf({
      ...valid,
      NODE_ENV: 'production',
      AUTH_MODE: 'development',
    });
    expect(message).toContain('AUTH_MODE:');
    expect(message).toContain(
      'development is not allowed when NODE_ENV is production'
    );
    const env = parseEnv({ ...valid, NODE_ENV: 'development' });
    expect(env.AUTH_MODE).toBe('development');
    const external = parseEnv({
      ...valid,
      NODE_ENV: 'production',
      AUTH_MODE: 'external',
    });
    expect(external.AUTH_MODE).toBe('external');
  });

  it('databaseEnvSchema reads only NODE_ENV and DATABASE_URL', () => {
    const parsed = databaseEnvSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL,
    });
    expect(parsed).toEqual({ NODE_ENV: 'test', DATABASE_URL });
    expect(API_ENV_KEYS).toEqual([
      'AUTH_MODE',
      'DATABASE_URL',
      'FEATURE_FLAGS',
      'LOG_LEVEL',
      'NODE_ENV',
      'OTEL_BSP_SCHEDULE_DELAY',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_TIMEOUT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_METRICS_EXPORTER',
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_SDK_DISABLED',
      'OTEL_SERVICE_NAME',
      'OTEL_TRACES_EXPORTER',
      'PORT',
      'SHUTDOWN_TIMEOUT_MS',
    ]);
  });
});

describe('observability and shutdown settings', () => {
  const HEADER_SECRET = 'MARKER_SECRET_HEADER_VALUE';

  it('VT-01 TBI-016 DoD-3 TBI-017 TBI-018 applies defaults with only required values', () => {
    const env = parseEnv(valid);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(25000);
    expect(env.OTEL_SDK_DISABLED).toBe(false);
    expect(env.OTEL_SERVICE_NAME).toBe('api');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    expect(env.OTEL_TRACES_EXPORTER).toBeUndefined();
    expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();
    expect(env.OTEL_METRIC_EXPORT_INTERVAL).toBeUndefined();
    expect(env.OTEL_BSP_SCHEDULE_DELAY).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_TIMEOUT).toBeUndefined();
  });

  it('VT-01 treats empty strings as unset for every new variable', () => {
    const env = parseEnv({
      ...valid,
      SHUTDOWN_TIMEOUT_MS: '',
      OTEL_SDK_DISABLED: '',
      OTEL_SERVICE_NAME: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_PROTOCOL: '',
      OTEL_EXPORTER_OTLP_HEADERS: '',
      OTEL_TRACES_EXPORTER: '',
      OTEL_METRICS_EXPORTER: '',
      OTEL_METRIC_EXPORT_INTERVAL: '',
      OTEL_BSP_SCHEDULE_DELAY: '',
    });
    expect(env.SHUTDOWN_TIMEOUT_MS).toBe(25000);
    expect(env.OTEL_SDK_DISABLED).toBe(false);
    expect(env.OTEL_SERVICE_NAME).toBe('api');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('VT-01 parses valid explicit values', () => {
    const env = parseEnv({
      ...valid,
      LOG_LEVEL: 'warn',
      SHUTDOWN_TIMEOUT_MS: '1500',
      OTEL_SDK_DISABLED: 'true',
      OTEL_SERVICE_NAME: 'project-service',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example/v1/metrics',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer abc,x-tenant=one',
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_METRIC_EXPORT_INTERVAL: '300',
      OTEL_BSP_SCHEDULE_DELAY: '100',
      OTEL_EXPORTER_OTLP_TIMEOUT: '2000',
    });
    expect(env).toMatchObject({
      OTEL_EXPORTER_OTLP_TIMEOUT: 2000,
      LOG_LEVEL: 'warn',
      SHUTDOWN_TIMEOUT_MS: 1500,
      OTEL_SDK_DISABLED: true,
      OTEL_SERVICE_NAME: 'project-service',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.example/v1/metrics',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer abc,x-tenant=one',
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_METRIC_EXPORT_INTERVAL: 300,
      OTEL_BSP_SCHEDULE_DELAY: 100,
    });
    expect(parseEnv({ ...valid, OTEL_SDK_DISABLED: 'false' })).toMatchObject({
      OTEL_SDK_DISABLED: false,
    });
  });

  it('VT-01 accepts SHUTDOWN_TIMEOUT_MS bounds 1000 and 120000', () => {
    expect(
      parseEnv({ ...valid, SHUTDOWN_TIMEOUT_MS: '1000' }).SHUTDOWN_TIMEOUT_MS
    ).toBe(1000);
    expect(
      parseEnv({ ...valid, SHUTDOWN_TIMEOUT_MS: '120000' }).SHUTDOWN_TIMEOUT_MS
    ).toBe(120000);
  });

  it('VT-02 TBI-016 TBI-017 TBI-018 names each malformed variable and hides the header secret', () => {
    const message = messageOf({
      ...valid,
      LOG_LEVEL: 'loud',
      SHUTDOWN_TIMEOUT_MS: 'abc',
      OTEL_SDK_DISABLED: 'yes',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
      OTEL_EXPORTER_OTLP_HEADERS: `${HEADER_SECRET}`,
      OTEL_TRACES_EXPORTER: 'zipkin',
      OTEL_METRICS_EXPORTER: 'prometheus',
      OTEL_METRIC_EXPORT_INTERVAL: '-5',
      OTEL_BSP_SCHEDULE_DELAY: '1.5',
      OTEL_EXPORTER_OTLP_TIMEOUT: '0',
    });
    for (const name of [
      'OTEL_EXPORTER_OTLP_TIMEOUT',
      'LOG_LEVEL',
      'SHUTDOWN_TIMEOUT_MS',
      'OTEL_SDK_DISABLED',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_TRACES_EXPORTER',
      'OTEL_METRICS_EXPORTER',
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_BSP_SCHEDULE_DELAY',
    ]) {
      expect(message).toContain(`${name}:`);
    }
    expect(message).toContain(
      'SHUTDOWN_TIMEOUT_MS: set but invalid (expected an integer from 1000 to 120000)'
    );
    expect(message).toContain(
      'OTEL_TRACES_EXPORTER: set but invalid (expected otlp, console, or none)'
    );
    expect(message).toContain(
      'OTEL_EXPORTER_OTLP_HEADERS: set but invalid (value hidden)'
    );
    expect(message).toContain(
      'OTEL_EXPORTER_OTLP_ENDPOINT: set but invalid (value hidden)'
    );
    expect(message).not.toContain(HEADER_SECRET);
    expect(message).not.toContain('not-a-url');
    expect(message).not.toContain('zipkin');
  });

  it.each(['999', '120001', '2000.5'])(
    'VT-02 rejects SHUTDOWN_TIMEOUT_MS %s',
    (value) => {
      expect(messageOf({ ...valid, SHUTDOWN_TIMEOUT_MS: value })).toContain(
        'SHUTDOWN_TIMEOUT_MS: set but invalid (expected an integer from 1000 to 120000)'
      );
    }
  );

  it('VT-02 PBI-014 never prints endpoint credentials', () => {
    const endpoint = `https://user:${HEADER_SECRET}@collector.example/v1/traces`;
    const message = messageOf({
      ...valid,
      NODE_ENV: undefined,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_HEADERS: `authorization=${HEADER_SECRET}`,
    });
    expect(message).toContain('NODE_ENV: required but not set');
    expect(message).not.toContain(HEADER_SECRET);
    expect(
      messageOf({ ...valid, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'ftp://x' })
    ).toContain('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: set but invalid');
  });

  it('telemetryEnvSchema reads only LOG_LEVEL and the OTEL_* settings', () => {
    const env = parseTelemetryEnv({
      LOG_LEVEL: 'debug',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    });
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
    expect(Object.keys(telemetryEnvSchema.shape).sort()).toEqual(
      API_ENV_KEYS.filter(
        (key) => key === 'LOG_LEVEL' || key.startsWith('OTEL_')
      )
    );
    expect(() => parseTelemetryEnv({ OTEL_TRACES_EXPORTER: 'zipkin' })).toThrow(
      EnvValidationError
    );
  });
});

describe('readDatabaseEnv', () => {
  it('returns NODE_ENV and DATABASE_URL and ignores the other variables', () => {
    expect(readDatabaseEnv({ NODE_ENV: 'test', DATABASE_URL })).toEqual({
      ok: true,
      env: { NODE_ENV: 'test', DATABASE_URL },
    });
  });

  it('VT-13 PBI-004 AC-3 reports DATABASE_URL as missing when unset or blank', () => {
    for (const value of [undefined, '']) {
      expect(
        readDatabaseEnv({ NODE_ENV: 'production', DATABASE_URL: value })
      ).toEqual({
        ok: false,
        problems: [{ name: 'DATABASE_URL', reason: 'missing' }],
      });
    }
  });

  it('VT-14 PBI-004 AC-3 reports a malformed DATABASE_URL without its value', () => {
    const sentinel = 'sentinel-password-123';
    const result = readDatabaseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: `mysql://user:${sentinel}@host/db`,
    });
    expect(result).toEqual({
      ok: false,
      problems: [{ name: 'DATABASE_URL', reason: 'invalid' }],
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('reports both variables in name order', () => {
    expect(readDatabaseEnv({ NODE_ENV: 'staging' })).toEqual({
      ok: false,
      problems: [
        { name: 'DATABASE_URL', reason: 'missing' },
        { name: 'NODE_ENV', reason: 'invalid' },
      ],
    });
  });
});
