import { describe, expect, it } from 'vitest';
import {
  EnvValidationError,
  parseDevServerEnv,
  parseWebEnv,
  WEB_ENV_KEYS,
} from './webEnvSchema';

function messageOf(source: object): string {
  try {
    parseWebEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected parseWebEnv to throw');
}

describe('webEnvSchema', () => {
  it('VT-08 TBI-004 DoD-2 DoD-3 parses a valid web environment with defaults', () => {
    expect(parseWebEnv({})).toEqual({
      VITE_APP_NAME: 'project-name',
      VITE_API_BASE_URL: '',
    });
    expect(WEB_ENV_KEYS).toEqual(['VITE_API_BASE_URL', 'VITE_APP_NAME']);
  });

  it('VT-08 accepts an absolute API base URL without a trailing slash', () => {
    expect(
      parseWebEnv({
        VITE_APP_NAME: 'Acme',
        VITE_API_BASE_URL: 'https://example.com',
      })
    ).toEqual({
      VITE_APP_NAME: 'Acme',
      VITE_API_BASE_URL: 'https://example.com',
    });
  });

  it('VT-08 names a malformed VITE_API_BASE_URL and hides the value', () => {
    const sentinel = 'SENTINEL_VALUE_123';
    const message = messageOf({
      VITE_API_BASE_URL: `https://${sentinel}.example/`,
    });
    expect(message).toContain('VITE_API_BASE_URL:');
    expect(message).toContain(
      'expected an empty value or an absolute http(s) URL with no trailing slash'
    );
    expect(message).not.toContain(sentinel);
  });

  it('VT-08 rejects an over-length VITE_APP_NAME', () => {
    const message = messageOf({ VITE_APP_NAME: 'a'.repeat(61) });
    expect(message).toContain('VITE_APP_NAME:');
    expect(message).toContain('expected 1 to 60 characters');
  });

  it('VT-08 TBI-004 DoD-2 rejects a key that is not a web build variable', () => {
    const sentinel = 'SENTINEL_VALUE_123';
    const message = messageOf({ DATABASE_URL: sentinel });
    expect(message).toContain('DATABASE_URL:');
    expect(message).toContain('not a web build variable');
    expect(message).not.toContain(sentinel);
  });

  it('dev-server PORT defaults to 3000 and never echoes an invalid value', () => {
    expect(parseDevServerEnv({}).PORT).toBe(3000);
    const sentinel = 'SENTINEL_VALUE_123';
    expect(() => parseDevServerEnv({ PORT: sentinel })).toThrow(
      EnvValidationError
    );
    try {
      parseDevServerEnv({ PORT: sentinel });
    } catch (error) {
      if (!(error instanceof EnvValidationError)) {
        throw error;
      }
      expect(error.message).toContain('PORT:');
      expect(error.message).not.toContain(sentinel);
    }
  });
});
