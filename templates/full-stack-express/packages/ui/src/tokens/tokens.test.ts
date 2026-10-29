import { describe, expect, it } from 'vitest';
import { mergeTokens, tokens } from './index.js';

function flatKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'object' && child !== null
      ? flatKeys(child, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

describe('tokens', () => {
  it('VT-01 TBI-020 DoD-0 exposes non-empty colour, spacing, typography, and breakpoint groups', () => {
    expect(Object.keys(tokens.colors.light).length).toBeGreaterThan(0);
    expect(Object.keys(tokens.spacing.steps).length).toBeGreaterThan(0);
    expect(tokens.spacing.base).toBe(8);
    expect(tokens.typography.fontFamily).toContain('Segoe UI');
    expect(tokens.breakpoints).toEqual({
      xs: 0,
      sm: 600,
      md: 900,
      lg: 1200,
      xl: 1536,
    });
  });

  it('VT-01 maps the named spacing steps to 4, 8, 12, 16, 24, and 32 px', () => {
    expect(Object.values(tokens.spacing.steps)).toEqual([4, 8, 12, 16, 24, 32]);
  });

  it('VT-02 TBI-020 DoD-1 light and dark schemes share one key set', () => {
    expect(flatKeys(tokens.colors.dark)).toEqual(flatKeys(tokens.colors.light));
    expect(flatKeys(tokens.colors.light)).toEqual(
      expect.arrayContaining([
        'primary.main',
        'primary.contrastText',
        'secondary.main',
        'error.main',
        'warning.main',
        'info.main',
        'success.main',
        'text.primary',
        'text.secondary',
        'background.default',
        'background.paper',
        'divider',
        'focus',
        'inputBorder',
      ])
    );
  });

  it('PBI-017 AC-2 merges a light-only override without touching dark', () => {
    const merged = mergeTokens({
      colors: { light: { primary: { main: '#7A1FA2' } } },
    });
    expect(merged.colors.light.primary.main).toBe('#7A1FA2');
    expect(merged.colors.light.primary.contrastText).toBe(
      tokens.colors.light.primary.contrastText
    );
    expect(merged.colors.dark).toEqual(tokens.colors.dark);
  });

  it('does not mutate the default tokens when merging', () => {
    const before = tokens.colors.light.primary.main;
    mergeTokens({ colors: { light: { primary: { main: '#000000' } } } });
    expect(tokens.colors.light.primary.main).toBe(before);
  });
});
