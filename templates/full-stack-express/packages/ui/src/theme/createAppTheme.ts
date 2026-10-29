import { createTheme, type Theme } from '@mui/material/styles';
import {
  mergeTokens,
  type ColorSchemeTokens,
  type TokenOverrides,
} from '../tokens/index.js';
import { components } from './components.js';

declare module '@mui/material/styles' {
  interface CssThemeVariables {
    enabled: true;
  }
  interface Palette {
    focus: string;
    inputBorder: string;
  }
  interface PaletteOptions {
    focus?: string;
    inputBorder?: string;
  }
}

function paletteFor(scheme: ColorSchemeTokens) {
  return {
    primary: { ...scheme.primary },
    secondary: { ...scheme.secondary },
    error: { ...scheme.error },
    warning: { ...scheme.warning },
    info: { ...scheme.info },
    success: { ...scheme.success },
    text: { ...scheme.text },
    background: { ...scheme.background },
    divider: scheme.divider,
    focus: scheme.focus,
    inputBorder: scheme.inputBorder,
  };
}

/**
 * Builds the MUI theme with light and dark colour schemes from the tokens.
 * CSS variables let the scheme change without a reload or a remount.
 *
 * @example
 * const theme = createAppTheme({
 *   colors: { light: { primary: { main: '#7A1FA2' } } },
 * });
 */
export function createAppTheme(overrides?: TokenOverrides): Theme {
  const merged = mergeTokens(overrides);
  const { typography } = merged;
  return createTheme({
    cssVariables: { colorSchemeSelector: 'data-mui-color-scheme' },
    colorSchemes: {
      light: { palette: paletteFor(merged.colors.light) },
      dark: { palette: paletteFor(merged.colors.dark) },
    },
    spacing: merged.spacing.base,
    breakpoints: { values: { ...merged.breakpoints } },
    typography: {
      fontFamily: typography.fontFamily,
      htmlFontSize: typography.htmlFontSize,
      fontSize: typography.fontSize,
      fontWeightRegular: typography.fontWeightRegular,
      fontWeightMedium: typography.fontWeightMedium,
      fontWeightBold: typography.fontWeightBold,
      h1: { fontSize: typography.scale.h1 },
      h2: { fontSize: typography.scale.h2 },
      h3: { fontSize: typography.scale.h3 },
      h4: { fontSize: typography.scale.h4 },
      h5: { fontSize: typography.scale.h5 },
      h6: { fontSize: typography.scale.h6 },
      body1: { fontSize: typography.scale.body1 },
      body2: { fontSize: typography.scale.body2 },
      caption: { fontSize: typography.scale.caption },
      button: { textTransform: 'none' },
    },
    components,
  });
}
