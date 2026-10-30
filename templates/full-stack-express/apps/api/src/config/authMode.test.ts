import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env.ts';

const DATABASE_URL =
  'postgresql://app_user:local-dev-only-password@localhost:5432/project_db';

type Outcome = 'ok' | RegExp;

function outcomeOf(source: Record<string, string | undefined>): string {
  try {
    parseEnv({ DATABASE_URL, ...source });
    return 'ok';
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error.message;
    }
    throw error;
  }
}

describe('AUTH_MODE x NODE_ENV (VT-08, TBI-013 DoD-3)', () => {
  const cases: [string | undefined, string | undefined, Outcome][] = [
    ['development', 'development', 'ok'],
    ['development', 'test', 'ok'],
    [
      'development',
      'production',
      /AUTH_MODE: .*development is not allowed when NODE_ENV is production/,
    ],
    ['external', 'development', 'ok'],
    ['external', 'test', 'ok'],
    ['external', 'production', 'ok'],
    [undefined, 'development', /AUTH_MODE: required but not set/],
    [undefined, 'production', /AUTH_MODE: required but not set/],
    ['Development', 'development', /AUTH_MODE: set but invalid/],
    ['provider', 'production', /AUTH_MODE: set but invalid/],
    ['development', undefined, /NODE_ENV: required but not set/],
    ['development', 'prod', /NODE_ENV: set but invalid/],
    ['development', 'Production', /NODE_ENV: set but invalid/],
  ];

  it.each(cases)(
    'TBI-013 DoD-3 PBI-008 AC-1 AC-2 AUTH_MODE=%s NODE_ENV=%s',
    (authMode, nodeEnv, expected) => {
      const result = outcomeOf({ AUTH_MODE: authMode, NODE_ENV: nodeEnv });
      if (expected === 'ok') {
        expect(result).toBe('ok');
      } else {
        expect(result).toMatch(expected);
        expect(result).not.toContain('local-dev-only-password');
      }
    }
  );
});
