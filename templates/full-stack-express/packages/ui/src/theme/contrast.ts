import { getContrastRatio } from '@mui/material/styles';
import {
  mergeTokens,
  type ColorSchemeName,
  type ColorSchemeTokens,
  type TokenOverrides,
} from '../tokens/index.js';

type PaletteKey =
  'primary' | 'secondary' | 'error' | 'warning' | 'info' | 'success';

/** A dotted path to one colour token, such as `text.primary`. */
export type ColorTokenPath =
  | `${PaletteKey}.main`
  | `${PaletteKey}.contrastText`
  | 'text.primary'
  | 'text.secondary'
  | 'background.default'
  | 'background.paper'
  | 'divider'
  | 'focus'
  | 'inputBorder';

export interface ContrastPairing {
  foreground: ColorTokenPath;
  background: ColorTokenPath;
  /** WCAG 2.1 AA minimum: 4.5 for text, 3 for focus rings and borders. */
  required: number;
}

export interface ContrastFailure {
  scheme: ColorSchemeName;
  foreground: ColorTokenPath;
  background: ColorTokenPath;
  /** `null` when either value cannot be parsed as an opaque colour. */
  ratio: number | null;
  required: number;
}

const TEXT = 4.5;
const NON_TEXT = 3;
const SURFACES: ColorTokenPath[] = ['background.default', 'background.paper'];
const PALETTE_KEYS: PaletteKey[] = [
  'primary',
  'secondary',
  'error',
  'warning',
  'info',
  'success',
];

/** Pairings checked in both colour schemes. */
export const CONTRAST_PAIRINGS: readonly ContrastPairing[] = [
  ...SURFACES.flatMap((background) => [
    { foreground: 'text.primary' as const, background, required: TEXT },
    { foreground: 'text.secondary' as const, background, required: TEXT },
    { foreground: 'primary.main' as const, background, required: TEXT },
    { foreground: 'focus' as const, background, required: NON_TEXT },
  ]),
  ...PALETTE_KEYS.map((key) => ({
    foreground: `${key}.contrastText` as const,
    background: `${key}.main` as const,
    required: TEXT,
  })),
  {
    foreground: 'inputBorder',
    background: 'background.paper',
    required: NON_TEXT,
  },
];

function readToken(scheme: ColorSchemeTokens, token: ColorTokenPath): string {
  const [group, key] = token.split('.') as [keyof ColorSchemeTokens, string?];
  const value = scheme[group];
  if (typeof value === 'string') {
    return value;
  }
  return (value as unknown as Record<string, string>)[key ?? ''] ?? '';
}

function ratioOf(foreground: string, background: string): number | null {
  try {
    const ratio = getContrastRatio(foreground, background);
    return Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null;
  } catch {
    return null;
  }
}

/**
 * Checks every pairing in `CONTRAST_PAIRINGS` for light and dark with the
 * overrides applied. Returns one entry per failing pairing; an empty array
 * means both themes meet WCAG 2.1 AA.
 *
 * @example
 * const failures = checkThemeContrast(overrides);
 * // [{ scheme: 'dark', foreground: 'text.secondary',
 * //    background: 'background.paper', ratio: 2.36, required: 4.5 }]
 */
export function checkThemeContrast(
  overrides?: TokenOverrides
): ContrastFailure[] {
  const merged = mergeTokens(overrides);
  const schemes: ColorSchemeName[] = ['light', 'dark'];
  return schemes.flatMap((scheme) =>
    CONTRAST_PAIRINGS.flatMap((pair) => {
      const colors = merged.colors[scheme];
      const ratio = ratioOf(
        readToken(colors, pair.foreground),
        readToken(colors, pair.background)
      );
      if (ratio !== null && ratio >= pair.required) {
        return [];
      }
      return [{ scheme, ...pair, ratio }];
    })
  );
}

/** One line per failure, for example `dark: text.secondary on background.paper = 2.36, needs 4.5`. */
export function formatContrastFailure(failure: ContrastFailure): string {
  const ratio = failure.ratio === null ? 'unparseable' : String(failure.ratio);
  return `${failure.scheme}: ${failure.foreground} on ${failure.background} = ${ratio}, needs ${failure.required}`;
}
