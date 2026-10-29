import { describe, expect, it } from 'vitest';
import { createLogger } from '../observability/logger.ts';
import { captureLogs } from '../observability/testing/captureLogs.ts';
import {
  createDevelopmentAdapter,
  DEVELOPMENT_PRINCIPAL,
} from './developmentAdapter.ts';
import { DevelopmentAdapterInProductionError } from './errors.ts';
import { principalSchema } from './principal.ts';

function silentLogger() {
  return createLogger({ LOG_LEVEL: 'silent' }, captureLogs().stream);
}

describe('createDevelopmentAdapter (VT-11)', () => {
  it('TBI-013 DoD-1 refuses to build when NODE_ENV is production', () => {
    expect(() =>
      createDevelopmentAdapter({
        nodeEnv: 'production',
        logger: silentLogger(),
      })
    ).toThrow(DevelopmentAdapterInProductionError);
  });

  it('TBI-013 DoD-0 returns the same frozen synthetic principal for any request', async () => {
    const adapter = createDevelopmentAdapter({
      nodeEnv: 'development',
      logger: silentLogger(),
    });
    const results = await Promise.all([
      adapter.authenticate({ headers: {} }),
      adapter.authenticate({ headers: { authorization: 'Bearer x' } }),
      adapter.authenticate({
        headers: { 'x-user': 'other', 'x-subject': 'y' },
      }),
    ]);
    for (const result of results) {
      expect(result).toBe(DEVELOPMENT_PRINCIPAL);
    }
    expect(Object.isFrozen(DEVELOPMENT_PRINCIPAL)).toBe(true);
    expect(principalSchema.safeParse(DEVELOPMENT_PRINCIPAL).success).toBe(true);
    expect(DEVELOPMENT_PRINCIPAL).toEqual({
      subject: 'synthetic-dev-subject',
      displayName: 'Synthetic Developer',
      email: 'synthetic.developer@example.invalid',
    });
    expect(DEVELOPMENT_PRINCIPAL.email?.endsWith('.invalid')).toBe(true);
  });

  it('builds under NODE_ENV=test', () => {
    expect(() =>
      createDevelopmentAdapter({ nodeEnv: 'test', logger: silentLogger() })
    ).not.toThrow();
  });
});

describe('development adapter startup warning (VT-14)', () => {
  it('TBI-013 logs exactly one warning with no identity values', () => {
    const capture = captureLogs();
    const logger = createLogger({ LOG_LEVEL: 'debug' }, capture.stream);
    createDevelopmentAdapter({ nodeEnv: 'development', logger });

    const lines = capture.lines();
    const warnings = lines.filter(
      (line) => line.event === 'auth.development_adapter_active'
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('warn');
    const output = capture.raw().join('\n');
    for (const value of Object.values(DEVELOPMENT_PRINCIPAL)) {
      expect(output).not.toContain(value);
    }
  });
});
