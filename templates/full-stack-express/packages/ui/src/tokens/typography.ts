/** System font stack and a rem-based type scale. No web font is downloaded. */
export interface TypographyTokens {
  fontFamily: string;
  htmlFontSize: number;
  fontSize: number;
  fontWeightRegular: number;
  fontWeightMedium: number;
  fontWeightBold: number;
  scale: {
    h1: string;
    h2: string;
    h3: string;
    h4: string;
    h5: string;
    h6: string;
    body1: string;
    body2: string;
    caption: string;
  };
}

export const typography: TypographyTokens = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
  htmlFontSize: 16,
  fontSize: 14,
  fontWeightRegular: 400,
  fontWeightMedium: 500,
  fontWeightBold: 600,
  scale: {
    h1: '2.25rem',
    h2: '1.875rem',
    h3: '1.5rem',
    h4: '1.25rem',
    h5: '1.125rem',
    h6: '1rem',
    body1: '1rem',
    body2: '0.875rem',
    caption: '0.75rem',
  },
};
