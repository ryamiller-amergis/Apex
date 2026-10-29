import { describe, expect, it, vi } from 'vitest';
import {
  baseEnv,
  gracefulExitCode,
  runApi,
} from '../../test/support/apiProcess.ts';
import { parseEnv } from '../config/env.ts';
import { createLocalFlagEvaluator } from './index.ts';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL:
    'postgresql://app_user:local-dev-only-password@localhost:5432/project_db',
  AUTH_MODE: 'development',
};

function runApiWith(extra: Record<string, string>) {
  return runApi({ ...baseEnv(), ...valid, ...extra });
}

describe('FEATURE_FLAGS configuration', () => {
  it.each([
    ['absent', undefined, undefined],
    ['empty', '', undefined],
    ['an empty object', '{}', '{}'],
    ['malformed', '{not json', '{not json'],
  ])(
    'VT-09 TBI-019 DoD-1 PBI-016 AC-1 passes environment validation when %s',
    (_label, value, expected) => {
      const env = parseEnv({ ...valid, FEATURE_FLAGS: value });
      expect(env.FEATURE_FLAGS).toBe(expected);
    }
  );

  it('VT-09 TBI-019 DoD-1 the local adapter reads its values from typed configuration', () => {
    const env = parseEnv({
      ...valid,
      FEATURE_FLAGS: '{"checkout-v2":true,"beta-banner":false}',
    });
    const flags = createLocalFlagEvaluator({
      source: env.FEATURE_FLAGS,
      logger: { warn: vi.fn() },
    });
    expect(flags.isEnabled('checkout-v2', false)).toBe(true);
    expect(flags.isEnabled('beta-banner', true)).toBe(false);
  });

  it('VT-09 PBI-016 AC-1 the API starts with a malformed value and logs one redacted warning', async () => {
    const raw = '{"alice@example.test":true';
    const result = await runApiWith({ FEATURE_FLAGS: raw });
    expect(result.listened).toBe(true);
    expect(result.status).toBe(gracefulExitCode);
    expect(result.output).not.toContain('Invalid environment configuration');
    expect(result.output.match(/feature_flags\.config_invalid/g)).toHaveLength(
      1
    );
    expect(result.output).toContain('FEATURE_FLAGS');
    expect(result.output).not.toContain('alice');
    expect(result.output).not.toContain(raw);
  }, 20000);

  it('VT-09 PBI-016 AC-2 the API starts silently with a valid value', async () => {
    const result = await runApiWith({ FEATURE_FLAGS: '{"checkout-v2":true}' });
    expect(result.listened).toBe(true);
    expect(result.status).toBe(gracefulExitCode);
    expect(result.output).not.toContain('feature_flags.config_invalid');
  }, 20000);
});
