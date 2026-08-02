/**
 * TBI-002 — normalizeOpenerAnchorKeys / validateOpenerAnchorKeys
 */
import {
  normalizeOpenerAnchorKeys,
  validateOpenerAnchorKeys,
  type WalkthroughAnchorRegistryValidationError,
} from '../../shared/types/walkthroughAnchorRegistry';

describe('openerAnchorKeys validation (TBI-002)', () => {
  it('DoD-0: normalizeOpenerAnchorKeys trims, dedupes, preserves order', () => {
    expect(
      normalizeOpenerAnchorKeys(['  a ', 'b', 'a', '', 'c']),
    ).toEqual(['a', 'b', 'c']);
  });

  it('DoD-1: rejects self-reference', () => {
    const errors = validateOpenerAnchorKeys({
      anchorKey: 'whats-new-modal',
      openerAnchorKeys: ['whats-new-modal'],
      runtimeEligibleKeys: new Set(['whats-new-modal', 'user-menu-trigger']),
      openerGraph: new Map([['whats-new-modal', ['whats-new-modal']]]),
    });
    expect(
      errors.some((e: WalkthroughAnchorRegistryValidationError) => e.code === 'OPENER_SELF_REFERENCE'),
    ).toBe(true);
  });

  it('DoD-2: rejects non-approved+active keys', () => {
    const errors = validateOpenerAnchorKeys({
      anchorKey: 'whats-new-modal',
      openerAnchorKeys: ['pending-only'],
      runtimeEligibleKeys: new Set(['user-menu-trigger']),
      openerGraph: new Map([['whats-new-modal', ['pending-only']]]),
    });
    expect(
      errors.some((e: WalkthroughAnchorRegistryValidationError) => e.code === 'OPENER_NOT_ELIGIBLE'),
    ).toBe(true);
  });

  it('DoD-3: rejects cycles', () => {
    const errors = validateOpenerAnchorKeys({
      anchorKey: 'a',
      openerAnchorKeys: ['b'],
      runtimeEligibleKeys: new Set(['a', 'b']),
      openerGraph: new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    });
    expect(
      errors.some((e: WalkthroughAnchorRegistryValidationError) => e.code === 'OPENER_CYCLE'),
    ).toBe(true);
  });

  it('accepts a valid single opener', () => {
    const errors = validateOpenerAnchorKeys({
      anchorKey: 'whats-new-modal',
      openerAnchorKeys: ['user-menu-trigger'],
      runtimeEligibleKeys: new Set(['whats-new-modal', 'user-menu-trigger']),
      openerGraph: new Map([
        ['whats-new-modal', ['user-menu-trigger']],
        ['user-menu-trigger', []],
      ]),
    });
    expect(errors).toEqual([]);
  });
});
