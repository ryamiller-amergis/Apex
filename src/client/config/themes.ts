export type ThemeMode =
  | 'light'
  | 'dark'
  | 'amergis'
  | 'slate'
  | 'ocean'
  | 'pearl'
  | 'midnight'
  | 'dusk'
  | 'aurora'
  | 'glacier'
  | 'ember'
  | 'haze'
  | 'neon'
  | 'volt'
  | 'plasma'
  | 'pink'
  | 'ice'
  | 'flare';

export type ThemeCategory = 'classic' | 'atmosphere' | 'neon';

export interface ThemeCategoryOption {
  value: ThemeCategory;
  label: string;
  description: string;
}

export interface ThemeOption {
  value: ThemeMode;
  label: string;
  description: string;
  category: ThemeCategory;
  /** CSS background for the picker preview strip */
  preview: string;
  /** Accent chips shown on the preview (bg → surface → accent) */
  accents: [string, string, string];
}

export const THEME_CATEGORIES: ThemeCategoryOption[] = [
  {
    value: 'classic',
    label: 'Classic',
    description: 'Flat everyday palettes',
  },
  {
    value: 'atmosphere',
    label: 'Atmosphere',
    description: 'Soft cinematic washes',
  },
  {
    value: 'neon',
    label: 'Neon',
    description: 'Fluorescent cyber glow',
  },
];

export const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'light',
    label: 'Light',
    description: 'Cool soft blue',
    category: 'classic',
    preview: 'linear-gradient(135deg, #E4EAF4 0%, #C8D2E4 100%)',
    accents: ['#E4EAF4', '#D5DDEC', '#2747D9'],
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Near-black zinc',
    category: 'classic',
    preview: 'linear-gradient(135deg, #050506 0%, #18181B 100%)',
    accents: ['#050506', '#18181B', '#7C8CFF'],
  },
  {
    value: 'amergis',
    label: 'Amergis',
    description: 'Mint on charcoal',
    category: 'classic',
    preview: 'linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%)',
    accents: ['#1e1e1e', '#3d3d3d', '#5ACCA6'],
  },
  {
    value: 'slate',
    label: 'Slate',
    description: 'Warm steel copper',
    category: 'classic',
    preview: 'linear-gradient(135deg, #2A2E36 0%, #3A404C 100%)',
    accents: ['#2A2E36', '#4A5160', '#D4A574'],
  },
  {
    value: 'ocean',
    label: 'Ocean',
    description: 'Sea teal',
    category: 'classic',
    preview: 'linear-gradient(135deg, #0A1F1C 0%, #134E4A 100%)',
    accents: ['#0A1F1C', '#115E59', '#2DD4BF'],
  },
  {
    value: 'pearl',
    label: 'Pearl',
    description: 'Warm ivory',
    category: 'classic',
    preview: 'linear-gradient(135deg, #F4F0EA 0%, #E6DFD4 100%)',
    accents: ['#F4F0EA', '#E6DFD4', '#C45C26'],
  },
  {
    value: 'midnight',
    label: 'Midnight',
    description: 'Deep indigo night',
    category: 'atmosphere',
    preview: 'linear-gradient(135deg, #080C18 0%, #1A1235 100%)',
    accents: ['#0B1020', '#1E2640', '#8B95D9'],
  },
  {
    value: 'dusk',
    label: 'Dusk',
    description: 'Plum & peach hour',
    category: 'atmosphere',
    preview: 'linear-gradient(135deg, #100C14 0%, #241820 100%)',
    accents: ['#14101A', '#2A2230', '#E8A87C'],
  },
  {
    value: 'aurora',
    label: 'Aurora',
    description: 'Soft orchid sky',
    category: 'atmosphere',
    preview: 'linear-gradient(135deg, #1A1224 0%, #2E1A38 50%, #3A2430 100%)',
    accents: ['#1A1224', '#B89BC8', '#D4A574'],
  },
  {
    value: 'glacier',
    label: 'Glacier',
    description: 'Muted fog blue',
    category: 'atmosphere',
    preview: 'linear-gradient(135deg, #10161C 0%, #1C2830 55%, #243038 100%)',
    accents: ['#10161C', '#2A3840', '#9BB0BC'],
  },
  {
    value: 'ember',
    label: 'Ember',
    description: 'Wine & copper',
    category: 'atmosphere',
    preview: 'linear-gradient(135deg, #1A0E10 0%, #2A1818 50%, #3A2018 100%)',
    accents: ['#1A0E10', '#3A2420', '#C47A5A'],
  },
  {
    value: 'haze',
    label: 'Haze',
    description: 'Sage mist',
    category: 'atmosphere',
    preview: 'linear-gradient(135deg, #121612 0%, #1C221C 50%, #283028 100%)',
    accents: ['#121612', '#2A3228', '#A8B89A'],
  },
  {
    value: 'neon',
    label: 'Neon',
    description: 'Electric cyan',
    category: 'neon',
    preview: 'linear-gradient(135deg, #000000 0%, #001018 100%)',
    accents: ['#000000', '#003040', '#00F0FF'],
  },
  {
    value: 'volt',
    label: 'Volt',
    description: 'Acid chartreuse',
    category: 'neon',
    preview: 'linear-gradient(135deg, #000000 0%, #0A1800 100%)',
    accents: ['#000000', '#1A3000', '#C8FF00'],
  },
  {
    value: 'plasma',
    label: 'Plasma',
    description: 'Electric violet',
    category: 'neon',
    preview: 'linear-gradient(135deg, #000000 0%, #120028 100%)',
    accents: ['#000000', '#2A0850', '#B24BFF'],
  },
  {
    value: 'pink',
    label: 'Pink',
    description: 'Candy hot pink',
    category: 'neon',
    preview: 'linear-gradient(135deg, #000000 0%, #280018 100%)',
    accents: ['#000000', '#400028', '#FF2D95'],
  },
  {
    value: 'ice',
    label: 'Aurora',
    description: 'Spring green',
    category: 'neon',
    preview: 'linear-gradient(135deg, #000000 0%, #0A1E14 100%)',
    accents: ['#000000', '#06301E', '#00FF85'],
  },
  {
    value: 'flare',
    label: 'Flare',
    description: 'Toxic orange',
    category: 'neon',
    preview: 'linear-gradient(135deg, #000000 0%, #1A0800 100%)',
    accents: ['#000000', '#3A1400', '#FF5C00'],
  },
];

export const THEME_CYCLE: ThemeMode[] = THEME_OPTIONS.map((option) => option.value);

export const isThemeMode = (value: string | null): value is ThemeMode => (
  THEME_OPTIONS.some((option) => option.value === value)
);

export const getThemeOption = (value: ThemeMode): ThemeOption | undefined => (
  THEME_OPTIONS.find((option) => option.value === value)
);

export const getThemesByCategory = (category: ThemeCategory): ThemeOption[] => (
  THEME_OPTIONS.filter((option) => option.category === category)
);
