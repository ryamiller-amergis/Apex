import { checkThemeContrast, formatContrastFailure } from '@project-scope/ui';
import { describe, expect, it } from 'vitest';
import overrides from './overrides';

describe('web token overrides', () => {
  it('PBI-017 AC-1 the shipped overrides keep both themes at WCAG 2.1 AA', () => {
    expect(checkThemeContrast(overrides).map(formatContrastFailure)).toEqual(
      []
    );
  });
});
