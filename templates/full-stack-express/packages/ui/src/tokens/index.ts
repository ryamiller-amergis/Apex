import { breakpoints, type BreakpointTokens } from './breakpoints.js';
import {
  colors,
  type ColorSchemeName,
  type ColorSchemeTokens,
} from './colors.js';
import { spacing, type SpacingTokens } from './spacing.js';
import { typography, type TypographyTokens } from './typography.js';

export type {
  BreakpointTokens,
  ColorSchemeName,
  ColorSchemeTokens,
  SpacingTokens,
  TypographyTokens,
};
export type { PaletteColorTokens } from './colors.js';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface Tokens {
  colors: Record<ColorSchemeName, ColorSchemeTokens>;
  spacing: SpacingTokens;
  typography: TypographyTokens;
  breakpoints: BreakpointTokens;
}

/**
 * Brand overrides. Each colour scheme merges on its own, so a light-only
 * override leaves the dark scheme at its defaults.
 *
 * @example
 * const overrides: TokenOverrides = {
 *   colors: { light: { primary: { main: '#7A1FA2' } } },
 * };
 */
export interface TokenOverrides {
  colors?: Partial<Record<ColorSchemeName, DeepPartial<ColorSchemeTokens>>>;
  typography?: DeepPartial<TypographyTokens>;
}

/** Default semantic tokens. Read-only; pass `TokenOverrides` to change them. */
export const tokens: Tokens = { colors, spacing, typography, breakpoints };

function deepMerge<T extends object>(base: T, patch: DeepPartial<T> = {}): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] =
      typeof value === 'object' &&
      value !== null &&
      typeof current === 'object' &&
      current !== null
        ? deepMerge(current, value as DeepPartial<typeof current>)
        : value;
  }
  return result as T;
}

function mergeScheme(
  base: ColorSchemeTokens,
  patch: DeepPartial<ColorSchemeTokens> = {}
): ColorSchemeTokens {
  const merged = deepMerge(base, patch);
  if (patch.focus === undefined && patch.primary?.main !== undefined) {
    merged.focus = patch.primary.main;
  }
  return merged;
}

/**
 * Returns the default tokens with `overrides` applied per colour scheme. When
 * a scheme overrides `primary.main` but not `focus`, the focus ring follows
 * the new primary colour.
 */
export function mergeTokens(overrides: TokenOverrides = {}): Tokens {
  return {
    colors: {
      light: mergeScheme(tokens.colors.light, overrides.colors?.light),
      dark: mergeScheme(tokens.colors.dark, overrides.colors?.dark),
    },
    spacing: tokens.spacing,
    typography: deepMerge(tokens.typography, overrides.typography),
    breakpoints: tokens.breakpoints,
  };
}
