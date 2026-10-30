import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { resolvedStyle } from '../testing/resolvedStyle.js';
import { tokens, type TokenOverrides } from '../tokens/index.js';
import { AppThemeProvider } from './AppThemeProvider.js';
import { checkThemeContrast } from './contrast.js';
import { createAppTheme } from './createAppTheme.js';
import { useColorMode } from './useColorMode.js';

const brand = '#7A1FA2';
const brandOverrides: TokenOverrides = {
  colors: { light: { primary: { main: brand } } },
};

function cssText(): string {
  return Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n');
}

describe('createAppTheme', () => {
  it('TBI-020 DoD-1 builds light and dark schemes from the token set', () => {
    const theme = createAppTheme();
    expect(theme.colorSchemes.light?.palette.primary.main).toBe(
      tokens.colors.light.primary.main
    );
    expect(theme.colorSchemes.dark?.palette.primary.main).toBe(
      tokens.colors.dark.primary.main
    );
    expect(theme.colorSchemes.dark?.palette.mode).toBe('dark');
    expect(theme.typography.button.textTransform).toBe('none');
    expect(theme.breakpoints.values.md).toBe(900);
  });

  it('VT-03 TBI-020 DoD-2 a primary override changes the theme and the focus colour', () => {
    const theme = createAppTheme(brandOverrides);
    expect(theme.colorSchemes.light?.palette.primary.main).toBe(brand);
    expect(theme.colorSchemes.light?.palette.focus).toBe(brand);
  });

  it('VT-06 PBI-017 AC-2 a light-only override leaves dark at its defaults', () => {
    const theme = createAppTheme({
      colors: {
        light: {
          primary: { main: brand },
          text: { primary: '#000000' },
          background: { paper: '#FFFFFF' },
        },
      },
    });
    const dark = theme.colorSchemes.dark?.palette;
    const defaults = tokens.colors.dark;
    expect(dark?.primary.main).toBe(defaults.primary.main);
    expect(dark?.text.primary).toBe(defaults.text.primary);
    expect(dark?.background.paper).toBe(defaults.background.paper);
    expect(dark?.focus).toBe(defaults.focus);
    expect(
      checkThemeContrast({
        colors: { light: { primary: { main: brand } } },
      }).filter((failure) => failure.scheme === 'dark')
    ).toEqual([]);
  });
});

describe('AppThemeProvider', () => {
  it('VT-03 PBI-017 AC-0 button, link, and focus indicator render the overridden primary colour', () => {
    render(
      <AppThemeProvider overrides={brandOverrides}>
        <Button variant="contained">Save</Button>
        <Link href="/profile">Profile</Link>
      </AppThemeProvider>
    );
    const button = screen.getByRole('button', { name: 'Save' });
    const link = screen.getByRole('link', { name: 'Profile' });

    expect(resolvedStyle(button, 'background-color').toUpperCase()).toBe(brand);
    expect(resolvedStyle(link, 'color').toUpperCase()).toBe(brand);
    expect(resolvedStyle(document.documentElement, '--mui-palette-focus')).toBe(
      brand
    );
    expect(cssText()).toMatch(
      /:focus-visible[^}]*outline:\s*2px solid var\(--mui-palette-focus\)/
    );
  });

  it('PBI-017 links do not rely on colour alone', () => {
    render(
      <AppThemeProvider>
        <Link href="/profile">Profile</Link>
      </AppThemeProvider>
    );
    expect(
      resolvedStyle(screen.getByRole('link'), 'text-decoration')
    ).toContain('underline');
  });

  it('PBI-018 NFR turns transitions off when the system requests reduced motion', () => {
    render(
      <AppThemeProvider>
        <span>content</span>
      </AppThemeProvider>
    );
    expect(cssText()).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});

const ModeProbe: React.FC = () => {
  const { mode, setMode } = useColorMode();
  return (
    <button
      type="button"
      onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
    >
      {mode}
    </button>
  );
};

describe('useColorMode', () => {
  it('VT-08 TBI-020 follows the system setting first, then stores the choice', async () => {
    const { unmount } = render(
      <AppThemeProvider>
        <ModeProbe />
      </AppThemeProvider>
    );
    const probe = screen.getByRole('button');
    expect(probe).toHaveTextContent('light');

    await act(async () => {
      probe.click();
    });

    expect(probe).toHaveTextContent('dark');
    expect(document.documentElement).toHaveAttribute(
      'data-mui-color-scheme',
      'dark'
    );
    expect(window.localStorage.getItem('app-color-mode')).toBe('dark');

    unmount();
    render(
      <AppThemeProvider>
        <ModeProbe />
      </AppThemeProvider>
    );
    expect(screen.getByRole('button')).toHaveTextContent('dark');
  });
});
