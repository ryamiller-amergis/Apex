/** A main colour and the text colour that sits on it. */
export interface PaletteColorTokens {
  main: string;
  contrastText: string;
}

/**
 * Semantic colours for one scheme. Light and dark use this one shape, so a
 * key missing from either scheme is a compile error.
 */
export interface ColorSchemeTokens {
  primary: PaletteColorTokens;
  secondary: PaletteColorTokens;
  error: PaletteColorTokens;
  warning: PaletteColorTokens;
  info: PaletteColorTokens;
  success: PaletteColorTokens;
  text: { primary: string; secondary: string };
  background: { default: string; paper: string };
  divider: string;
  focus: string;
  inputBorder: string;
}

export type ColorSchemeName = 'light' | 'dark';

export const lightColors: ColorSchemeTokens = {
  primary: { main: '#1D4ED8', contrastText: '#FFFFFF' },
  secondary: { main: '#4A5058', contrastText: '#FFFFFF' },
  error: { main: '#B3261E', contrastText: '#FFFFFF' },
  warning: { main: '#8A5300', contrastText: '#FFFFFF' },
  info: { main: '#0B5CAD', contrastText: '#FFFFFF' },
  success: { main: '#1B6E35', contrastText: '#FFFFFF' },
  text: { primary: '#1A1D21', secondary: '#4A5058' },
  background: { default: '#FFFFFF', paper: '#F5F7FA' },
  divider: '#D5D9DF',
  focus: '#1D4ED8',
  inputBorder: '#6B7280',
};

export const darkColors: ColorSchemeTokens = {
  primary: { main: '#8AB4F8', contrastText: '#0B1220' },
  secondary: { main: '#B0B6BE', contrastText: '#101418' },
  error: { main: '#F2B8B5', contrastText: '#601410' },
  warning: { main: '#F5C26B', contrastText: '#2B1D00' },
  info: { main: '#7CC4FA', contrastText: '#0B1220' },
  success: { main: '#8BD3A0', contrastText: '#0B2A14' },
  text: { primary: '#E8EAED', secondary: '#B0B6BE' },
  background: { default: '#101418', paper: '#181D23' },
  divider: '#353C45',
  focus: '#8AB4F8',
  inputBorder: '#8A929C',
};

export const colors: Record<ColorSchemeName, ColorSchemeTokens> = {
  light: lightColors,
  dark: darkColors,
};
