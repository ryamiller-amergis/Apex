import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { useMemo, type ReactNode } from 'react';
import type { TokenOverrides } from '../tokens/index.js';
import { createAppTheme } from './createAppTheme.js';

/** `localStorage` key that holds the chosen colour mode. */
export const COLOR_MODE_STORAGE_KEY = 'app-color-mode';

export interface AppThemeProviderProps {
  /** Brand token overrides. Keep the object stable to avoid rebuilding. */
  overrides?: TokenOverrides;
  children: ReactNode;
}

/**
 * Applies the light and dark themes and the baseline styles. The first visit
 * follows the operating system setting; a chosen mode is stored under
 * `app-color-mode` and restored on the next visit.
 *
 * @example
 * <AppThemeProvider overrides={overrides}>
 *   <App />
 * </AppThemeProvider>
 */
export const AppThemeProvider: React.FC<AppThemeProviderProps> = ({
  overrides,
  children,
}) => {
  const theme = useMemo(() => createAppTheme(overrides), [overrides]);
  return (
    <ThemeProvider
      theme={theme}
      defaultMode="system"
      modeStorageKey={COLOR_MODE_STORAGE_KEY}
      noSsr
    >
      <CssBaseline enableColorScheme />
      {children}
    </ThemeProvider>
  );
};
