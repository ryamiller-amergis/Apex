import type { Components, Theme } from '@mui/material/styles';

type ThemeArg = { theme: Omit<Theme, 'components'> };

function palette(theme: Omit<Theme, 'components'>) {
  return theme.vars.palette;
}

function focusRing(theme: Omit<Theme, 'components'>) {
  return {
    outline: `2px solid ${palette(theme).focus}`,
    outlineOffset: '2px',
  };
}

/** Component defaults. Every colour reads from the theme palette. */
export const components: Components<Omit<Theme, 'components'>> = {
  MuiCssBaseline: {
    styleOverrides: (theme) => ({
      ':focus-visible': focusRing(theme),
      '@media (prefers-reduced-motion: reduce)': {
        '*, *::before, *::after': {
          animationDuration: '0.01ms !important',
          animationIterationCount: '1 !important',
          transitionDuration: '0.01ms !important',
          scrollBehavior: 'auto !important',
        },
      },
    }),
  },
  MuiButtonBase: {
    styleOverrides: {
      root: ({ theme }: ThemeArg) => ({
        '&:focus-visible, &.Mui-focusVisible': focusRing(theme),
      }),
    },
  },
  MuiButton: {
    defaultProps: { disableElevation: true },
  },
  MuiLink: {
    defaultProps: { underline: 'always' },
    styleOverrides: {
      root: ({ theme }: ThemeArg) => ({
        color: palette(theme).primary.main,
        '&:focus-visible': focusRing(theme),
      }),
    },
  },
  MuiTextField: {
    defaultProps: { variant: 'outlined', fullWidth: true },
  },
  MuiOutlinedInput: {
    styleOverrides: {
      notchedOutline: ({ theme }: ThemeArg) => ({
        borderColor: palette(theme).inputBorder,
      }),
    },
  },
};
