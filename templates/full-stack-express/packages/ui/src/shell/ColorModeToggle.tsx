import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import type { InputHTMLAttributes } from 'react';
import { useColorMode } from '../theme/useColorMode.js';

const inputProps: InputHTMLAttributes<HTMLInputElement> & {
  'data-testid': string;
} = { 'data-testid': 'app-shell-color-mode-toggle' };

/** Header switch labelled "Dark mode" that toggles light and dark. */
export const ColorModeToggle: React.FC = () => {
  const { mode, setMode } = useColorMode();
  return (
    <FormControlLabel
      label="Dark mode"
      sx={{ mr: 0 }}
      control={
        <Switch
          checked={mode === 'dark'}
          onChange={(_event, checked) => setMode(checked ? 'dark' : 'light')}
          slotProps={{ input: inputProps }}
        />
      }
    />
  );
};
