import { describe, expect, it } from 'vitest';
import {
  API_ENV_KEYS,
  databaseEnvSchema,
  EnvValidationError,
  parseEnv,
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
      'LOG_LEVEL',
      'NODE_ENV',
      'PORT',
    ]);
  });
});
