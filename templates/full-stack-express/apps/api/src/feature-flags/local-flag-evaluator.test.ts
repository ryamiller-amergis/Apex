import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createLocalFlagEvaluator,
  type FlagEvaluator,
  type FlagLogger,
} from './index.ts';

function fakeLogger() {
  const warn = vi.fn<FlagLogger['warn']>();
  return { logger: { warn } satisfies FlagLogger, warn };
}

// Stands in for a call site: read the flag once at the entry point, branch once.
function checkoutBehavior(flags: FlagEvaluator): 'new' | 'existing' {
  return flags.isEnabled('checkout-v2', false) ? 'new' : 'existing';
}

describe('createLocalFlagEvaluator', () => {
  it('VT-01 PBI-016 AC-0 TBI-019 DoD-0 DoD-3 returns true for a flag set on and runs the gated branch', () => {
    const { logger, warn } = fakeLogger();
    const flags = createLocalFlagEvaluator({
      source: '{"checkout-v2":true}',
      logger,
    });

    expect(flags.isEnabled('checkout-v2', false)).toBe(true);
    expect(checkoutBehavior(flags)).toBe('new');
    expect(warn).not.toHaveBeenCalled();
  });

  it('VT-02 TBI-019 DoD-0 DoD-3 returns false for a flag set off, over a default of true', () => {
    const { logger } = fakeLogger();
    const flags = createLocalFlagEvaluator({
      source: '{"checkout-v2":false}',
      logger,
    });

    expect(flags.isEnabled('checkout-v2', true)).toBe(false);
    expect(checkoutBehavior(flags)).toBe('existing');
  });

  it('VT-03 PBI-016 AC-2 TBI-019 DoD-0 DoD-3 returns the declared default for an unknown flag', () => {
    const { logger, warn } = fakeLogger();
    const flags = createLocalFlagEvaluator({
      source: '{"other-flag":true}',
      logger,
    });

    expect(() => flags.isEnabled('checkout-v2', false)).not.toThrow();
    expect(flags.isEnabled('checkout-v2', false)).toBe(false);
    expect(flags.isEnabled('checkout-v2', true)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('VT-03 PBI-016 AC-2 returns the default for a non-string name from untyped code', () => {
    const { logger } = fakeLogger();
    const flags = createLocalFlagEvaluator({
      source: '{"checkout-v2":true}',
      logger,
    });
    const untyped = flags.isEnabled as (
      name: unknown,
      value: boolean
    ) => boolean;

    expect(untyped(undefined, true)).toBe(true);
    expect(untyped(42, false)).toBe(false);
    expect(flags.isEnabled('__proto__', false)).toBe(false);
    expect(flags.isEnabled('constructor', true)).toBe(true);
  });

  it('VT-04 PBI-016 AC-1 returns the default and logs once when the value is not JSON', () => {
    const { logger, warn } = fakeLogger();
    let flags: FlagEvaluator | undefined;

    expect(() => {
      flags = createLocalFlagEvaluator({ source: '{not json', logger });
    }).not.toThrow();
    expect(flags?.isEnabled('checkout-v2', true)).toBe(true);
    expect(flags?.isEnabled('checkout-v2', false)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'feature_flags.config_invalid',
      variable: 'FEATURE_FLAGS',
      reason: 'invalid_json',
    });
    expect(warn.mock.calls[0]?.[1]).toEqual(expect.any(String));
  });

  it.each([
    ['an array', '[true]'],
    ['a JSON string', '"true"'],
    ['a JSON null', 'null'],
    ['a string value', '{"valid-flag":true,"checkout-v2":"yes"}'],
    ['a number value', '{"valid-flag":true,"checkout-v2":1}'],
    ['a non-kebab key', '{"valid-flag":true,"Bad_Key":true}'],
    ['a prototype key', '{"valid-flag":true,"__proto__":true}'],
  ])(
    'VT-05 PBI-016 AC-1 rejects the whole value when it holds %s',
    (_label, source) => {
      const { logger, warn } = fakeLogger();
      const flags = createLocalFlagEvaluator({ source, logger });

      expect(flags.isEnabled('checkout-v2', false)).toBe(false);
      expect(flags.isEnabled('valid-flag', false)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toEqual({
        event: 'feature_flags.config_invalid',
        variable: 'FEATURE_FLAGS',
        reason: 'invalid_shape',
      });
    }
  );

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])(
    'VT-06 PBI-016 AC-2 treats an %s source as no flags and logs nothing',
    (_label, source) => {
      const { logger, warn } = fakeLogger();
      const flags = createLocalFlagEvaluator({ source, logger });

      expect(flags.isEnabled('checkout-v2', false)).toBe(false);
      expect(flags.isEnabled('checkout-v2', true)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    }
  );

  it('VT-06 reads the configuration once, at construction', () => {
    const { logger, warn } = fakeLogger();
    const flags = createLocalFlagEvaluator({ source: '{not json', logger });

    flags.isEnabled('checkout-v2', false);
    flags.isEnabled('checkout-v2', true);
    flags.isEnabled('other-flag', true);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('VT-07 PBI-016 AC-3 TBI-019 DoD-3 runs a replacement adapter through the unchanged call site', () => {
    const calls: Array<[string, boolean]> = [];
    const replacement: FlagEvaluator = {
      isEnabled(name, defaultValue) {
        calls.push([name, defaultValue]);
        return name === 'checkout-v2' ? true : defaultValue;
      },
    };
    const { logger } = fakeLogger();
    const local = createLocalFlagEvaluator({
      source: '{"checkout-v2":true}',
      logger,
    });

    expect(checkoutBehavior(replacement)).toBe('new');
    expect(checkoutBehavior(local)).toBe('new');
    expect(calls).toEqual([['checkout-v2', false]]);
  });

  it('VT-11 TBI-019 NFR isEnabled returns a boolean synchronously, not a Promise', () => {
    expectTypeOf<FlagEvaluator['isEnabled']>().returns.toEqualTypeOf<boolean>();
    expectTypeOf<FlagEvaluator['isEnabled']>().parameters.toEqualTypeOf<
      [string, boolean]
    >();
    const { logger } = fakeLogger();
    const result = createLocalFlagEvaluator({
      source: '{"checkout-v2":true}',
      logger,
    }).isEnabled('checkout-v2', false);
    expect(typeof result).toBe('boolean');
  });

  it('VT-14 PBI-016 AC-1 BR-007 logs no configuration text for identity-shaped keys', () => {
    const source = '{"alice@example.test":true,"sub|subject-123":true}';
    const { logger, warn } = fakeLogger();
    createLocalFlagEvaluator({ source, logger });

    expect(warn).toHaveBeenCalledTimes(1);
    const serialised = JSON.stringify(warn.mock.calls);
    for (const fragment of ['alice', 'example.test', 'subject-123', source]) {
      expect(serialised).not.toContain(fragment);
    }
  });
});
