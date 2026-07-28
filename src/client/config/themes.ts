export type ThemeMode = 'light' | 'dark' | 'amergis' | 'midnight' | 'dusk' | 'aurora';

export interface ThemeOption {
  value: ThemeMode;
  label: string;
  description: string;
  /** CSS background for the picker preview strip */
  preview: string;
  /** Accent chips shown on the preview (bg → surface → accent) */
  accents: [string, string, string];
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'light',
    label: 'Light',
    description: 'Soft slate',
    preview: 'linear-gradient(135deg, #E4EAF4 0%, #C8D2E4 100%)',
    accents: ['#E4EAF4', '#D5DDEC', '#2747D9'],
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Near black',
    preview: 'linear-gradient(135deg, #050506 0%, #18181B 100%)',
    accents: ['#050506', '#18181B', '#7C8CFF'],
  },
  {
    value: 'amergis',
    label: 'Amergis',
    description: 'Mint charcoal',
    preview: 'linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%)',
    accents: ['#1e1e1e', '#3d3d3d', '#5ACCA6'],
  },
  {
    value: 'midnight',
    label: 'Midnight',
    description: 'Indigo wash',
    preview: 'linear-gradient(135deg, #080C18 0%, #1A1235 100%)',
    accents: ['#0B1020', '#1E2640', '#9BA8FF'],
  },
  {
    value: 'dusk',
    label: 'Dusk',
    description: 'Warm plum',
    preview: 'linear-gradient(135deg, #100C14 0%, #241820 100%)',
    accents: ['#14101A', '#2A2230', '#E8A87C'],
  },
  {
    value: 'aurora',
    label: 'Aurora',
    description: 'Purple & orange',
    preview: 'linear-gradient(135deg, #140A1C 0%, #3B1A4A 45%, #7C2D12 100%)',
    accents: ['#7C3AED', '#E879F9', '#FB923C'],
  },
];

export const THEME_CYCLE: ThemeMode[] = THEME_OPTIONS.map((option) => option.value);

export const isThemeMode = (value: string | null): value is ThemeMode => (
  THEME_OPTIONS.some((option) => option.value === value)
);
