import { describe, expect, it } from 'vitest';
import { TEST_ID_PATTERN, testId } from './testId.js';

describe('testId', () => {
  it('VT-15 TBI-021 DoD-3 lower-cases and joins parts with hyphens', () => {
    expect(testId('app-shell', 'nav-item', 'Profile')).toBe(
      'app-shell-nav-item-profile'
    );
    expect(testId('loading-state')).toBe('loading-state');
  });

  it('VT-15 rejects output that is not kebab-case', () => {
    expect(() => testId('app-shell', 'Bad Value!')).toThrow(/not kebab-case/);
    expect(() => testId('')).toThrow(/not kebab-case/);
  });

  it('VT-15 exposes the convention pattern', () => {
    expect(TEST_ID_PATTERN.test('app-shell-main')).toBe(true);
    expect(TEST_ID_PATTERN.test('App-Shell')).toBe(false);
  });
});
