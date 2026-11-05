import { useColorScheme } from '@mui/material/styles';
import { useCallback } from 'react';

export type ColorMode = 'light' | 'dark';

export interface UseColorModeResult {
  /** The scheme in effect, with `system` resolved to light or dark. */
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
}

/**
 * Reads and sets the colour mode. Must render inside `AppThemeProvider`.
 *
 * @example
 * const { mode, setMode } = useColorMode();
 * setMode(mode === 'dark' ? 'light' : 'dark');
 */
export function useColorMode(): UseColorModeResult {
  const { mode, systemMode, setMode: setSchemeMode } = useColorScheme();
  const resolved = (mode === 'system' ? systemMode : mode) ?? 'light';
  const setMode = useCallback(
    (next: ColorMode) => setSchemeMode(next),
    [setSchemeMode]
  );
  return { mode: resolved, setMode };
}
